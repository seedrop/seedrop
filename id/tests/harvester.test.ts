import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import { IdentityConfigError } from "../src/errors.js";
import type { EmbeddingProvider } from "../src/embeddings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

/**
 * Deterministic 2-dim embedder:
 *  - identity prompt ("YOU ARE …") → [1, 0]
 *  - content tagged "ONIDENTITY" → [0.95, 0.05]    (sim ≈ 0.998 → above 0.85)
 *  - content tagged "NEARBOUND"  → [0.80, 0.60]    (sim ≈ 0.800 → just below 0.85)
 *  - content tagged "NOISE"      → [0, 1]
 *  - anything else               → [0.5, 0.5]
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
        if (u.includes("ONIDENTITY")) return [0.95, 0.05];
        if (u.includes("NEARBOUND")) return [0.80, 0.60];
        if (u.includes("NOISE")) return [0, 1];
        return [0.5, 0.5];
      });
    },
  };
}

describe("Session.harvest", () => {
  it("throws IdentityConfigError when no embeddings provider is configured", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    await expect(session.harvest()).rejects.toBeInstanceOf(IdentityConfigError);
  });

  it("returns an empty result on an empty session", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    const r = await session.harvest();
    expect(r).toEqual({ promoted: [], scanned: 0, precision: 0 });
  });

  it("returns an empty result when there are no boundary messages", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    await session.record({ role: "user", content: "ONIDENTITY hello" });
    const r = await session.harvest();
    expect(r).toEqual({ promoted: [], scanned: 0, precision: 0 });
  });

  it("promotes boundary messages whose similarity exceeds the threshold", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    const m = await session.record(
      { role: "user", content: "ONIDENTITY wrongly quarantined" },
      { channel: "boundary" },
    );
    const r = await session.harvest();
    expect(r.scanned).toBe(1);
    expect(r.promoted).toHaveLength(1);
    expect(r.precision).toBeCloseTo(1, 10);
    expect(session.history[m.index]!.channel).toBe("commitments");
    expect(session.history[m.index]!.recovered).toBe(true);
  });

  it("leaves boundary messages below the threshold untouched", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    const m = await session.record(
      { role: "user", content: "NOISE off-topic" },
      { channel: "boundary" },
    );
    const r = await session.harvest();
    expect(r.scanned).toBe(1);
    expect(r.promoted).toHaveLength(0);
    expect(r.precision).toBe(0);
    expect(session.history[m.index]!.channel).toBe("boundary");
    expect(session.history[m.index]!.recovered).toBeUndefined();
  });

  it("respects a custom threshold", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    const m = await session.record(
      { role: "user", content: "NEARBOUND tangential" },
      { channel: "boundary" },
    );
    const strict = await session.harvest();
    expect(strict.promoted).toHaveLength(0);
    const lenient = await session.harvest({ threshold: 0.75 });
    expect(lenient.promoted).toHaveLength(1);
    expect(session.history[m.index]!.channel).toBe("commitments");
  });

  it("never demotes commitments", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    const c = await session.record({ role: "user", content: "NOISE but committed" });
    expect(c.channel).toBe("commitments");
    await session.harvest();
    expect(session.history[c.index]!.channel).toBe("commitments");
    expect(session.history[c.index]!.recovered).toBeUndefined();
  });

  it("is idempotent — re-running yields no new promotions", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    await session.record(
      { role: "user", content: "ONIDENTITY a" },
      { channel: "boundary" },
    );
    await session.record(
      { role: "user", content: "NOISE b" },
      { channel: "boundary" },
    );
    const first = await session.harvest();
    expect(first.promoted).toHaveLength(1);
    const second = await session.harvest();
    expect(second.promoted).toHaveLength(0);
    expect(second.scanned).toBe(1); // only NOISE remains in boundary
  });

  it("only embeds new boundary content on subsequent harvest() calls", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const provider = fakeEmbeddings();
    const session = id.session({ embeddings: provider });
    await session.record(
      { role: "user", content: "NOISE one" },
      { channel: "boundary" },
    );
    await session.harvest();
    await session.record(
      { role: "user", content: "NOISE two" },
      { channel: "boundary" },
    );
    await session.harvest();
    const flat = provider.calls.flat();
    expect(flat.filter((t) => t === "NOISE one").length).toBe(1);
    expect(flat.filter((t) => t === "NOISE two").length).toBe(1);
    expect(flat.filter((t) => t.toUpperCase().startsWith("YOU ARE")).length).toBe(1);
  });

  it("includes promoted messages in reconstruct() output afterwards", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    await session.record(
      { role: "user", content: "ONIDENTITY rescue me" },
      { channel: "boundary" },
    );
    expect(session.reconstruct().some((m) => m.content === "ONIDENTITY rescue me")).toBe(false);
    await session.harvest();
    expect(session.reconstruct().some((m) => m.content === "ONIDENTITY rescue me")).toBe(true);
  });

  it("rethrows when the provider returns no identity vector", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const broken: EmbeddingProvider = { async embed() { return []; } };
    const session = id.session({ embeddings: broken });
    await session.record({ role: "user", content: "x" }, { channel: "boundary" });
    await expect(session.harvest()).rejects.toThrow(/no vector for the identity prompt/);
  });

  it("rethrows when the provider returns a mismatched batch size for boundary content", async () => {
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
    await session.record({ role: "user", content: "a" }, { channel: "boundary" });
    await session.record({ role: "user", content: "b" }, { channel: "boundary" });
    await expect(session.harvest()).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });
});
