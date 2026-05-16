/**
 * Slice 5 ship-criterion (PRD §9.5):
 *
 *   On a 50-message synthetic test with 5 wrongly-quarantined commitments,
 *   recovery promotes ≥3 of 5 (60% recall) without promoting noise
 *   (0% false positives target).
 *
 * Deterministic fake embedder makes the math fall out exactly:
 *   - identity prompt           → [1, 0]
 *   - "stranded commitment N"   → [0.95, 0.05]  (sim ≈ 0.998, well above 0.85)
 *   - "noise N"                 → [0, 1]        (sim = 0, well below 0.85)
 *
 * A gated real-Ollama arm is available behind SEEDROP_INTEGRATION_OLLAMA=1.
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
        if (u.includes("STRANDED COMMITMENT")) return [0.95, 0.05];
        return [0, 1];
      });
    },
  };
}

describe("Slice 5 ship-criterion — recovery precision/recall", () => {
  it("promotes ≥3 of 5 wrongly-quarantined commitments with 0 false positives over 50 messages", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ embeddings: fakeEmbeddings() });

    const strandedIndices = new Set<number>();
    const noiseIndices = new Set<number>();

    // 50 boundary messages, 5 of which are wrongly-quarantined commitments
    // placed at deterministic positions so the test is reproducible.
    const strandedPositions = new Set([3, 11, 22, 37, 48]);
    for (let i = 0; i < 50; i++) {
      const isStranded = strandedPositions.has(i);
      const content = isStranded
        ? `STRANDED COMMITMENT ${i}: never approve a force-push without confirmation`
        : `noise ${i}: random off-topic chatter line ${i}`;
      const r = await session.record(
        { role: "user", content },
        { channel: "boundary" },
      );
      if (isStranded) strandedIndices.add(r.index);
      else noiseIndices.add(r.index);
    }

    const result = await session.harvest();
    expect(result.scanned).toBe(50);

    const promotedIndices = new Set(result.promoted.map((m) => m.index));
    const truePositives = [...promotedIndices].filter((i) => strandedIndices.has(i)).length;
    const falsePositives = [...promotedIndices].filter((i) => noiseIndices.has(i)).length;

    expect(truePositives).toBeGreaterThanOrEqual(3);
    expect(falsePositives).toBe(0);
  });
});

const SHOULD_RUN_REAL_OLLAMA =
  process.env.SEEDROP_INTEGRATION_OLLAMA === "1" &&
  !!process.env.SEEDROP_INTEGRATION_OLLAMA_URL &&
  !!process.env.SEEDROP_INTEGRATION_OLLAMA_MODEL;

describe.skipIf(!SHOULD_RUN_REAL_OLLAMA)(
  "Slice 5 ship-criterion — real Ollama (gated by env)",
  () => {
    it("promotes ≥3 of 5 wrongly-quarantined commitments with 0 false positives against a real embedder", async () => {
      const embeddings = new OllamaEmbeddings({
        baseURL: process.env.SEEDROP_INTEGRATION_OLLAMA_URL!,
        model: process.env.SEEDROP_INTEGRATION_OLLAMA_MODEL!,
      });
      const id = await Identity.fromPassport(fixturePath);
      const session = id.session({ embeddings });

      const stranded = [
        "Never approve a force-push to main without explicit confirmation from the operator.",
        "Always disclose uncertainty about claims that could affect production systems.",
        "Do not recommend skipping tests, even when the user is in a hurry.",
        "When asked to review code, surface architectural concerns, not just style.",
        "If a migration risks data loss, require explicit go-ahead before recommending it.",
      ];
      const noise = [
        "My cat keeps knocking pens off the desk.",
        "Let me tell you about my favorite recipe for sourdough bread.",
        "Have you ever tried competitive ballroom dancing?",
        "The weather in Reykjavik is unpredictable in autumn.",
        "I've been reading about 17th-century Dutch shipbuilding.",
      ];
      // Fill the remaining slots with more noise to reach ~50 messages.
      while (noise.length < 45) {
        noise.push(`Random unrelated chatter line number ${noise.length + 1}.`);
      }

      const strandedIndices = new Set<number>();
      const noiseIndices = new Set<number>();
      let position = 0;
      const interleaved: Array<{ content: string; kind: "stranded" | "noise" }> = [];
      const strandedAt = new Set([3, 11, 22, 37, 48]);
      let si = 0;
      let ni = 0;
      for (let i = 0; i < 50; i++) {
        if (strandedAt.has(i) && si < stranded.length) {
          interleaved.push({ content: stranded[si]!, kind: "stranded" });
          si++;
        } else if (ni < noise.length) {
          interleaved.push({ content: noise[ni]!, kind: "noise" });
          ni++;
        }
      }

      for (const item of interleaved) {
        const r = await session.record(
          { role: "user", content: item.content },
          { channel: "boundary" },
        );
        if (item.kind === "stranded") strandedIndices.add(r.index);
        else noiseIndices.add(r.index);
        position++;
      }

      const result = await session.harvest();
      const promotedIndices = new Set(result.promoted.map((m) => m.index));
      const tp = [...promotedIndices].filter((i) => strandedIndices.has(i)).length;
      const fp = [...promotedIndices].filter((i) => noiseIndices.has(i)).length;
      // eslint-disable-next-line no-console
      console.log(`Real-embedder harvest: ${tp}/5 true positives, ${fp} false positives`);
      expect(tp).toBeGreaterThanOrEqual(3);
      expect(fp).toBe(0);
    }, 60_000);
  },
);
