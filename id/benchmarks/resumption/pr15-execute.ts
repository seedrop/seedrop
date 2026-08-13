#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LLMClient } from "../../src/classifier.js";
import {
  PR15_PROMPT_VERSION,
  PR15_JUDGE_PROMPT_VERSION,
  PR15_RUNNER_VERSION,
  runPr15Benchmark,
  summarizePr15,
  type AcceptedSubgroupRegression,
  type Pr15ModelProfile,
  type Pr15ProbeResult,
  type Pr15Summary,
} from "./pr15-runner.js";
import { evaluateCorpusReadiness, readPr15Contract, type Pr15Contract } from "./readiness.js";
import { loadFrozenPr15Replays, type FrozenPr15Replay } from "./replay.js";

export const PR15_RECEIPT_VERSION = "1.0.0" as const;
export const PR15_SAMPLING_CONTRACT_VERSION = "1.0.0" as const;

export interface Pr15RetryPolicy {
  max_retries: number;
  base_delay_ms: number;
}

export interface Pr15ExecutionProfile {
  model_profile: Pr15ModelProfile;
  provider_id: string;
  provider_version: string;
  base_url: string;
  model: string;
  model_revision: string;
  judge_provider_id: string;
  judge_provider_version: string;
  judge_base_url: string;
  judge_model: string;
  judge_model_revision: string;
  temperature: number;
}

export interface Pr15ExecutableProfile {
  definition: Pr15ExecutionProfile;
  client: LLMClient;
  judge_client: LLMClient;
}

export interface Pr15FixtureIdentity {
  fixture_id: string;
  fixture_digest: string;
  repo_id: string;
  repo_commit: string;
  evidence_cutoff: string;
  semantic_digest: string;
}

export interface Pr15PersistedProfile extends Pr15ExecutionProfile {
  total_retries: number;
}

export interface Pr15ReceiptBody {
  schema_version: typeof PR15_RECEIPT_VERSION;
  benchmark_id: string;
  runner_version: typeof PR15_RUNNER_VERSION;
  prompt_version: typeof PR15_PROMPT_VERSION;
  judge_prompt_version: typeof PR15_JUDGE_PROMPT_VERSION;
  sampling_contract_version: typeof PR15_SAMPLING_CONTRACT_VERSION;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  contract_digest: string;
  corpus_digest: string;
  fixtures: Pr15FixtureIdentity[];
  seeds: number;
  retry_policy: Pr15RetryPolicy;
  profiles: Pr15PersistedProfile[];
  accepted_subgroup_regressions: AcceptedSubgroupRegression[];
  summary: Pr15Summary;
  results: Pr15ProbeResult[];
}

export interface Pr15ProofReceipt extends Pr15ReceiptBody {
  receipt_digest: string;
}

export interface ExecutePr15Options {
  replays: readonly FrozenPr15Replay[];
  contract: Pr15Contract;
  profiles: readonly Pr15ExecutableProfile[];
  seeds?: number;
  retry_policy?: Pr15RetryPolicy;
  accepted_subgroup_regressions?: readonly AcceptedSubgroupRegression[];
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function executePr15Proof(options: ExecutePr15Options): Promise<Pr15ProofReceipt> {
  const readiness = evaluateCorpusReadiness(options.replays, options.contract);
  if (!readiness.ready_for_model_spend) {
    throw new Error(`PR-15 corpus is not ready; no model calls made: ${readiness.blockers.join(", ")}`);
  }
  const profiles = assertProfiles(options.profiles);
  const seeds = options.seeds ?? 5;
  if (!Number.isSafeInteger(seeds) || seeds < 1) throw new Error("PR-15 seeds must be a positive safe integer.");
  const retryPolicy = options.retry_policy ?? { max_retries: 3, base_delay_ms: 5_000 };
  assertRetryPolicy(retryPolicy);
  const clock = options.now ?? (() => new Date());
  const sleeper = options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const started = clock();
  const results: Pr15ProbeResult[] = [];
  const persistedProfiles: Pr15PersistedProfile[] = [];

  for (const profile of profiles) {
    const telemetry = { total_retries: 0 };
    const client = withRetries(profile.client, retryPolicy, telemetry, sleeper);
    const judgeClient = profile.judge_client === profile.client
      ? client : withRetries(profile.judge_client, retryPolicy, telemetry, sleeper);
    const run = await runPr15Benchmark(options.replays, {
      client,
      model: profile.definition.model,
      model_profile: profile.definition.model_profile,
      judgeClient,
      judgeModel: profile.definition.judge_model,
      seeds,
      temperature: profile.definition.temperature,
      retryCount: () => telemetry.total_retries,
      contract: options.contract,
    });
    results.push(...run.results);
    persistedProfiles.push({ ...profile.definition, total_retries: telemetry.total_retries });
  }

  const completed = clock();
  const accepted = (options.accepted_subgroup_regressions ?? []).map((item) => ({ ...item }));
  const body: Pr15ReceiptBody = {
    schema_version: PR15_RECEIPT_VERSION,
    benchmark_id: options.contract.benchmark_id,
    runner_version: PR15_RUNNER_VERSION,
    prompt_version: PR15_PROMPT_VERSION,
    judge_prompt_version: PR15_JUDGE_PROMPT_VERSION,
    sampling_contract_version: PR15_SAMPLING_CONTRACT_VERSION,
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    elapsed_ms: Math.max(0, completed.getTime() - started.getTime()),
    contract_digest: digest(canonicalJson(options.contract)),
    corpus_digest: corpusDigest(options.replays),
    fixtures: fixtureIdentities(options.replays),
    seeds,
    retry_policy: { ...retryPolicy },
    profiles: persistedProfiles,
    accepted_subgroup_regressions: accepted,
    summary: summarizePr15(results, options.contract, accepted),
    results,
  };
  return { ...body, receipt_digest: digest(canonicalJson(body)) };
}

export function assertPr15ProofReceipt(input: unknown): asserts input is Pr15ProofReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidReceipt("object_required");
  const value = input as Record<string, unknown>;
  if (value.schema_version !== PR15_RECEIPT_VERSION || value.runner_version !== PR15_RUNNER_VERSION
    || value.prompt_version !== PR15_PROMPT_VERSION || value.judge_prompt_version !== PR15_JUDGE_PROMPT_VERSION
    || value.sampling_contract_version !== PR15_SAMPLING_CONTRACT_VERSION) {
    invalidReceipt("version_mismatch");
  }
  if (typeof value.receipt_digest !== "string") invalidReceipt("digest_required");
  const { receipt_digest: receiptDigest, ...body } = value;
  if (receiptDigest !== digest(canonicalJson(body))) invalidReceipt("digest_mismatch");
  if (!Array.isArray(value.fixtures) || !Array.isArray(value.results) || !Array.isArray(value.profiles)) {
    invalidReceipt("collections_required");
  }
  const fixtures = new Map((value.fixtures as Pr15FixtureIdentity[]).map((item) => [item.fixture_id, item.fixture_digest]));
  if ((value.results as Pr15ProbeResult[]).some((item) => fixtures.get(item.fixture_id) !== item.fixture_digest)) {
    invalidReceipt("result_fixture_mismatch");
  }
}

export async function writePr15ProofReceipt(path: string, receipt: Pr15ProofReceipt): Promise<void> {
  assertPr15ProofReceipt(receipt);
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}

export function withRetries(
  client: LLMClient,
  policy: Pr15RetryPolicy,
  telemetry: { total_retries: number },
  sleep: (milliseconds: number) => Promise<void>,
): LLMClient {
  assertRetryPolicy(policy);
  return { chat: { completions: { create: async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.chat.completions.create(request);
      } catch (error) {
        if (!isTransient(error) || attempt >= policy.max_retries) throw error;
        telemetry.total_retries += 1;
        await sleep(policy.base_delay_ms * (2 ** attempt));
      }
    }
  } } } };
}

function assertProfiles(input: readonly Pr15ExecutableProfile[]): Pr15ExecutableProfile[] {
  const profiles = [...input];
  if (profiles.length !== 2 || profiles[0]?.definition.model_profile !== "primary"
    || profiles[1]?.definition.model_profile !== "weak") {
    throw new Error("PR-15 execution requires exactly [primary, weak] model profiles in that order.");
  }
  for (const profile of profiles) {
    const value = profile.definition;
    if (![value.provider_id, value.provider_version, value.base_url, value.model, value.model_revision,
      value.judge_provider_id, value.judge_provider_version, value.judge_base_url, value.judge_model, value.judge_model_revision]
      .every((item) => typeof item === "string" && item.trim().length > 0)
      || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) {
      throw new Error(`Invalid PR-15 ${value.model_profile} execution profile.`);
    }
  }
  if (profiles[0]!.definition.model === profiles[1]!.definition.model
    && profiles[0]!.definition.provider_id === profiles[1]!.definition.provider_id) {
    throw new Error("PR-15 weak-model ablation must differ from the primary model/provider identity.");
  }
  return profiles;
}

function assertRetryPolicy(policy: Pr15RetryPolicy): void {
  if (!Number.isSafeInteger(policy.max_retries) || policy.max_retries < 0 || policy.max_retries > 10
    || !Number.isSafeInteger(policy.base_delay_ms) || policy.base_delay_ms < 0) {
    throw new Error("Invalid PR-15 retry policy.");
  }
}

function fixtureIdentities(replays: readonly FrozenPr15Replay[]): Pr15FixtureIdentity[] {
  return replays.map((replay) => {
    if (!replay.wave7) throw new Error(`PR-15 replay ${replay.id} has no Wave 7 binding.`);
    return { fixture_id: replay.id, fixture_digest: replay.fixture_digest, repo_id: replay.wave7.repo_id,
      repo_commit: replay.wave7.repo_commit, evidence_cutoff: replay.wave7.evidence_cutoff,
      semantic_digest: replay.wave7.semantic_digest };
  }).sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
}

function corpusDigest(replays: readonly FrozenPr15Replay[]): string {
  return digest(canonicalJson(fixtureIdentities(replays)));
}

function isTransient(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status) : NaN;
  return status === 429 || status >= 500 || /429|rate.?limit|5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(error));
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite PR-15 receipt value.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  throw new Error("Cannot hash an unsupported PR-15 receipt value.");
}
function invalidReceipt(reason: string): never { throw new Error(`Invalid PR-15 proof receipt: ${reason}.`); }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const fixturesPath = flag("fixtures");
  const outputPath = flag("out");
  if (!fixturesPath || !outputPath) throw new Error("Usage: pr15-execute.ts --fixtures <frozen-directory> --out <receipt.json> [--contract <json>]");
  const contract = await readPr15Contract(flag("contract") ? resolve(flag("contract")!) : undefined);
  const replays = await loadFrozenPr15Replays(resolve(fixturesPath));
  const readiness = evaluateCorpusReadiness(replays, contract);
  if (!readiness.ready_for_model_spend) {
    process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const primary = envProfile("PRIMARY", "primary");
  const weak = envProfile("WEAK", "weak");
  const { default: OpenAI } = (await import("openai" as string).catch(() => {
    throw new Error("Install `openai` to execute PR-15: npm install --no-save openai");
  })) as { default: new (config: { apiKey: string; baseURL: string }) => LLMClient };
  const makeExecutable = (definition: Pr15ExecutionProfile, prefix: "PRIMARY" | "WEAK"): Pr15ExecutableProfile => {
    const apiKey = requireEnv(`SEEDROP_PR15_${prefix}_API_KEY`);
    const judgeApiKey = process.env[`SEEDROP_PR15_${prefix}_JUDGE_API_KEY`] ?? apiKey;
    const client = new OpenAI({ apiKey, baseURL: definition.base_url });
    const judgeClient = definition.judge_base_url === definition.base_url && judgeApiKey === apiKey
      ? client : new OpenAI({ apiKey: judgeApiKey, baseURL: definition.judge_base_url });
    return { definition, client, judge_client: judgeClient };
  };
  const seeds = envInteger("SEEDROP_PR15_SEEDS", 5);
  const retryPolicy = { max_retries: envInteger("SEEDROP_PR15_MAX_RETRIES", 3),
    base_delay_ms: envInteger("SEEDROP_PR15_RETRY_BASE_MS", 5_000) };
  const expectedCalls = replays.reduce((total, replay) => total + replay.probes.length, 0) * contract.arms.length * seeds * 2;
  process.stdout.write(`PR-15 readiness passed. Executing ${expectedCalls} primary/weak probe calls before judge calls.\n`);
  const receipt = await executePr15Proof({ replays, contract,
    profiles: [makeExecutable(primary, "PRIMARY"), makeExecutable(weak, "WEAK")], seeds, retry_policy: retryPolicy });
  await writePr15ProofReceipt(outputPath, receipt);
  process.stdout.write(`${JSON.stringify({ receipt: resolve(outputPath), receipt_digest: receipt.receipt_digest,
    gate_passed: receipt.summary.gate_passed, results: receipt.results.length }, null, 2)}\n`);
}

function envProfile(prefix: "PRIMARY" | "WEAK", modelProfile: Pr15ModelProfile): Pr15ExecutionProfile {
  const baseUrl = requireEnv(`SEEDROP_PR15_${prefix}_BASE_URL`);
  return { model_profile: modelProfile, provider_id: requireEnv(`SEEDROP_PR15_${prefix}_PROVIDER`),
    provider_version: requireEnv(`SEEDROP_PR15_${prefix}_PROVIDER_VERSION`), base_url: baseUrl,
    model: requireEnv(`SEEDROP_PR15_${prefix}_MODEL`), model_revision: requireEnv(`SEEDROP_PR15_${prefix}_MODEL_REVISION`),
    judge_provider_id: process.env[`SEEDROP_PR15_${prefix}_JUDGE_PROVIDER`] ?? requireEnv(`SEEDROP_PR15_${prefix}_PROVIDER`),
    judge_provider_version: process.env[`SEEDROP_PR15_${prefix}_JUDGE_PROVIDER_VERSION`]
      ?? requireEnv(`SEEDROP_PR15_${prefix}_PROVIDER_VERSION`),
    judge_base_url: process.env[`SEEDROP_PR15_${prefix}_JUDGE_BASE_URL`] ?? baseUrl,
    judge_model: process.env[`SEEDROP_PR15_${prefix}_JUDGE_MODEL`] ?? requireEnv(`SEEDROP_PR15_${prefix}_MODEL`),
    judge_model_revision: process.env[`SEEDROP_PR15_${prefix}_JUDGE_MODEL_REVISION`]
      ?? requireEnv(`SEEDROP_PR15_${prefix}_MODEL_REVISION`),
    temperature: Number(process.env[`SEEDROP_PR15_${prefix}_TEMPERATURE`] ?? "0") };
}
function requireEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing required env var: ${name}`); return value; }
function envInteger(name: string, fallback: number): number { const value = Number(process.env[name] ?? String(fallback)); if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`); return value; }

if (process.argv[1] && process.argv[1].endsWith("pr15-execute.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
