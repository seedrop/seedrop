import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMClient, LLMRequest } from "../src/classifier.js";
import { loadTasks, runBenchmark, runProbe, summarize } from "../benchmarks/resumption/runner.js";
import type { ProbeResult, ResumptionTask } from "../benchmarks/resumption/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = join(__dirname, "..", "benchmarks", "resumption", "tasks");

const task: ResumptionTask = {
  id: "test-task",
  scenario: "harness verification",
  project_name: "testproj",
  repo_evidence: "EVIDENCE-BODY: the answer is B.",
  boot_packet: "PACKET-BODY: the answer is B (synthesized).",
  probes: [
    {
      id: "pick",
      question: 'Answer with exactly "PICK: A" or "PICK: B".',
      check: { kind: "regex", pattern: "^PICK:\\s*B", flags: "im", correct_when: "matches" },
    },
  ],
};

function alwaysSays(content: string): LLMClient {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content } }] }),
      },
    },
  };
}

function capturing(content: string): { client: LLMClient; requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    requests,
    client: {
      chat: {
        completions: {
          create: async (req) => {
            requests.push(req);
            return { choices: [{ message: { content } }] };
          },
        },
      },
    },
  };
}

describe("runProbe — arms and prompts", () => {
  it("gives the cold arm the evidence but not the packet", async () => {
    const { client, requests } = capturing("PICK: B");
    await runProbe(task, task.probes[0]!, "cold", 1, { client, model: "m" });
    const system = requests[0]!.messages[0]!.content;
    expect(system).toContain("EVIDENCE-BODY");
    expect(system).not.toContain("PACKET-BODY");
  });

  it("gives the booted arm the packet AND the same evidence", async () => {
    const { client, requests } = capturing("PICK: B");
    await runProbe(task, task.probes[0]!, "booted", 1, { client, model: "m" });
    const system = requests[0]!.messages[0]!.content;
    expect(system).toContain("PACKET-BODY");
    expect(system).toContain("EVIDENCE-BODY");
  });

  it("scores a regex probe correct/incorrect deterministically", async () => {
    const right = await runProbe(task, task.probes[0]!, "cold", 1, {
      client: alwaysSays("PICK: B"),
      model: "m",
    });
    expect(right.correct).toBe(true);
    const wrong = await runProbe(task, task.probes[0]!, "cold", 1, {
      client: alwaysSays("PICK: A"),
      model: "m",
    });
    expect(wrong.correct).toBe(false);
  });

  it("honors `correct_when: absent`", async () => {
    const inverted: ResumptionTask = {
      ...task,
      probes: [
        {
          id: "avoid",
          question: "Answer anything but never say FORBIDDEN.",
          check: { kind: "regex", pattern: "FORBIDDEN", correct_when: "absent" },
        },
      ],
    };
    const clean = await runProbe(inverted, inverted.probes[0]!, "cold", 1, {
      client: alwaysSays("something safe"),
      model: "m",
    });
    expect(clean.correct).toBe(true);
    const dirty = await runProbe(inverted, inverted.probes[0]!, "cold", 1, {
      client: alwaysSays("FORBIDDEN word"),
      model: "m",
    });
    expect(dirty.correct).toBe(false);
  });

  it("estimates tokens when the provider returns no usage, and flags the source", async () => {
    const r = await runProbe(task, task.probes[0]!, "cold", 1, {
      client: alwaysSays("PICK: B"),
      model: "m",
    });
    expect(r.token_source).toBe("estimated");
    expect(r.prompt_tokens).toBeGreaterThan(0);
    expect(r.completion_tokens).toBeGreaterThan(0);
  });

  it("prefers API usage when the provider returns it", async () => {
    const client: LLMClient = {
      chat: {
        completions: {
          create: async () =>
            ({
              choices: [{ message: { content: "PICK: B" } }],
              usage: { prompt_tokens: 1234, completion_tokens: 56 },
            }) as Awaited<ReturnType<LLMClient["chat"]["completions"]["create"]>>,
        },
      },
    };
    const r = await runProbe(task, task.probes[0]!, "cold", 1, { client, model: "m" });
    expect(r.token_source).toBe("api");
    expect(r.prompt_tokens).toBe(1234);
    expect(r.completion_tokens).toBe(56);
  });
});

describe("runProbe — llm check", () => {
  const llmTask: ResumptionTask = {
    ...task,
    probes: [
      {
        id: "open",
        question: "Recommend an approach.",
        check: {
          kind: "llm",
          question: "Did the assistant recommend the abandoned approach?",
          correct_answer: "NO",
        },
      },
    ],
  };

  it("routes the response through the judge and scores by correct_answer", async () => {
    let judgePayload = "";
    const judgeClient: LLMClient = {
      chat: {
        completions: {
          create: async (req) => {
            judgePayload = req.messages.at(-1)?.content ?? "";
            return { choices: [{ message: { content: "NO" } }] };
          },
        },
      },
    };
    const r = await runProbe(llmTask, llmTask.probes[0]!, "booted", 1, {
      client: alwaysSays("Use the good approach."),
      judgeClient,
      model: "m",
      judgeModel: "judge",
    });
    expect(r.correct).toBe(true);
    expect(judgePayload).toContain("Use the good approach.");
    expect(judgePayload).toContain("Did the assistant recommend the abandoned approach?");
  });

  it("scores incorrect when the judge answer differs from correct_answer", async () => {
    const r = await runProbe(llmTask, llmTask.probes[0]!, "booted", 1, {
      client: alwaysSays("Use the abandoned approach!"),
      judgeClient: alwaysSays("YES"),
      model: "m",
    });
    expect(r.correct).toBe(false);
  });
});

describe("summarize", () => {
  function r(arm: "cold" | "booted", correct: boolean, prompt_tokens = 100): ProbeResult {
    return {
      task_id: "t1",
      probe_id: "p1",
      arm,
      seed: 1,
      response: "",
      correct,
      prompt_tokens,
      completion_tokens: 10,
      token_source: "estimated",
    };
  }

  it("computes per-arm rates, delta, CI-overlap, and the packet's marginal token price", () => {
    const results = [
      ...Array.from({ length: 20 }, () => r("booted", true, 1500)),
      ...Array.from({ length: 20 }, () => r("cold", false, 1000)),
    ];
    const s = summarize(results);
    expect(s.arms.booted.rate).toBe(1);
    expect(s.arms.cold.rate).toBe(0);
    expect(s.delta_pp).toBeCloseTo(100, 5);
    expect(s.cis_overlap).toBe(false);
    expect(s.marginal_prompt_tokens).toBe(500);
  });

  it("reports overlapping CIs when arms perform similarly", () => {
    const results = [
      ...Array.from({ length: 10 }, (_, i) => r("booted", i < 5)),
      ...Array.from({ length: 10 }, (_, i) => r("cold", i < 5)),
    ];
    const s = summarize(results);
    expect(s.delta_pp).toBe(0);
    expect(s.cis_overlap).toBe(true);
  });
});

describe("runBenchmark", () => {
  it("runs every (task, probe, arm, seed) tuple", async () => {
    const { results, summary } = await runBenchmark([task], {
      client: alwaysSays("PICK: B"),
      model: "m",
      seeds: 3,
    });
    expect(results).toHaveLength(6); // 1 task × 1 probe × 2 arms × 3 seeds
    expect(summary.arms.cold.n).toBe(3);
    expect(summary.arms.booted.n).toBe(3);
  });
});

describe("checked-in tasks", () => {
  it("all task JSONs load, validate, and have compilable regex checks", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    expect(tasks.length).toBeGreaterThanOrEqual(6);
    for (const t of tasks) {
      expect(t.probes.length).toBeGreaterThanOrEqual(1);
      expect(t.boot_packet.length).toBeGreaterThan(0);
      expect(t.repo_evidence.length).toBeGreaterThan(0);
    }
  });

  it("keeps task ids unique", async () => {
    const tasks = await loadTasks(TASKS_DIR);
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
