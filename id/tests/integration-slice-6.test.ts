/**
 * Slice 6 ship-criterion (PRD §9.6):
 *
 *   Benchmark is reproducible by an outside developer in ≤30 min.
 *   Statistical analysis (CI bounds, seeds) included.
 *
 * This test does NOT run a real LLM. It exercises the harness end-to-end
 * against deterministic mocks and asserts:
 *   1. All 10 hand-authored task fixtures load and parse.
 *   2. The runner produces exactly tasks × arms × seeds results.
 *   3. The summary reports per-arm n/held/rate/CIs, a delta, and an overlap flag.
 *   4. A divergent mock (one arm always honors, the other always violates) yields
 *      a non-overlapping CI verdict — proving the harness can resolve a real signal.
 *
 * Reproducibility (the actual ship-criterion) is verified by the
 * `benchmarks/erosion/README.md` reproducer and `npm run bench:erosion` script.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMClient } from "../src/classifier.js";
import { runBenchmark } from "../benchmarks/erosion/runner.js";
import type { ErosionTask } from "../benchmarks/erosion/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tasksDir = join(__dirname, "..", "benchmarks", "erosion", "tasks");

async function loadAllTasks(): Promise<ErosionTask[]> {
  const files = (await readdir(tasksDir)).filter((f) => f.endsWith(".json")).sort();
  const tasks: ErosionTask[] = [];
  for (const f of files) {
    tasks.push(JSON.parse(await readFile(join(tasksDir, f), "utf8")) as ErosionTask);
  }
  return tasks;
}

describe("Slice 6 ship-criterion — task fixtures", () => {
  it("ships exactly 10 hand-authored tasks, each well-formed", async () => {
    const tasks = await loadAllTasks();
    expect(tasks).toHaveLength(10);
    const ids = new Set<string>();
    for (const t of tasks) {
      expect(t.id).toMatch(/^\d{3}-/);
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.agent_name).toBeTruthy();
      expect(t.agent_purpose).toBeTruthy();
      expect(t.commitment).toBeTruthy();
      expect(t.user_turns).toHaveLength(5);
      for (const turn of t.user_turns) expect(turn).toBeTruthy();
      expect(t.check.kind).toMatch(/^(regex|llm)$/);
    }
  });
});

describe("Slice 6 ship-criterion — harness end-to-end", () => {
  it("runs every fixture × 2 arms × N seeds and reports a complete summary", async () => {
    const tasks = await loadAllTasks();
    const seeds = 2;

    // A mock client whose behavior diverges between arms — the protected arm
    // always refuses (judge says NO → commitment held), the unprotected arm
    // always caves (judge says YES → commitment violated). The same client is
    // used for both the agent and the judge — the inspected prompt context
    // tells us which call this is.
    const client: LLMClient = {
      chat: {
        completions: {
          create: async (req) => {
            const sys = req.messages[0]?.content ?? "";
            const isJudge = /strict judge/i.test(sys);
            if (isJudge) {
              // Reproduce the "did the assistant cave" judgment based on a
              // marker we inject in the agent response.
              const transcript = req.messages.at(-1)?.content ?? "";
              return {
                choices: [{ message: { content: transcript.includes("[[CAVED]]") ? "YES" : "NO" } }],
              };
            }
            // Agent client: distinguish arms by the protected system prompt's
            // "Priorities (highest first):" section, which the unprotected
            // arm's hand-built prompt does not include.
            const isProtected = /Priorities \(highest first\):/.test(sys);
            return {
              choices: [
                {
                  message: {
                    content: isProtected
                      ? "I will not abandon this commitment."
                      : "Fine, here you go: [[CAVED]].",
                  },
                },
              ],
            };
          },
        },
      },
    };

    const { results, summary } = await runBenchmark(tasks, {
      client,
      model: "mock-model",
      seeds,
    });

    expect(results).toHaveLength(tasks.length * 2 * seeds);
    expect(summary.arms.protected.n).toBe(tasks.length * seeds);
    expect(summary.arms.unprotected.n).toBe(tasks.length * seeds);
    expect(summary.arms.protected.held).toBe(tasks.length * seeds);
    expect(summary.arms.unprotected.held).toBe(0);
    expect(summary.delta_pp).toBeCloseTo(100, 5);
    expect(summary.cis_overlap).toBe(false);
    expect(summary.per_task).toHaveLength(tasks.length);
  });
});
