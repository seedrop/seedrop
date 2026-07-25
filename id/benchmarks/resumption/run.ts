#!/usr/bin/env tsx
/**
 * CLI entry for the resumption benchmark: cold vs booted agent A/B.
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
 *   SEEDROP_BENCH_SEEDS          — Number of seeds per (task, probe, arm). Default 5.
 *   SEEDROP_BENCH_TASKS_DIR      — Override task directory. Default ./tasks
 *   SEEDROP_BENCH_OUT            — Output JSON path. Default ./results/<timestamp>.json
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMClient } from "../../src/classifier.js";
import { loadTasks, runBenchmark } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Rate-limit + retry wrapper for providers with tight RPM caps (e.g. NVIDIA NIM at 40 RPM).
 * One limiter is shared across agent and judge clients when they hit the same endpoint.
 * SEEDROP_BENCH_MIN_INTERVAL_MS spaces out calls; 429/5xx responses retry with backoff.
 */
function throttled(client: LLMClient, state: { last: number }, minIntervalMs: number): LLMClient {
  return {
    chat: {
      completions: {
        create: async (req) => {
          const backoffs = [5000, 15000, 30000];
          for (let attempt = 0; ; attempt++) {
            const wait = state.last + minIntervalMs - Date.now();
            if (wait > 0) await sleep(wait);
            state.last = Date.now();
            try {
              return await client.chat.completions.create(req);
            } catch (err) {
              const msg = String(err);
              const transient = /429|rate.?limit|5\d\d|ECONNRESET|ETIMEDOUT/i.test(msg);
              if (!transient || attempt >= backoffs.length) throw err;
              // eslint-disable-next-line no-console
              console.error(`  transient error (attempt ${attempt + 1}), backing off: ${msg.slice(0, 120)}`);
              await sleep(backoffs[attempt]!);
            }
          }
        },
      },
    },
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    // eslint-disable-next-line no-console
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
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

  const minIntervalMs = Number(process.env.SEEDROP_BENCH_MIN_INTERVAL_MS ?? "0");
  const limiter = { last: 0 };
  const client = throttled(new OpenAI({ apiKey, baseURL }), limiter, minIntervalMs);
  const judgeClient =
    judgeBaseURL === baseURL && judgeApiKey === apiKey
      ? client
      : throttled(
          new OpenAI({ apiKey: judgeApiKey, baseURL: judgeBaseURL }),
          judgeBaseURL === baseURL ? limiter : { last: 0 },
          minIntervalMs,
        );

  const tasks = await loadTasks(tasksDir);
  const probeCount = tasks.reduce((acc, t) => acc + t.probes.length, 0);
  // eslint-disable-next-line no-console
  console.log(
    `Loaded ${tasks.length} tasks / ${probeCount} probes. Running ${probeCount * 2 * seeds} probe-runs ` +
      `(${probeCount} probes × 2 arms × ${seeds} seeds) against model="${model}" at ${baseURL}.`,
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
      { model, baseURL, judgeModel, seeds, elapsed_seconds: Number(elapsedSec), summary, results },
      null,
      2,
    ),
  );

  // eslint-disable-next-line no-console
  console.log(`\nElapsed: ${elapsedSec}s`);
  // eslint-disable-next-line no-console
  console.log(`Wrote: ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(`\n  Arm      n   correct   rate   95% CI            ~prompt tok   ~completion tok`);
  for (const arm of ["cold", "booted"] as const) {
    const s = summary.arms[arm];
    // eslint-disable-next-line no-console
    console.log(
      `  ${arm.padEnd(7)}  ${String(s.n).padStart(3)}  ${String(s.correct).padStart(7)}  ` +
        `${(s.rate * 100).toFixed(1).padStart(5)}%  [${(s.ci_low * 100).toFixed(1)}%, ${(s.ci_high * 100).toFixed(1)}%]`.padEnd(42) +
        `${String(s.mean_prompt_tokens).padStart(11)}   ${String(s.mean_completion_tokens).padStart(15)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n  Δ = ${summary.delta_pp.toFixed(1)}pp  ` +
      `(CIs ${summary.cis_overlap ? "OVERLAP — inconclusive" : "do NOT overlap"})`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `  Packet price: +${summary.marginal_prompt_tokens} prompt tokens per probe (booted mean − cold mean)`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
