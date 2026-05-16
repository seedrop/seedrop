import type { Passport } from "./schema.js";
import type { Channel, Message, RecordedMessage, SessionSlots } from "./types.js";
import { seedSlots } from "./slots.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  type Classifier,
  type ClassifierKind,
  type LLMConfig,
  HybridClassifier,
  LLMClassifier,
  RuleClassifier,
} from "./classifier.js";
import { IdentityConfigError } from "./errors.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { cosineDistance, cosineSimilarity, meanVector } from "./vectors.js";

export interface RecordOptions {
  /** Explicit channel override. If omitted, the configured classifier decides. */
  channel?: Channel;
}

export interface HarvestOptions {
  /** Cosine-similarity threshold above which a boundary message is promoted to commitments. Default 0.85. */
  threshold?: number;
}

export interface HarvestResult {
  /** Messages promoted from `boundary` to `commitments` in this cycle, in history order. */
  promoted: RecordedMessage[];
  /** Number of boundary messages considered. */
  scanned: number;
  /** `promoted.length / scanned` (0 when nothing was scanned). */
  precision: number;
}

export type Router = (msg: Message) => Channel;

export interface SessionOptions {
  /** Default routing rule when neither override nor classifier produces a channel. */
  router?: Router;
  /** Which classifier strategy to use. Defaults to "rule". */
  classifier?: ClassifierKind;
  /** Required when `classifier` is "llm" or "hybrid". */
  llm?: LLMConfig;
  /** Required to call `session.coherence()`. */
  embeddings?: EmbeddingProvider;
}

const defaultRouter: Router = () => "commitments";

function buildClassifier(
  kind: ClassifierKind,
  router: Router,
  slots: SessionSlots,
  llm: LLMConfig | undefined,
): Classifier {
  if (kind === "rule") return new RuleClassifier(router);
  if (!llm) {
    throw new IdentityConfigError(
      `classifier: "${kind}" requires an \`llm\` config on session options`,
    );
  }
  const llmClassifier = new LLMClassifier(llm, slots, router);
  if (kind === "llm") return llmClassifier;
  return new HybridClassifier(new RuleClassifier(router), llmClassifier);
}

export class Session {
  readonly slots: Readonly<SessionSlots>;
  private readonly systemPromptText: string;
  private readonly router: Router;
  private readonly classifier: Classifier;
  private readonly embeddings?: EmbeddingProvider;
  private readonly _history: RecordedMessage[] = [];

  private cachedIdentityVec: number[] | null = null;
  private readonly messageVecCache = new Map<number, number[]>();

  constructor(passport: Passport, options: SessionOptions = {}) {
    this.slots = seedSlots(passport);
    this.systemPromptText = buildSystemPrompt(this.slots);
    this.router = options.router ?? defaultRouter;
    this.classifier = buildClassifier(
      options.classifier ?? "rule",
      this.router,
      this.slots,
      options.llm,
    );
    this.embeddings = options.embeddings;
  }

  get history(): readonly RecordedMessage[] {
    return this._history;
  }

  get systemPrompt(): string {
    return this.systemPromptText;
  }

  async record(message: Message, options: RecordOptions = {}): Promise<RecordedMessage> {
    const channel = options.channel ?? (await this.classifier.classify(message));
    const recorded: RecordedMessage = {
      role: message.role,
      content: message.content,
      channel,
      index: this._history.length,
    };
    this._history.push(recorded);
    return recorded;
  }

  reconstruct(): Message[] {
    const messages: Message[] = [{ role: "system", content: this.systemPromptText }];
    for (const m of this._history) {
      if (m.channel === "commitments") {
        messages.push({ role: m.role, content: m.content });
      }
    }
    return messages;
  }

  /**
   * Drift of the working-memory centroid from the passport identity vector,
   * as cosine distance in embedding space. Zero when no commitment-channel
   * messages have been recorded yet.
   */
  async coherence(): Promise<number> {
    if (!this.embeddings) {
      throw new IdentityConfigError(
        "session.coherence() requires an `embeddings` provider on session options",
      );
    }

    if (this.cachedIdentityVec === null) {
      const result = await this.embeddings.embed([this.systemPromptText]);
      const vec = result[0];
      if (!vec) {
        throw new Error("embeddings provider returned no vector for the identity prompt");
      }
      this.cachedIdentityVec = vec;
    }

    const commitmentMessages = this._history.filter((m) => m.channel === "commitments");
    if (commitmentMessages.length === 0) return 0;

    const toEmbed: Array<{ index: number; content: string }> = [];
    for (const m of commitmentMessages) {
      if (!this.messageVecCache.has(m.index)) {
        toEmbed.push({ index: m.index, content: m.content });
      }
    }
    if (toEmbed.length > 0) {
      const vecs = await this.embeddings.embed(toEmbed.map((t) => t.content));
      if (vecs.length !== toEmbed.length) {
        throw new Error(
          `embeddings provider returned ${vecs.length} vectors for ${toEmbed.length} inputs`,
        );
      }
      for (let i = 0; i < toEmbed.length; i++) {
        this.messageVecCache.set(toEmbed[i]!.index, vecs[i]!);
      }
    }

    const vectors: number[][] = [];
    for (const m of commitmentMessages) {
      const v = this.messageVecCache.get(m.index);
      if (v) vectors.push(v);
    }
    const centroid = meanVector(vectors);
    return cosineDistance(this.cachedIdentityVec, centroid);
  }

  /**
   * Scan boundary-channel messages and promote any whose embedding is
   * sufficiently similar to the passport identity vector. Promoted messages
   * are re-channelled to `commitments` in place (their `index` stays stable)
   * and flagged with `recovered: true`.
   */
  async harvest(options: HarvestOptions = {}): Promise<HarvestResult> {
    if (!this.embeddings) {
      throw new IdentityConfigError(
        "session.harvest() requires an `embeddings` provider on session options",
      );
    }
    const threshold = options.threshold ?? 0.85;

    if (this.cachedIdentityVec === null) {
      const result = await this.embeddings.embed([this.systemPromptText]);
      const vec = result[0];
      if (!vec) {
        throw new Error("embeddings provider returned no vector for the identity prompt");
      }
      this.cachedIdentityVec = vec;
    }

    const candidates = this._history.filter((m) => m.channel === "boundary");
    if (candidates.length === 0) return { promoted: [], scanned: 0, precision: 0 };

    const toEmbed: Array<{ index: number; content: string }> = [];
    for (const m of candidates) {
      if (!this.messageVecCache.has(m.index)) {
        toEmbed.push({ index: m.index, content: m.content });
      }
    }
    if (toEmbed.length > 0) {
      const vecs = await this.embeddings.embed(toEmbed.map((t) => t.content));
      if (vecs.length !== toEmbed.length) {
        throw new Error(
          `embeddings provider returned ${vecs.length} vectors for ${toEmbed.length} inputs`,
        );
      }
      for (let i = 0; i < toEmbed.length; i++) {
        this.messageVecCache.set(toEmbed[i]!.index, vecs[i]!);
      }
    }

    const promoted: RecordedMessage[] = [];
    for (const m of candidates) {
      const v = this.messageVecCache.get(m.index)!;
      const sim = cosineSimilarity(this.cachedIdentityVec, v);
      if (sim >= threshold) {
        const stored = this._history[m.index]!;
        stored.channel = "commitments";
        stored.recovered = true;
        promoted.push(stored);
      }
    }

    return {
      promoted,
      scanned: candidates.length,
      precision: promoted.length / candidates.length,
    };
  }
}
