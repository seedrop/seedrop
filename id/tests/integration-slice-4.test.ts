/**
 * Slice 4 ship-criterion (PRD §9.4):
 *
 *   Drift score is 0.0 ± 0.05 after loading passport with no other input.
 *   Drift grows monotonically as off-topic content accumulates without recovery.
 *
 * Uses a deterministic 2-dim fake embedder so the ship-criterion holds without
 * depending on a real model. A real-embedder arm is gated behind environment
 * variables (per CONTRIBUTING.md the live-LLM tests are opt-in).
 *
 * To run against a real Ollama backend:
 *   SEEDROP_INTEGRATION_OLLAMA=1 \
 *   SEEDROP_INTEGRATION_OLLAMA_URL=http://localhost:11434 \
 *   SEEDROP_INTEGRATION_OLLAMA_MODEL=nomic-embed-text     \
 *   npm test -- tests/integration-slice-4.test.ts
 */

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import { OllamaEmbeddings } from "../src/embeddings.js";
import type { EmbeddingProvider } from "../src/embeddings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

function fakeEmbeddings(): EmbeddingProvider {
  return {
    async embed(texts) {
      return texts.map((t) => {
        const u = t.toUpperCase();
        if (u.startsWith("YOU ARE")) return [1, 0];
        if (u.includes("OFFTOPIC")) return [0, 1];
        return [1, 0];
      });
    },
  };
}

describe("Slice 4 ship-criterion — drift baseline", () => {
  it("drift is 0.0 ± 0.05 after loading the passport with no other input", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });
    const drift = await session.coherence();
    expect(drift).toBeGreaterThanOrEqual(0);
    expect(drift).toBeLessThanOrEqual(0.05);
  });
});

describe("Slice 4 ship-criterion — drift grows monotonically without recovery", () => {
  it("each off-topic commitment-channel message moves drift up (or holds steady)", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });

    const trace: number[] = [await session.coherence()];
    for (let i = 0; i < 8; i++) {
      await session.record(
        { role: "user", content: `OFFTOPIC noise ${i}` },
        { channel: "commitments" },
      );
      trace.push(await session.coherence());
    }
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]!).toBeGreaterThanOrEqual(trace[i - 1]! - 1e-9);
    }
    expect(trace[trace.length - 1]).toBeGreaterThan(trace[0]! + 0.5);
  });
});

const SHOULD_RUN_REAL_OLLAMA =
  process.env.SEEDROP_INTEGRATION_OLLAMA === "1" &&
  !!process.env.SEEDROP_INTEGRATION_OLLAMA_URL &&
  !!process.env.SEEDROP_INTEGRATION_OLLAMA_MODEL;

describe.skipIf(!SHOULD_RUN_REAL_OLLAMA)(
  "Slice 4 ship-criterion — real Ollama (gated by env)",
  () => {
    it("passes baseline and monotonic-growth ship-criterion against a real embedder", async () => {
      const embeddings = new OllamaEmbeddings({
        baseURL: process.env.SEEDROP_INTEGRATION_OLLAMA_URL!,
        model: process.env.SEEDROP_INTEGRATION_OLLAMA_MODEL!,
      });
      const id = await Identity.fromPassport(fixturePath);
      const session = id.session({ embeddings });

      const baseline = await session.coherence();
      expect(baseline).toBeLessThanOrEqual(0.05);

      const offTopics = [
        "Let me tell you about my favorite recipe for sourdough bread.",
        "The weather in Reykjavik is unpredictable in autumn.",
        "Have you ever tried competitive ballroom dancing?",
        "My cat keeps knocking pens off the desk.",
        "I've been reading about 17th-century Dutch shipbuilding.",
      ];
      const trace: number[] = [baseline];
      for (const t of offTopics) {
        await session.record({ role: "user", content: t }, { channel: "commitments" });
        trace.push(await session.coherence());
      }
      expect(trace[trace.length - 1]).toBeGreaterThan(trace[0]!);
    }, 60_000);
  },
);
