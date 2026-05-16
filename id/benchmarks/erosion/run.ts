#!/usr/bin/env tsx
/**
 * CLI entry for the commitment-erosion benchmark.
 *
 * Required environment:
 *   OPENAI_API_KEY   — API key for the agent-under-test endpoint
 *   OPENAI_BASE_URL  — Base URL (e.g. https://api.groq.com/openai/v1 or http://localhost:11434/v1)
 *   SEEDROP_BENCH_MODEL — Model name (e.g. llama-3.1-8b-instant, llama3.1:8b)
 *
 * Optional:
 *   SEEDROP_BENCH_JUDGE_MODEL    — Defaults to SEEDROP_BENCH_MODEL
 *   SEEDROP_BENCH_JUDGE_BASE_URL — Defaults to OPENAI_BASE_URL
 *   SEEDROP_BENCH_JUDGE_API_KEY  — Defaults to OPENAI_API_KEY
 *   SEEDROP_BENCH_SEEDS          — Number of seeds per (task, arm). Default 5.
 *   SEEDROP_BENCH_TASKS_DIR      — Override task directory. Default ./tasks
 *   SEEDROP_BENCH_OUT            — Output JSON path. Default ./results/<timestamp>.json
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMClient } from "../../src/classifier.js";
import { runBenchmark } from "./runner.js";
import type { ErosionTask } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    // eslint-disable-next-line no-console
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

async function loadTasks(dir: string): Promise<ErosionTask[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const tasks: ErosionTask[] = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf8");
    tasks.push(JSON.parse(raw) as ErosionTask);
  }
  return tasks;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const baseURL = requireEnv("OPENAI_BASE_URL");
  const model = requireEnv("SEEDROP_BENCH_MODEL");
  const judgeModel = process.env.SEEDROP_BENCH_JUDGE_MODEL ?? model;
  const judgeBaseURL = process.env.SEEDROP_BENCH_JUDGE_BASE_URL ?? baseURL;
  const judgeApiKey = process.env.SEEDROP_BENCH_JUDGE_API_KEY ?? apiKey;
  const seeds = Number(process.env.SEEDROP_BENCH_SEEDS ?? "5");
  const tasksDir = process.env.SEEDROP_BENCH_TASKS_DIR
    ? resolve(process.env.SEEDROP_BENCH_TASKS_DIR)
    : resolve(__dirname, "tasks");
  const outPath = process.env.SEEDROP_BENCH_OUT
    ? resolve(process.env.SEEDROP_BENCH_OUT)
    : resolve(__dirname, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  const { default: OpenAI } = (await import("openai" as string).catch(() => {
    // eslint-disable-next-line no-console
    console.error("Install `openai` to run the benchmark: npm install --no-save openai");
    process.exit(2);
  })) as { default: new (config: { apiKey: string; baseURL: string }) => LLMClient };

  const client = new OpenAI({ apiKey, baseURL });
  const judgeClient =
    judgeBaseURL === baseURL && judgeApiKey === apiKey
      ? client
      : new OpenAI({ apiKey: judgeApiKey, baseURL: judgeBaseURL });

  const tasks = await loadTasks(tasksDir);
  // eslint-disable-next-line no-console
  console.log(
    `Loaded ${tasks.length} tasks. Running ${tasks.length * 2 * seeds} runs ` +
      `(${tasks.length} tasks × 2 arms × ${seeds} seeds) against model="${model}" at ${baseURL}.`,
  );

  const start = Date.now();
  const { results, summary } = await runBenchmark(tasks, {
    client,
    model,
    judgeClient,
    judgeModel,
    seeds,
  });
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        model,
        baseURL,
        judgeModel,
        seeds,
        elapsed_seconds: Number(elapsedSec),
        summary,
        results,
      },
      null,
      2,
    ),
  );

  // eslint-disable-next-line no-console
  console.log(`\nElapsed: ${elapsedSec}s`);
  // eslint-disable-next-line no-console
  console.log(`Wrote: ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(
    `\n  Arm           n   held   rate   95% CI`,
  );
  for (const arm of ["protected", "unprotected"] as const) {
    const s = summary.arms[arm];
    // eslint-disable-next-line no-console
    console.log(
      `  ${arm.padEnd(12)}  ${String(s.n).padStart(3)}  ${String(s.held).padStart(4)}  ` +
        `${(s.rate * 100).toFixed(1).padStart(5)}%  [${(s.ci_low * 100).toFixed(1)}%, ${(s.ci_high * 100).toFixed(1)}%]`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n  Δ = ${summary.delta_pp.toFixed(1)}pp  ` +
      `(CIs ${summary.cis_overlap ? "OVERLAP — inconclusive" : "do NOT overlap"})`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
