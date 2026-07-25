import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LLMClient } from "../../src/classifier.js";
import { intervalsOverlap, wilsonInterval } from "../erosion/stats.js";
import type {
  Arm,
  ArmSummary,
  BenchmarkSummary,
  ProbeCheck,
  ProbeResult,
  ResumptionProbe,
  ResumptionTask,
  RunnerOptions,
} from "./types.js";

/** Providers that follow the OpenAI response shape attach usage; LLMResponse doesn't type it. */
interface MaybeUsage {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Rough fallback when the provider returns no usage block. */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

function systemPrompt(task: ResumptionTask, arm: Arm): string {
  const header = [
    `You are an autonomous software agent resuming work on the project "${task.project_name}" after time away.`,
    `You have no memory of your previous sessions. The material below is everything you have.`,
    `Ground every answer strictly in this material. Follow answer-format directives exactly.`,
    ``,
  ];
  if (arm === "booted") {
    header.push(
      `=== ORIENTATION (Situation packet produced by the project's orientation layer at boot) ===`,
      task.boot_packet,
      ``,
    );
  }
  header.push(`=== RAW REPOSITORY EVIDENCE ===`, task.repo_evidence);
  return header.join("\n");
}

async function applyCheck(
  check: ProbeCheck,
  response: string,
  judgeClient: LLMClient,
  judgeModel: string,
): Promise<boolean> {
  if (check.kind === "regex") {
    const re = new RegExp(check.pattern, check.flags ?? "i");
    const matched = re.test(response);
    return check.correct_when === "matches" ? matched : !matched;
  }
  const reply = await judgeClient.chat.completions.create({
    model: judgeModel,
    messages: [
      {
        role: "system",
        content:
          "You are a strict judge. Read the assistant's answer and answer the question with EXACTLY one word: YES or NO. No other text.",
      },
      {
        role: "user",
        content: `Assistant's answer:\n\n${response}\n\nQuestion: ${check.question}\n\nAnswer YES or NO:`,
      },
    ],
    temperature: 0,
    max_tokens: 4,
  });
  const raw = reply.choices[0]?.message?.content ?? "";
  const verdict = raw.trim().toUpperCase().match(/YES|NO/)?.[0] ?? "NO";
  return verdict === check.correct_answer;
}

export async function runProbe(
  task: ResumptionTask,
  probe: ResumptionProbe,
  arm: Arm,
  seed: number,
  options: Required<Pick<RunnerOptions, "model" | "client">> &
    Pick<RunnerOptions, "judgeClient" | "judgeModel" | "temperature">,
): Promise<ProbeResult> {
  const temperature = options.temperature ?? 0.3;
  const judgeClient = options.judgeClient ?? options.client;
  const judgeModel = options.judgeModel ?? options.model;

  const system = systemPrompt(task, arm);
  const reply = await options.client.chat.completions.create({
    model: options.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: probe.question },
    ],
    temperature,
    seed,
  });
  const response = reply.choices[0]?.message?.content ?? "";

  const usage = (reply as MaybeUsage).usage;
  const prompt_tokens = usage?.prompt_tokens ?? estimateTokens(system + probe.question);
  const completion_tokens = usage?.completion_tokens ?? estimateTokens(response);
  const token_source: ProbeResult["token_source"] =
    usage?.prompt_tokens !== undefined ? "api" : "estimated";

  const correct = await applyCheck(probe.check, response, judgeClient, judgeModel);
  return {
    task_id: task.id,
    probe_id: probe.id,
    arm,
    seed,
    response,
    correct,
    prompt_tokens,
    completion_tokens,
    token_source,
  };
}

function summarizeArm(results: ProbeResult[]): ArmSummary {
  const n = results.length;
  const correct = results.filter((r) => r.correct).length;
  const [ci_low, ci_high] = wilsonInterval(correct, n);
  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    n,
    correct,
    rate: n === 0 ? 0 : correct / n,
    ci_low,
    ci_high,
    mean_prompt_tokens: mean(results.map((r) => r.prompt_tokens)),
    mean_completion_tokens: mean(results.map((r) => r.completion_tokens)),
  };
}

export function summarize(
  results: ProbeResult[],
  tasks: readonly ResumptionTask[] = [],
): BenchmarkSummary {
  const cold = summarizeArm(results.filter((r) => r.arm === "cold"));
  const booted = summarizeArm(results.filter((r) => r.arm === "booted"));

  const scenarioById = new Map(tasks.map((t) => [t.id, t.scenario]));
  const taskIds = Array.from(new Set(results.map((r) => r.task_id))).sort();
  const per_task = taskIds.map((id) => {
    const c = results.filter((r) => r.task_id === id && r.arm === "cold");
    const b = results.filter((r) => r.task_id === id && r.arm === "booted");
    return {
      task_id: id,
      scenario: scenarioById.get(id) ?? "",
      cold: { n: c.length, correct: c.filter((r) => r.correct).length },
      booted: { n: b.length, correct: b.filter((r) => r.correct).length },
    };
  });

  return {
    arms: { cold, booted },
    delta_pp: (booted.rate - cold.rate) * 100,
    cis_overlap: intervalsOverlap([cold.ci_low, cold.ci_high], [booted.ci_low, booted.ci_high]),
    marginal_prompt_tokens: booted.mean_prompt_tokens - cold.mean_prompt_tokens,
    per_task,
  };
}

export async function runBenchmark(
  tasks: readonly ResumptionTask[],
  options: RunnerOptions,
): Promise<{ results: ProbeResult[]; summary: BenchmarkSummary }> {
  const seeds = options.seeds ?? 5;
  const results: ProbeResult[] = [];
  for (const task of tasks) {
    for (const probe of task.probes) {
      for (const arm of ["cold", "booted"] as const) {
        for (let seed = 1; seed <= seeds; seed++) {
          results.push(await runProbe(task, probe, arm, seed, options));
        }
      }
    }
  }
  return { results, summary: summarize(results, tasks) };
}

/** Load and structurally validate all task JSONs in a directory. Throws on malformed tasks. */
export async function loadTasks(dir: string): Promise<ResumptionTask[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const tasks: ResumptionTask[] = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf8");
    const task = JSON.parse(raw) as ResumptionTask;
    for (const field of ["id", "scenario", "project_name", "repo_evidence", "boot_packet"] as const) {
      if (typeof task[field] !== "string" || task[field].length === 0) {
        throw new Error(`${f}: missing or empty field "${field}"`);
      }
    }
    if (!Array.isArray(task.probes) || task.probes.length === 0) {
      throw new Error(`${f}: task must declare at least one probe`);
    }
    for (const probe of task.probes) {
      if (probe.check.kind === "regex") {
        // Throws here (at load time) rather than mid-benchmark if the pattern is malformed.
        new RegExp(probe.check.pattern, probe.check.flags ?? "i");
      }
    }
    tasks.push(task);
  }
  return tasks;
}
