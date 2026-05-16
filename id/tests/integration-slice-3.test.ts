/**
 * Slice 3 ship-criterion (PRD §9.3):
 *
 *   With classifier: "rule" → Slice 2 routing is preserved.
 *   With classifier: "llm" → routes 20 hand-labeled experiences with ≥85% accuracy.
 *
 * The "rule preserved" and "wiring works under an oracle LLM" arms run
 * unconditionally. The "real LLM at ≥85% accuracy" arm is gated behind
 * environment variables (per CONTRIBUTING.md the live-LLM tests are opt-in).
 *
 * To run against a real backend:
 *   OPENAI_BASE_URL=https://api.groq.com/openai/v1 \
 *   OPENAI_API_KEY=...                              \
 *   SEEDROP_INTEGRATION_MODEL=llama-3.1-8b-instant \
 *   npm test -- tests/integration-slice-3.test.ts
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import type { LLMClient } from "../src/classifier.js";
import type { Channel, Message } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");
const experiencesPath = join(__dirname, "fixtures", "hand-labeled-experiences.json");

interface Experience {
  id: string;
  role: Message["role"];
  content: string;
  label: Channel;
}

interface ExperiencesFile {
  experiences: Experience[];
}

async function loadExperiences(): Promise<Experience[]> {
  const raw = await readFile(experiencesPath, "utf8");
  return (JSON.parse(raw) as ExperiencesFile).experiences;
}

describe("Slice 3 ship-criterion — rule arm", () => {
  it("classifier: 'rule' preserves Slice 2 behavior across all 20 experiences", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    const experiences = await loadExperiences();
    for (const e of experiences) {
      const r = await session.record({ role: e.role, content: e.content });
      expect(r.channel).toBe("commitments");
    }
  });
});

describe("Slice 3 ship-criterion — oracle LLM (mocked, plumbing)", () => {
  it("with an oracle LLM, 20/20 experiences route to ground truth", async () => {
    const experiences = await loadExperiences();
    const labelById = new Map(experiences.map((e) => [e.content, e.label] as const));

    const oracleClient: LLMClient = {
      chat: {
        completions: {
          create: async (req) => {
            const lastContent = req.messages[req.messages.length - 1]?.content ?? "";
            const original = lastContent.replace(/^Message to classify[^\n]*\n/, "");
            const label = labelById.get(original) ?? "commitments";
            return { choices: [{ message: { content: label } }] };
          },
        },
      },
    };

    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({
      classifier: "llm",
      llm: { client: oracleClient, model: "oracle" },
    });

    let correct = 0;
    for (const e of experiences) {
      const r = await session.record({ role: e.role, content: e.content });
      if (r.channel === e.label) correct++;
    }
    expect(correct).toBe(experiences.length);
  });
});

const SHOULD_RUN_REAL_LLM =
  !!process.env.OPENAI_API_KEY &&
  !!process.env.OPENAI_BASE_URL &&
  !!process.env.SEEDROP_INTEGRATION_MODEL;

describe.skipIf(!SHOULD_RUN_REAL_LLM)(
  "Slice 3 ship-criterion — real LLM (gated by env)",
  () => {
    it("classifier: 'llm' routes 20 hand-labeled experiences with ≥85% accuracy", async () => {
      // Lazy-import so the suite doesn't require `openai` to be installed by default.
      const { default: OpenAI } = await import("openai" as string).catch(() => {
        throw new Error(
          "Install `openai` and set OPENAI_API_KEY / OPENAI_BASE_URL / SEEDROP_INTEGRATION_MODEL to run this.",
        );
      });
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      }) as unknown as LLMClient;

      const experiences = await loadExperiences();
      const id = await Identity.fromPassport(fixturePath);
      const session = id.session({
        classifier: "llm",
        llm: { client, model: process.env.SEEDROP_INTEGRATION_MODEL! },
      });

      let correct = 0;
      const wrong: Array<{ id: string; expected: Channel; got: Channel; content: string }> = [];
      for (const e of experiences) {
        const r = await session.record({ role: e.role, content: e.content });
        if (r.channel === e.label) correct++;
        else wrong.push({ id: e.id, expected: e.label, got: r.channel, content: e.content });
      }
      const accuracy = correct / experiences.length;
      // eslint-disable-next-line no-console
      console.log(
        `Real-LLM accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${experiences.length})`,
      );
      if (wrong.length > 0) {
        // eslint-disable-next-line no-console
        console.log("Misclassified:", wrong);
      }
      expect(accuracy).toBeGreaterThanOrEqual(0.85);
    }, 60_000);
  },
);
