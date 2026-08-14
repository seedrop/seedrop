#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LLMClient } from "../../src/classifier.js";
import {
  PR15_JOURNAL_VERSION,
  appendJournalBudgetEvent,
  appendJournalResult,
  readOrCreateJournal,
  readPr15ExecutionContract,
  verifyPr15ProviderCatalog,
  withBudget,
  withRequestCompatibility,
  withRetries,
  type Pr15CostTelemetry,
  type Pr15ExecutionContract,
  type Pr15ExecutionProfile,
  type Pr15RetryTelemetry,
  type Pr15SpendApproval,
} from "./pr15-execute.js";
import {
  auditPr15ExecutionValidity,
  type Pr15ExecutionValidityAudit,
  type Pr15ExecutionValidityThresholds,
} from "./pr15-audit.js";
import {
  PR15_JUDGE_PARSER_VERSION,
  PR15_JUDGE_PROMPT_VERSION,
  PR15_PROMPT_VERSION,
  PR15_RUNNER_VERSION,
  runPr15Probe,
  type Pr15ModelProfile,
  type Pr15ProbeResult,
} from "./pr15-runner.js";
import { evaluateCorpusReadiness, readPr15Contract } from "./readiness.js";
import { loadFrozenPr15Replays, type FrozenPr15Replay, type Pr15Arm } from "./replay.js";

export const PR15_CANARY_CONTRACT_VERSION = "1.1.0" as const;
export const PR15_CANARY_RECEIPT_VERSION = "1.1.0" as const;

export interface Pr15CanaryCase {
  fixture_id: string;
  probe_id: string;
}

export interface Pr15CanaryContract {
  schema_version: "1.0.0" | typeof PR15_CANARY_CONTRACT_VERSION;
  canary_id: string;
  frozen_at: string;
  source_receipt_digest: string;
  purpose: "execution_compatibility_only" | "repair_validation" | "failed_attempt_request_compatibility";
  runner_version?: typeof PR15_RUNNER_VERSION;
  prompt_version?: typeof PR15_PROMPT_VERSION;
  judge_prompt_version?: typeof PR15_JUDGE_PROMPT_VERSION;
  judge_parser_version?: typeof PR15_JUDGE_PARSER_VERSION;
  prerequisite_canary_id?: string;
  cases: Pr15CanaryCase[];
  arms: Pr15Arm[];
  model_profiles: Pr15ModelProfile[];
  seed: number;
  expected_model_results: number;
  validity_thresholds: Pr15ExecutionValidityThresholds;
  behavior_thresholds?: {
    min_correct_refusal_rate: number;
    max_unexpected_refusal_rate: number;
  };
  limitations: string[];
}

export interface Pr15CanaryBehaviorAudit {
  evaluated: boolean;
  expected_refusal_results: number;
  correct_refusals: number;
  correct_refusal_rate: number;
  served_results: number;
  unexpected_refusals: number;
  unexpected_refusal_rate: number;
  passed: boolean;
}

export interface Pr15CanaryReceiptBody {
  schema_version: typeof PR15_CANARY_RECEIPT_VERSION;
  canary_id: string;
  started_at: string;
  completed_at: string;
  canary_contract_digest: string;
  execution_contract_digest: string;
  source_receipt_digest: string;
  prerequisite_receipt_digest: string | null;
  spend_approval: Pr15SpendApproval;
  spend_actual_usd: number;
  spend_unsettled_reservations_usd: number;
  call_plan: { model_calls: number; max_judge_calls: number; max_logical_calls: number; max_provider_attempts: number };
  runner_version: typeof PR15_RUNNER_VERSION;
  prompt_version: typeof PR15_PROMPT_VERSION;
  judge_prompt_version: typeof PR15_JUDGE_PROMPT_VERSION;
  judge_parser_version: typeof PR15_JUDGE_PARSER_VERSION;
  results: Pr15ProbeResult[];
  execution_validity: Pr15ExecutionValidityAudit;
  behavioral_validity: Pr15CanaryBehaviorAudit;
  canary_passed: boolean;
  product_gate_evaluated: false;
}

export interface Pr15CanaryReceipt extends Pr15CanaryReceiptBody {
  receipt_digest: string;
}

export function assertPr15CanaryReceipt(input: unknown): asserts input is Pr15CanaryReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid PR-15 canary receipt: object_required.");
  }
  const value = input as Record<string, unknown>;
  const currentVersions = value.runner_version === PR15_RUNNER_VERSION
    && value.prompt_version === PR15_PROMPT_VERSION
    && value.judge_prompt_version === PR15_JUDGE_PROMPT_VERSION
    && value.judge_parser_version === PR15_JUDGE_PARSER_VERSION;
  if (value.schema_version !== PR15_CANARY_RECEIPT_VERSION || !currentVersions
    || typeof value.canary_id !== "string" || !value.canary_id.trim()
    || typeof value.canary_passed !== "boolean" || value.product_gate_evaluated !== false
    || typeof value.receipt_digest !== "string") {
    throw new Error("Invalid PR-15 canary receipt: shape_or_version.");
  }
  const { receipt_digest: receiptDigest, ...body } = value;
  if (receiptDigest !== digest(canonicalJson(body))) {
    throw new Error("Invalid PR-15 canary receipt: digest_mismatch.");
  }
}

export async function readPr15CanaryContract(path: string): Promise<Pr15CanaryContract> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid PR-15 canary contract: object_required.");
  }
  const value = parsed as Pr15CanaryContract;
  const uniqueCases = new Set(value.cases?.map((item) => `${item.fixture_id}\0${item.probe_id}`));
  const uniqueArms = new Set(value.arms);
  const uniqueProfiles = new Set(value.model_profiles);
  const expected = (value.cases?.length ?? 0) * (value.arms?.length ?? 0) * (value.model_profiles?.length ?? 0);
  const legacy = value.schema_version === "1.0.0";
  const currentVersions = value.runner_version === PR15_RUNNER_VERSION
    && value.prompt_version === PR15_PROMPT_VERSION
    && value.judge_prompt_version === PR15_JUDGE_PROMPT_VERSION
    && value.judge_parser_version === PR15_JUDGE_PARSER_VERSION;
  const behavior = value.behavior_thresholds;
  if (!["1.0.0", PR15_CANARY_CONTRACT_VERSION].includes(value.schema_version) || !value.canary_id?.trim()
    || !Number.isFinite(Date.parse(value.frozen_at))
    || !/^sha256:[0-9a-f]{64}$/.test(value.source_receipt_digest)
    || !["execution_compatibility_only", "repair_validation", "failed_attempt_request_compatibility"].includes(value.purpose)
    || !Array.isArray(value.cases) || value.cases.length < 1 || uniqueCases.size !== value.cases.length
    || value.cases.some((item) => !item.fixture_id?.trim() || !item.probe_id?.trim())
    || !Array.isArray(value.arms) || value.arms.length < 1 || value.arms.length > 4 || uniqueArms.size !== value.arms.length
    || value.arms.some((arm) => !["repo_only", "current_v1", "packet_only", "v2_situation"].includes(arm))
    || !Array.isArray(value.model_profiles) || value.model_profiles.length < 1 || value.model_profiles.length > 2
    || uniqueProfiles.size !== value.model_profiles.length
    || value.model_profiles.some((profile) => !["primary", "weak"].includes(profile))
    || !Number.isSafeInteger(value.seed) || value.seed < 1
    || value.expected_model_results !== expected
    || !Array.isArray(value.limitations) || value.limitations.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Invalid PR-15 canary contract: shape_or_version.");
  }
  if (legacy) {
    if (value.purpose !== "execution_compatibility_only" || value.arms.length !== 4
      || value.model_profiles.join("\0") !== "primary\0weak") {
      throw new Error("Invalid PR-15 canary contract: legacy_shape.");
    }
  } else if (!currentVersions || (value.purpose === "repair_validation"
    && (!behavior || !value.prerequisite_canary_id?.trim()))) {
    throw new Error("Invalid PR-15 canary contract: unbound_repair_versions.");
  }
  if (behavior && (![behavior.min_correct_refusal_rate, behavior.max_unexpected_refusal_rate]
    .every((item) => Number.isFinite(item) && item >= 0 && item <= 1))) {
    throw new Error("Invalid PR-15 canary contract: behavior_thresholds.");
  }
  auditPr15ExecutionValidity([], new Map(), value.validity_thresholds);
  return value;
}

export function evaluatePr15CanaryBehavior(
  results: readonly Pr15ProbeResult[],
  contract: Pr15CanaryContract,
): Pr15CanaryBehaviorAudit {
  const expected = results.filter((result) => result.situation_outcome === "refused");
  const served = results.filter((result) => result.situation_outcome === "served");
  const correctRefusals = expected.filter((result) => result.correct && result.refused).length;
  const unexpectedRefusals = served.filter((result) => result.refused).length;
  const correctRefusalRate = expected.length === 0 ? 0 : correctRefusals / expected.length;
  const unexpectedRefusalRate = served.length === 0 ? 0 : unexpectedRefusals / served.length;
  const thresholds = contract.behavior_thresholds;
  const evaluated = thresholds !== undefined;
  return {
    evaluated,
    expected_refusal_results: expected.length,
    correct_refusals: correctRefusals,
    correct_refusal_rate: correctRefusalRate,
    served_results: served.length,
    unexpected_refusals: unexpectedRefusals,
    unexpected_refusal_rate: unexpectedRefusalRate,
    passed: !evaluated || (expected.length > 0
      && correctRefusalRate >= thresholds.min_correct_refusal_rate
      && unexpectedRefusalRate <= thresholds.max_unexpected_refusal_rate),
  };
}

export function selectPr15CanaryCases(
  replays: readonly FrozenPr15Replay[],
  contract: Pr15CanaryContract,
): Array<{ replay: FrozenPr15Replay; probe: FrozenPr15Replay["probes"][number] }> {
  const replayById = new Map(replays.map((replay) => [replay.id, replay]));
  return contract.cases.map((item) => {
    const replay = replayById.get(item.fixture_id);
    const probe = replay?.probes.find((candidate) => candidate.id === item.probe_id);
    if (!replay || !probe) throw new Error(`PR-15 canary case is absent from the frozen corpus: ${item.fixture_id}/${item.probe_id}.`);
    return { replay, probe };
  });
}

export function evaluatePr15Canary(
  results: readonly Pr15ProbeResult[],
  contract: Pr15CanaryContract,
  execution: Pr15ExecutionContract,
): Pr15ExecutionValidityAudit {
  if (results.length !== contract.expected_model_results) {
    throw new Error(`PR-15 canary expected ${contract.expected_model_results} results, found ${results.length}.`);
  }
  const caps = new Map(execution.profiles.map((profile) =>
    [profile.model_profile, profile.max_completion_tokens] as const));
  return auditPr15ExecutionValidity(results, caps, contract.validity_thresholds);
}

async function executeCanary(
  cases: ReturnType<typeof selectPr15CanaryCases>,
  canary: Pr15CanaryContract,
  execution: Pr15ExecutionContract,
  contract: Awaited<ReturnType<typeof readPr15Contract>>,
  spendApproval: Pr15SpendApproval,
  prerequisiteReceiptDigest: string | null,
  OpenAI: new (config: { apiKey: string; baseURL: string }) => LLMClient,
  resumeResults: readonly Pr15ProbeResult[],
  budgetState: Pr15CostTelemetry,
  journalPath: string,
): Promise<Pr15CanaryReceipt> {
  const started = new Date();
  const results: Pr15ProbeResult[] = [...resumeResults];
  const completedKeys = new Set(results.map(resultKey));
  const budget: Pr15CostTelemetry = { ...budgetState };
  const selectedProfiles = execution.profiles.filter((profile) => canary.model_profiles.includes(profile.model_profile));
  for (const definition of selectedProfiles) {
    const prefix = definition.model_profile === "primary" ? "PRIMARY" : "WEAK";
    const apiKey = requireEnv(`SEEDROP_PR15_${prefix}_API_KEY`);
    const judgeApiKey = process.env[`SEEDROP_PR15_${prefix}_JUDGE_API_KEY`] ?? apiKey;
    const rawClient = new OpenAI({ apiKey, baseURL: definition.base_url });
    const rawJudge = definition.judge_base_url === definition.base_url && judgeApiKey === apiKey
      ? rawClient : new OpenAI({ apiKey: judgeApiKey, baseURL: definition.judge_base_url });
    const prior = results.filter((result) => result.model_profile === definition.model_profile);
    const telemetry: Pr15RetryTelemetry = {
      total_retries: prior.reduce((sum, result) => sum + result.retry_count, 0),
      total_provider_attempts: prior.reduce((sum, result) => sum + result.provider_attempt_count, 0),
    };
    const client = withRetries(withBudget(withRequestCompatibility(rawClient, definition.request_compatibility),
      execution.pricing_basis.models, spendApproval.max_usd, budget,
      (event) => appendJournalBudgetEvent(journalPath, event)), execution.retry_policy, telemetry,
    (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
    const sameCompatibility = canonicalJson(definition.request_compatibility)
      === canonicalJson(definition.judge_request_compatibility);
    const judgeClient = rawJudge === rawClient && sameCompatibility ? client
      : withRetries(withBudget(withRequestCompatibility(rawJudge, definition.judge_request_compatibility),
        execution.pricing_basis.models, spendApproval.max_usd, budget,
        (event) => appendJournalBudgetEvent(journalPath, event)), execution.retry_policy, telemetry,
      (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
    for (const { replay, probe } of cases) for (const arm of canary.arms) {
      const identity = resultKey({ model_profile: definition.model_profile, fixture_id: replay.id,
        probe_id: probe.id, arm, seed: canary.seed });
      if (completedKeys.has(identity)) continue;
      const result = await runPr15Probe(replay, probe, arm, canary.seed, {
        client,
        model: definition.model_revision,
        model_profile: definition.model_profile,
        judgeClient,
        judgeModel: definition.judge_model_revision,
        temperature: definition.temperature,
        max_completion_tokens: definition.max_completion_tokens,
        reasoning_effort: definition.reasoning_effort,
        judge_max_completion_tokens: definition.judge_max_completion_tokens,
        judge_reasoning_effort: definition.judge_reasoning_effort,
        retryCount: () => telemetry.total_retries,
        providerAttemptCount: () => telemetry.total_provider_attempts,
        providerCostUsd: () => budget.actual_usd,
        contract,
      });
      await appendJournalResult(journalPath, result);
      results.push(result);
      completedKeys.add(identity);
    }
  }
  const validity = evaluatePr15Canary(results, canary, execution);
  const behavioralValidity = evaluatePr15CanaryBehavior(results, canary);
  const completed = new Date();
  const callPlan = canaryCallPlan(canary, execution);
  const body: Pr15CanaryReceiptBody = {
    schema_version: PR15_CANARY_RECEIPT_VERSION,
    canary_id: canary.canary_id,
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    canary_contract_digest: digest(canonicalJson(canary)),
    execution_contract_digest: digest(canonicalJson(execution)),
    source_receipt_digest: canary.source_receipt_digest,
    prerequisite_receipt_digest: prerequisiteReceiptDigest,
    spend_approval: { ...spendApproval },
    spend_actual_usd: budget.actual_usd,
    spend_unsettled_reservations_usd: budget.reserved_usd,
    call_plan: callPlan,
    runner_version: PR15_RUNNER_VERSION,
    prompt_version: PR15_PROMPT_VERSION,
    judge_prompt_version: PR15_JUDGE_PROMPT_VERSION,
    judge_parser_version: PR15_JUDGE_PARSER_VERSION,
    results,
    execution_validity: validity,
    behavioral_validity: behavioralValidity,
    canary_passed: validity.passed && behavioralValidity.passed,
    product_gate_evaluated: false,
  };
  return { ...body, receipt_digest: digest(canonicalJson(body)) };
}

function validateCanaryResume(
  results: readonly Pr15ProbeResult[],
  cases: ReturnType<typeof selectPr15CanaryCases>,
  canary: Pr15CanaryContract,
  execution: Pr15ExecutionContract,
): Pr15ProbeResult[] {
  const allowed = new Map(cases.map(({ replay, probe }) => [`${replay.id}\0${probe.id}`, replay]));
  const definitions = new Map(execution.profiles.filter((profile) => canary.model_profiles.includes(profile.model_profile))
    .map((profile) => [profile.model_profile, profile]));
  const seen = new Set<string>();
  for (const result of results) {
    const definition = definitions.get(result.model_profile);
    const replay = allowed.get(`${result.fixture_id}\0${result.probe_id}`);
    const key = resultKey(result);
    if (!definition || !replay || result.fixture_digest !== replay.fixture_digest
      || !canary.arms.includes(result.arm) || result.seed !== canary.seed
      || result.model !== definition.model_revision || result.judge_model !== definition.judge_model_revision
      || seen.has(key) || !Number.isSafeInteger(result.provider_attempt_count) || result.provider_attempt_count < 1
      || !Number.isSafeInteger(result.retry_count) || result.retry_count < 0
      || !Number.isFinite(result.provider_cost_usd) || result.provider_cost_usd < 0) {
      throw new Error("Invalid PR-15 canary resume journal; no model calls made.");
    }
    seen.add(key);
  }
  return [...results];
}

function resultKey(input: Pick<Pr15ProbeResult,
  "model_profile" | "fixture_id" | "probe_id" | "arm" | "seed">): string {
  return `${input.model_profile}\0${input.fixture_id}\0${input.probe_id}\0${input.arm}\0${input.seed}`;
}

function canaryCallPlan(canary: Pr15CanaryContract, execution: Pr15ExecutionContract): Pr15CanaryReceiptBody["call_plan"] {
  const modelCalls = canary.expected_model_results;
  const maxJudgeCalls = modelCalls;
  const maxLogicalCalls = modelCalls + maxJudgeCalls;
  return { model_calls: modelCalls, max_judge_calls: maxJudgeCalls, max_logical_calls: maxLogicalCalls,
    max_provider_attempts: maxLogicalCalls * (execution.retry_policy.max_retries + 1) };
}

function assertCanaryExecutionContract(execution: Pr15ExecutionContract, canary: Pr15CanaryContract): void {
  if (canary.schema_version !== PR15_CANARY_CONTRACT_VERSION
    || canary.runner_version !== PR15_RUNNER_VERSION || canary.prompt_version !== PR15_PROMPT_VERSION
    || canary.judge_prompt_version !== PR15_JUDGE_PROMPT_VERSION
    || canary.judge_parser_version !== PR15_JUDGE_PARSER_VERSION
    || execution.seeds !== 1 || execution.retry_policy.max_retries !== 0
    || execution.profiles.some((profile) => profile.max_completion_tokens < 2_048
      || profile.judge_max_completion_tokens < 512)) {
    throw new Error("PR-15 canary execution contract requires one seed, zero retries, model cap >=2048, and judge cap >=512.");
  }
}

async function assertOutputAbsent(path: string): Promise<void> {
  try {
    await access(resolve(path));
    throw new Error(`PR-15 canary receipt already exists; no model calls made: ${resolve(path)}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const fixturesPath = flag("fixtures");
  const canaryPath = flag("canary");
  const executionPath = flag("execution");
  const outputPath = flag("out");
  if (!fixturesPath || !canaryPath || !executionPath || !outputPath) {
    throw new Error("Usage: pr15-canary.ts --fixtures <frozen-directory> --canary <canary-contract.json> --execution <execution-contract.json> --out <receipt.json> [--prerequisite-receipt <receipt.json>]");
  }
  const contract = await readPr15Contract();
  const replays = await loadFrozenPr15Replays(resolve(fixturesPath));
  const readiness = evaluateCorpusReadiness(replays, contract);
  if (!readiness.ready_for_model_spend) {
    throw new Error(`PR-15 frozen corpus is not ready; no canary calls made: ${readiness.blockers.join(", ")}`);
  }
  const canary = await readPr15CanaryContract(canaryPath);
  const execution = await readPr15ExecutionContract(executionPath);
  assertCanaryExecutionContract(execution, canary);
  let prerequisiteReceiptDigest: string | null = null;
  if (canary.prerequisite_canary_id) {
    const prerequisitePath = flag("prerequisite-receipt");
    if (!prerequisitePath) {
      throw new Error(`PR-15 repair canary requires a passing ${canary.prerequisite_canary_id} receipt; no model calls made.`);
    }
    const prerequisite = JSON.parse(await readFile(resolve(prerequisitePath), "utf8")) as unknown;
    assertPr15CanaryReceipt(prerequisite);
    if (prerequisite.canary_id !== canary.prerequisite_canary_id || !prerequisite.canary_passed) {
      throw new Error(`PR-15 repair canary prerequisite did not pass: expected ${canary.prerequisite_canary_id}; no model calls made.`);
    }
    prerequisiteReceiptDigest = prerequisite.receipt_digest;
  }
  const cases = selectPr15CanaryCases(replays, canary);
  const callPlan = canaryCallPlan(canary, execution);
  const spendApproval = {
    max_logical_calls: envInteger("SEEDROP_PR15_CANARY_APPROVED_LOGICAL_CALLS"),
    max_provider_attempts: envInteger("SEEDROP_PR15_CANARY_APPROVED_PROVIDER_ATTEMPTS"),
    max_usd: envPositiveNumber("SEEDROP_PR15_CANARY_APPROVED_MAX_USD"),
  };
  if (spendApproval.max_logical_calls !== callPlan.max_logical_calls
    || spendApproval.max_provider_attempts !== callPlan.max_provider_attempts
    || !Number.isFinite(spendApproval.max_usd) || spendApproval.max_usd <= 0) {
    throw new Error(`PR-15 canary spend is not approved; no model calls made. Exact approval required: `
      + `${callPlan.max_logical_calls} logical calls, ${callPlan.max_provider_attempts} provider attempts, and a positive USD ceiling.`);
  }
  await assertOutputAbsent(outputPath);
  await verifyPr15ProviderCatalog(execution);
  const canaryDigest = digest(canonicalJson(canary));
  const executionDigest = digest(canonicalJson(execution));
  const journalPath = flag("journal") ?? `${outputPath}.journal.jsonl`;
  const journalCallPlan = {
    model_calls: callPlan.model_calls,
    max_judge_calls: callPlan.max_judge_calls,
    max_total_logical_calls: callPlan.max_logical_calls,
    max_provider_attempts: callPlan.max_provider_attempts,
  };
  const journal = await readOrCreateJournal(journalPath, {
    schema_version: PR15_JOURNAL_VERSION,
    benchmark_id: canary.canary_id,
    runner_version: PR15_RUNNER_VERSION,
    prompt_version: PR15_PROMPT_VERSION,
    judge_prompt_version: PR15_JUDGE_PROMPT_VERSION,
    judge_parser_version: PR15_JUDGE_PARSER_VERSION,
    contract_digest: canaryDigest,
    corpus_digest: digest(canonicalJson(cases.map(({ replay, probe }) => ({
      fixture_id: replay.id, fixture_digest: replay.fixture_digest, probe_id: probe.id,
    })))),
    execution_contract_digest: executionDigest,
    seeds: 1,
    retry_policy: execution.retry_policy,
    call_plan: journalCallPlan,
    spend_approval: spendApproval,
    profiles: execution.profiles,
  });
  const resumeResults = validateCanaryResume(journal.results, cases, canary, execution);
  const { default: OpenAI } = (await import("openai" as string).catch(() => {
    throw new Error(`Install the frozen PR-15 client: npm install --no-save openai@${execution.provider_client.version}`);
  })) as { default: new (config: { apiKey: string; baseURL: string }) => LLMClient };
  const installedVersion = ((await import("openai/version" as string)) as { VERSION?: string }).VERSION;
  if (installedVersion !== execution.provider_client.version) {
    throw new Error(`PR-15 provider client mismatch: expected openai@${execution.provider_client.version}, found ${installedVersion ?? "unknown"}.`);
  }
  const receipt = await executeCanary(cases, canary, execution, contract, spendApproval,
    prerequisiteReceiptDigest, OpenAI,
    resumeResults, journal.budget, journalPath);
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ receipt: output, receipt_digest: receipt.receipt_digest,
    canary_passed: receipt.canary_passed, results: receipt.results.length }, null, 2)}\n`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function envInteger(name: string): number {
  const value = Number(process.env[name] ?? "NaN");
  if (!Number.isSafeInteger(value)) return -1;
  return value;
}

function envPositiveNumber(name: string): number {
  const value = Number(process.env[name] ?? "NaN");
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

if (process.argv[1]?.endsWith("pr15-canary.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
