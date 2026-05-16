import { describe, it, expect, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import { IdentityConfigError } from "../src/errors.js";
import type { EmbeddingProvider } from "../src/embeddings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

/**
 * Deterministic 2-dim embedder:
 *  - The literal identity-prompt text → [1, 0]
 *  - Any other text containing "ONTOPIC" (case-insensitive) → [1, 0]
 *  - Any other text containing "OFFTOPIC" → [0, 1]
 *  - Otherwise → [0.7, 0.7] (neutral)
 * This is enough to exercise the coherence math deterministically.
 */
function fakeEmbeddings(): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((t) => {
        const u = t.toUpperCase();
        if (u.startsWith("YOU ARE")) return [1, 0];
        if (u.includes("ONTOPIC")) return [1, 0];
        if (u.includes("OFFTOPIC")) return [0, 1];
        return [0.7, 0.7];
      });
    },
  };
}

describe("Session.coherence", () => {
  it("throws IdentityConfigError when no embeddings provider is configured", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    await expect(session.coherence()).rejects.toBeInstanceOf(IdentityConfigError);
  });

  it("returns 0 for an empty session (no commitment messages)", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    expect(await session.coherence()).toBe(0);
  });

  it("returns ~0 when only on-topic content is in working memory", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    await session.record({ role: "user", content: "ONTOPIC review the PR" });
    await session.record({ role: "assistant", content: "ONTOPIC opening the diff" });
    expect(await session.coherence()).toBeCloseTo(0, 5);
  });

  it("returns 1 when only off-topic content is in working memory", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    await session.record(
      { role: "user", content: "OFFTOPIC random noise" },
      { channel: "commitments" },
    );
    await session.record(
      { role: "user", content: "OFFTOPIC more noise" },
      { channel: "commitments" },
    );
    expect(await session.coherence()).toBeCloseTo(1, 5);
  });

  it("ignores boundary-channel messages", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    await session.record({ role: "user", content: "ONTOPIC" });
    await session.record(
      { role: "user", content: "OFFTOPIC" },
      { channel: "boundary" },
    );
    expect(await session.coherence()).toBeCloseTo(0, 5);
  });

  it("grows monotonically as off-topic content accumulates in commitments", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    await session.record({ role: "user", content: "ONTOPIC seed" });
    const trace: number[] = [];
    trace.push(await session.coherence());
    for (let i = 0; i < 5; i++) {
      await session.record(
        { role: "user", content: `OFFTOPIC noise ${i}` },
        { channel: "commitments" },
      );
      trace.push(await session.coherence());
    }
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]!).toBeGreaterThanOrEqual(trace[i - 1]! - 1e-9);
    }
    expect(trace[trace.length - 1]).toBeGreaterThan(trace[0]!);
  });

  it("caches embeddings — repeat coherence() calls do not re-embed identity or messages", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const provider = fakeEmbeddings();
    const session = id.session({ embeddings: provider });
    await session.record({ role: "user", content: "ONTOPIC one" });
    await session.coherence();
    await session.coherence();
    await session.coherence();
    const flat = provider.calls.flat();
    expect(flat.filter((t) => t.toUpperCase().startsWith("YOU ARE")).length).toBe(1);
    expect(flat.filter((t) => t === "ONTOPIC one").length).toBe(1);
  });

  it("only embeds new messages on subsequent coherence() calls", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const provider = fakeEmbeddings();
    const session = id.session({ embeddings: provider });
    await session.record({ role: "user", content: "ONTOPIC a" });
    await session.coherence();
    await session.record({ role: "user", content: "ONTOPIC b" });
    await session.coherence();
    const flat = provider.calls.flat();
    expect(flat.filter((t) => t === "ONTOPIC a").length).toBe(1);
    expect(flat.filter((t) => t === "ONTOPIC b").length).toBe(1);
  });

  it("rethrows when the provider returns no identity vector", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const broken: EmbeddingProvider = { async embed() { return []; } };
    const session = id.session({ embeddings: broken });
    await expect(session.coherence()).rejects.toThrow(/no vector for the identity prompt/);
  });

  it("rethrows when the provider returns a mismatched batch size for messages", async () => {
    const id = await Identity.fromPassport(fixturePath);
    let call = 0;
    const broken: EmbeddingProvider = {
      async embed(texts) {
        call++;
        if (call === 1) return [[1, 0]];
        return texts.slice(0, -1).map(() => [0, 0]);
      },
    };
    const session = id.session({ embeddings: broken });
    await session.record({ role: "user", content: "x" });
    await session.record({ role: "user", content: "y" });
    await expect(session.coherence()).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });

  it("calls the provider only once for an empty commit set after the identity vector is cached", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const provider = fakeEmbeddings();
    const session = id.session({ embeddings: provider });
    await session.coherence(); // embeds identity, no messages
    await session.coherence(); // identity cached, still no messages
    expect(provider.calls.length).toBe(1);
  });
});
