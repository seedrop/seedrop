import { randomUUID } from "node:crypto";
import { SpaceNotFoundError, SpaceValidationError } from "./errors.js";
import { SpaceStore, type SpaceStoreOptions } from "./io.js";
import type { Message, MessageRole, SpaceMember, SpaceMeta } from "./schema.js";

export interface SpaceOptions extends SpaceStoreOptions {
  passportId: string;
  now?: () => Date;
}

export interface SpacePostInput {
  content: string;
  authorPassportId?: string;
  /**
   * Chain of principals from the immediate author back to the root operator (or autonomous root).
   * Resolved by the caller (typically the HTTP handler) from passport state.
   */
  principalChain?: string[];
  authorAutonomous?: boolean;
  role?: MessageRole;
  replaces?: string;
  tombstone?: boolean;
  metadata?: Record<string, unknown>;
}

export class Space {
  readonly store: SpaceStore;
  readonly passportId: string;

  private readonly now: () => Date;
  private currentMeta: SpaceMeta;

  private constructor(meta: SpaceMeta, store: SpaceStore, passportId: string, now: () => Date) {
    this.currentMeta = meta;
    this.store = store;
    this.passportId = passportId;
    this.now = now;
  }

  get meta(): SpaceMeta {
    return this.currentMeta;
  }

  static async open(name: string, options: SpaceOptions): Promise<Space> {
    const opened = await openOrJoin(name, options);
    return new Space(opened.meta, opened.store, options.passportId, opened.now);
  }

  static async join(name: string, options: SpaceOptions): Promise<Space> {
    const joined = await openOrJoin(name, options);
    return new Space(joined.meta, joined.store, options.passportId, joined.now);
  }

  static async list(options: SpaceStoreOptions = {}): Promise<SpaceMeta[]> {
    return SpaceStore.open(options).listSpaceMetas();
  }

  static async load(idOrName: string, options: SpaceOptions): Promise<Space> {
    const store = SpaceStore.open(options);
    const meta = await findSpace(store, idOrName);
    if (!meta) {
      throw new SpaceNotFoundError(idOrName);
    }
    return new Space(meta, store, options.passportId, options.now ?? (() => new Date()));
  }

  async post(input: SpacePostInput): Promise<Message> {
    const message: Message = {
      schema_version: "1.0",
      id: randomUUID(),
      space_id: this.currentMeta.id,
      author_passport_id: input.authorPassportId ?? this.passportId,
      role: input.role ?? "agent",
      created_at: this.now().toISOString(),
      content: input.content,
      ...(input.principalChain && input.principalChain.length > 0 ? { principal_chain: input.principalChain } : {}),
      ...(input.authorAutonomous ? { author_autonomous: true } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
      ...(input.tombstone !== undefined ? { tombstone: input.tombstone } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    await this.store.appendMessage(message);
    return message;
  }

  async messages(): Promise<Message[]> {
    return this.store.readMessages(this.currentMeta.id);
  }

  members(): SpaceMember[] {
    return [...this.currentMeta.members];
  }

  async leave(passportId = this.passportId): Promise<void> {
    const leftAt = this.now().toISOString();
    this.currentMeta = {
      ...this.currentMeta,
      members: this.currentMeta.members.map((member) =>
        member.passport_id === passportId && !member.left_at ? { ...member, left_at: leftAt } : member,
      ),
    };
    await this.store.writeSpaceMeta(this.currentMeta);
  }

  async end(): Promise<void> {
    const endedAt = this.now().toISOString();
    this.currentMeta = {
      ...this.currentMeta,
      lifecycle: "ended",
      ended_at: endedAt,
    };
    await this.store.writeSpaceMeta(this.currentMeta);
  }
}

async function openOrJoin(
  name: string,
  options: SpaceOptions,
): Promise<{ meta: SpaceMeta; store: SpaceStore; now: () => Date }> {
  if (!options.passportId) {
    throw new SpaceValidationError(
      [{ code: "custom", path: ["passportId"], message: "passportId is required" }],
      "SpaceOptions",
    );
  }

  const store = SpaceStore.open(options);
  const now = options.now ?? (() => new Date());
  const existing = await findSpace(store, name);
  const latest = existing ? await readLatestMeta(store, existing) : undefined;
  const meta = latest ? joinMeta(latest, options.passportId, now) : createMeta(name, options.passportId, now);
  await store.writeSpaceMeta(meta);
  return { meta, store, now };
}

async function readLatestMeta(store: SpaceStore, fallback: SpaceMeta): Promise<SpaceMeta> {
  try {
    return await store.readSpaceMeta(fallback.id);
  } catch {
    return fallback;
  }
}

async function findSpace(store: SpaceStore, idOrName: string): Promise<SpaceMeta | undefined> {
  const normalized = normalizeName(idOrName);
  const spaces = await store.listSpaceMetas();
  return spaces.find((space) => space.id === idOrName || normalizeName(space.name) === normalized);
}

function createMeta(name: string, passportId: string, now: () => Date): SpaceMeta {
  const createdAt = now().toISOString();
  return {
    schema_version: "1.0",
    id: `${slugify(name)}-${randomUUID().slice(0, 8)}`,
    name,
    lifecycle: "open",
    members: [{ passport_id: passportId, joined_at: createdAt }],
    created_at: createdAt,
    ended_at: null,
    archived_at: null,
  };
}

function joinMeta(meta: SpaceMeta, passportId: string, now: () => Date): SpaceMeta {
  const activeMember = meta.members.some((member) => member.passport_id === passportId && !member.left_at);
  const members = activeMember ? meta.members : [...meta.members, { passport_id: passportId, joined_at: now().toISOString() }];
  const activeCount = members.filter((member) => !member.left_at).length;

  return {
    ...meta,
    lifecycle: meta.lifecycle === "open" && activeCount > 1 ? "active" : meta.lifecycle,
    members,
  };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function slugify(name: string): string {
  const slug = normalizeName(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug || "space";
}
