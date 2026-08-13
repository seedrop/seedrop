#!/usr/bin/env tsx
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

export const PR15_RECEIPT_VERSION = "1.1.0" as const;
export const PR15_SAMPLING_CONTRACT_VERSION = "1.0.0" as const;
export const PR15_EXECUTION_CONTRACT_VERSION = "1.0.0" as const;
export const PR15_JOURNAL_VERSION = "1.0.0" as const;

export interface Pr15RetryPolicy {
  max_retries: number;
  base_delay_ms: number;
}

export interface Pr15CallPlan {
  model_calls: number;
  max_judge_calls: number;
  max_total_logical_calls: number;
  max_provider_attempts: number;
}

export interface Pr15SpendApproval {
  max_logical_calls: number;
  max_provider_attempts: number;
  max_usd: number;
}

export interface Pr15CostTelemetry { actual_usd: number; reserved_usd: number }
export type Pr15BudgetEvent = { type: "reservation"; reservation_id: string; usd: number }
  | { type: "settlement"; reservation_id: string; usd: number };

export interface Pr15ExecutionContract {
  schema_version: typeof PR15_EXECUTION_CONTRACT_VERSION;
  contract_id: string;
  frozen_at: string;
  provider_client: { package: "openai"; version: string };
  cohort_class: "formal_reproducible" | "contemporary_screen";
  model_identity_policy: "dated_snapshot" | "provider_alias_observed";
  provider_catalog?: {
    url: string;
    observed_at: string;
    digest: string;
  };
  seeds: number;
  retry_policy: Pr15RetryPolicy;
  profiles: [Pr15ExecutionProfile, Pr15ExecutionProfile];
  pricing_basis: {
    currency: "USD";
    unit: "per_1m_tokens";
    observed_at: string;
    models: Record<string, { input: number; output: number }>;
  };
  source_urls: string[];
  limitations: string[];
}

export interface Pr15RetryTelemetry {
  total_retries: number;
  total_provider_attempts: number;
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
  max_completion_tokens: number;
  reasoning_effort: NonNullable<import("../../src/classifier.js").LLMRequest["reasoning_effort"]>;
  judge_max_completion_tokens: number;
  judge_reasoning_effort: NonNullable<import("../../src/classifier.js").LLMRequest["reasoning_effort"]>;
  request_compatibility?: Pr15RequestCompatibility;
  judge_request_compatibility?: Pr15RequestCompatibility;
}

export interface Pr15RequestCompatibility {
  token_limit_parameter: "max_completion_tokens" | "max_tokens";
  send_reasoning_effort: boolean;
  send_seed: boolean;
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
  total_provider_attempts: number;
  actual_usd: number;
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
  execution_contract_digest: string;
  corpus_digest: string;
  fixtures: Pr15FixtureIdentity[];
  seeds: number;
  retry_policy: Pr15RetryPolicy;
  spend_approval: Pr15SpendApproval;
  spend_actual_usd: number;
  spend_unsettled_reservations_usd: number;
  call_plan: Pr15CallPlan;
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
  spend_approval: Pr15SpendApproval;
  pricing_basis: Pr15ExecutionContract["pricing_basis"];
  budget_state?: Pr15CostTelemetry;
  on_budget_event?: (event: Pr15BudgetEvent) => void | Promise<void>;
  execution_contract_digest: string;
  resume_results?: readonly Pr15ProbeResult[];
  on_result?: (result: Pr15ProbeResult) => void | Promise<void>;
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
  const callPlan = estimatePr15Calls(options.replays, options.contract, seeds, profiles.length, retryPolicy.max_retries);
  assertSpendApproval(options.spend_approval, callPlan);
  const clock = options.now ?? (() => new Date());
  const sleeper = options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const started = clock();
  const results: Pr15ProbeResult[] = [];
  const persistedProfiles: Pr15PersistedProfile[] = [];
  const resumeResults = validateResumeResults(options.resume_results ?? [], options.replays, profiles, seeds,
    options.contract);
  const costTelemetry: Pr15CostTelemetry = options.budget_state
    ? { ...options.budget_state } : { actual_usd: 0, reserved_usd: 0 };
  if (![costTelemetry.actual_usd, costTelemetry.reserved_usd].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Invalid PR-15 resume budget state; no model calls made.");
  }

  for (const profile of profiles) {
    const prior = resumeResults.filter((item) => item.model_profile === profile.definition.model_profile);
    const priorProfileCost = sumUsd(prior.map((item) => item.provider_cost_usd));
    const telemetry: Pr15RetryTelemetry = {
      total_retries: prior.reduce((sum, item) => sum + item.retry_count, 0),
      total_provider_attempts: prior.reduce((sum, item) => sum + item.provider_attempt_count, 0),
    };
    const profileCostBefore = costTelemetry.actual_usd;
    const budgetedClient = withBudget(withRequestCompatibility(profile.client,
      profile.definition.request_compatibility), options.pricing_basis.models,
      options.spend_approval.max_usd, costTelemetry, options.on_budget_event);
    const client = withRetries(budgetedClient, retryPolicy, telemetry, sleeper);
    const judgeClient = profile.judge_client === profile.client
      && canonicalJson(profile.definition.request_compatibility ?? defaultRequestCompatibility())
        === canonicalJson(profile.definition.judge_request_compatibility ?? defaultRequestCompatibility())
      ? client : withRetries(withBudget(withRequestCompatibility(profile.judge_client,
        profile.definition.judge_request_compatibility), options.pricing_basis.models,
        options.spend_approval.max_usd, costTelemetry, options.on_budget_event), retryPolicy, telemetry, sleeper);
    const run = await runPr15Benchmark(options.replays, {
      client,
      model: profile.definition.model_revision,
      model_profile: profile.definition.model_profile,
      judgeClient,
      judgeModel: profile.definition.judge_model_revision,
      seeds,
      temperature: profile.definition.temperature,
      max_completion_tokens: profile.definition.max_completion_tokens,
      reasoning_effort: profile.definition.reasoning_effort,
      judge_max_completion_tokens: profile.definition.judge_max_completion_tokens,
      judge_reasoning_effort: profile.definition.judge_reasoning_effort,
      retryCount: () => telemetry.total_retries,
      providerAttemptCount: () => telemetry.total_provider_attempts,
      providerCostUsd: () => costTelemetry.actual_usd,
      existing_results: prior,
      onResult: options.on_result,
      contract: options.contract,
    });
    results.push(...run.results);
    persistedProfiles.push({ ...profile.definition, total_retries: telemetry.total_retries,
      total_provider_attempts: telemetry.total_provider_attempts,
      actual_usd: roundUsd(priorProfileCost + costTelemetry.actual_usd - profileCostBefore) });
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
    execution_contract_digest: assertDigest(options.execution_contract_digest),
    corpus_digest: corpusDigest(options.replays),
    fixtures: fixtureIdentities(options.replays),
    seeds,
    retry_policy: { ...retryPolicy },
    spend_approval: { ...options.spend_approval },
    spend_actual_usd: roundUsd(costTelemetry.actual_usd),
    spend_unsettled_reservations_usd: roundUsd(costTelemetry.reserved_usd),
    call_plan: callPlan,
    profiles: persistedProfiles,
    accepted_subgroup_regressions: accepted,
    summary: summarizePr15(results, options.contract, accepted),
    results,
  };
  return { ...body, receipt_digest: digest(canonicalJson(body)) };
}

function validateResumeResults(
  input: readonly Pr15ProbeResult[],
  replays: readonly FrozenPr15Replay[],
  profiles: readonly Pr15ExecutableProfile[],
  seeds: number,
  contract: Pr15Contract,
): Pr15ProbeResult[] {
  const fixtures = new Map(replays.map((replay) => [replay.id, replay]));
  const definitions = new Map(profiles.map((profile) => [profile.definition.model_profile, profile.definition]));
  const seen = new Set<string>();
  for (const item of input) {
    const replay = fixtures.get(item.fixture_id);
    const definition = definitions.get(item.model_profile);
    const probe = replay?.probes.find((candidate) => candidate.id === item.probe_id);
    const key = `${item.model_profile}\0${item.fixture_id}\0${item.probe_id}\0${item.arm}\0${item.seed}`;
    if (!replay || !probe || !definition || !contract.arms.includes(item.arm)
      || item.fixture_digest !== replay.fixture_digest || item.model !== definition.model_revision
      || item.judge_model !== definition.judge_model_revision || !Number.isSafeInteger(item.seed)
      || item.seed < 1 || item.seed > seeds || seen.has(key)
      || !Number.isSafeInteger(item.retry_count) || item.retry_count < 0
      || !Number.isSafeInteger(item.provider_attempt_count) || item.provider_attempt_count < 1
      || !Number.isFinite(item.provider_cost_usd) || item.provider_cost_usd < 0) {
      throw new Error("Invalid PR-15 resume journal; no model calls made.");
    }
    seen.add(key);
  }
  return [...input];
}

export async function readPr15ExecutionContract(path: string): Promise<Pr15ExecutionContract> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid PR-15 execution contract: object_required.");
  const value = parsed as Pr15ExecutionContract;
  if (value.schema_version !== PR15_EXECUTION_CONTRACT_VERSION || !value.contract_id?.trim()
    || !Number.isFinite(Date.parse(value.frozen_at)) || value.provider_client?.package !== "openai"
    || !/^\d+\.\d+\.\d+$/.test(value.provider_client.version)
    || !["formal_reproducible", "contemporary_screen"].includes(value.cohort_class)
    || !["dated_snapshot", "provider_alias_observed"].includes(value.model_identity_policy)
    || !Number.isSafeInteger(value.seeds) || value.seeds < 1
    || !Array.isArray(value.profiles) || value.profiles.length !== 2
    || value.pricing_basis?.currency !== "USD" || value.pricing_basis?.unit !== "per_1m_tokens"
    || !Number.isFinite(Date.parse(value.pricing_basis.observed_at))
    || !value.pricing_basis.models || Object.values(value.pricing_basis.models).some((price) =>
      !Number.isFinite(price.input) || price.input < 0 || !Number.isFinite(price.output) || price.output < 0)
    || !Array.isArray(value.source_urls) || value.source_urls.some((item) => typeof item !== "string" || !item.startsWith("https://"))
    || !Array.isArray(value.limitations) || value.limitations.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Invalid PR-15 execution contract: shape_or_version.");
  }
  assertRetryPolicy(value.retry_policy);
  assertProfileDefinitions(value.profiles);
  if (value.model_identity_policy === "provider_alias_observed") {
    if (value.cohort_class !== "contemporary_screen" || !value.provider_catalog
      || !value.provider_catalog.url.startsWith("https://")
      || !Number.isFinite(Date.parse(value.provider_catalog.observed_at))
      || !/^sha256:[0-9a-f]{64}$/.test(value.provider_catalog.digest)) {
      throw new Error("Invalid PR-15 execution contract: unbound_provider_alias.");
    }
  } else if (value.cohort_class !== "formal_reproducible") {
    throw new Error("Invalid PR-15 execution contract: snapshot_cohort_class.");
  }
  for (const profile of value.profiles) {
    const identityValid = value.model_identity_policy === "dated_snapshot"
      ? /-\d{4}-\d{2}-\d{2}$/.test(profile.model_revision)
        && /-\d{4}-\d{2}-\d{2}$/.test(profile.judge_model_revision)
        && profile.model_revision !== profile.model && profile.judge_model_revision !== profile.judge_model
      : profile.model_revision === profile.model && profile.judge_model_revision === profile.judge_model;
    if (!identityValid
      || !value.pricing_basis.models[profile.model_revision]
      || !value.pricing_basis.models[profile.judge_model_revision]) {
      throw new Error("Invalid PR-15 execution contract: unbound_model_profile.");
    }
  }
  return value;
}

export async function verifyPr15ProviderCatalog(
  contract: Pr15ExecutionContract,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!contract.provider_catalog) return;
  const response = await fetcher(contract.provider_catalog.url);
  if (!response.ok) {
    throw new Error(`PR-15 provider catalog unavailable; no model calls made: HTTP ${response.status}.`);
  }
  let payload: unknown;
  try { payload = JSON.parse(await response.text()) as unknown; }
  catch { throw new Error("PR-15 provider catalog is invalid JSON; no model calls made."); }
  const records = Array.isArray(payload) ? payload : payload && typeof payload === "object"
    && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
  const expectedIds = [...new Set(contract.profiles.flatMap((profile) =>
    [profile.model_revision, profile.judge_model_revision]))].sort();
  const projection = expectedIds.map((id) => {
    const record = records.find((item) => item && typeof item === "object"
      && (item as { id?: unknown }).id === id) as { id?: unknown; object?: unknown; owned_by?: unknown } | undefined;
    if (!record || typeof record.object !== "string" || typeof record.owned_by !== "string") {
      throw new Error(`PR-15 provider catalog is missing ${id}; no model calls made.`);
    }
    return { id, object: record.object, owned_by: record.owned_by };
  });
  const actual = digest(canonicalJson(projection));
  if (actual !== contract.provider_catalog.digest) {
    throw new Error(`PR-15 provider catalog changed; no model calls made: expected `
      + `${contract.provider_catalog.digest}, found ${actual}. Freeze a new screening contract.`);
  }
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
  telemetry: Pr15RetryTelemetry,
  sleep: (milliseconds: number) => Promise<void>,
): LLMClient {
  assertRetryPolicy(policy);
  return { chat: { completions: { create: async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        telemetry.total_provider_attempts += 1;
        return await client.chat.completions.create(request);
      } catch (error) {
        if (!isTransient(error) || attempt >= policy.max_retries) throw error;
        telemetry.total_retries += 1;
        await sleep(policy.base_delay_ms * (2 ** attempt));
      }
    }
  } } } };
}

export function withRequestCompatibility(
  client: LLMClient,
  compatibility: Pr15RequestCompatibility = defaultRequestCompatibility(),
): LLMClient {
  assertRequestCompatibility(compatibility);
  return { chat: { completions: { create: async (request) => {
    const adapted: import("../../src/classifier.js").LLMRequest = { ...request };
    const tokenLimit = request.max_completion_tokens ?? request.max_tokens;
    delete adapted.max_completion_tokens;
    delete adapted.max_tokens;
    if (tokenLimit !== undefined) adapted[compatibility.token_limit_parameter] = tokenLimit;
    if (!compatibility.send_reasoning_effort) delete adapted.reasoning_effort;
    if (!compatibility.send_seed) delete adapted.seed;
    return client.chat.completions.create(adapted);
  } } } };
}

export function withBudget(
  client: LLMClient,
  prices: Record<string, { input: number; output: number }>,
  maxUsd: number,
  telemetry: Pr15CostTelemetry,
  onBudgetEvent?: (event: Pr15BudgetEvent) => void | Promise<void>,
): LLMClient {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || !Number.isFinite(telemetry.actual_usd) || telemetry.actual_usd < 0
    || !Number.isFinite(telemetry.reserved_usd) || telemetry.reserved_usd < 0) {
    throw new Error("Invalid PR-15 USD budget.");
  }
  return { chat: { completions: { create: async (request) => {
    const price = prices[request.model];
    if (!price || !Number.isFinite(price.input) || price.input < 0 || !Number.isFinite(price.output) || price.output < 0) {
      throw new Error(`Missing PR-15 token pricing for ${request.model}.`);
    }
    const maxCompletionTokens = request.max_completion_tokens ?? request.max_tokens;
    if (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens === undefined || maxCompletionTokens < 1) {
      throw new Error("PR-15 refuses an uncapped model request.");
    }
    const conservativeInputTokens = request.messages.reduce((sum, message) =>
      sum + Buffer.byteLength(message.role) + Buffer.byteLength(message.content) + 16, 16);
    const reservation = roundUsd((conservativeInputTokens * price.input
      + maxCompletionTokens * price.output) / 1_000_000);
    if (telemetry.actual_usd + telemetry.reserved_usd + reservation > maxUsd + Number.EPSILON) {
      throw new Error(`PR-15 hard USD ceiling reached before provider call: `
        + `$${telemetry.actual_usd.toFixed(6)} actual + $${telemetry.reserved_usd.toFixed(6)} unsettled`
        + ` + $${reservation.toFixed(6)} new > $${maxUsd.toFixed(2)} approved.`);
    }
    const reservationId = randomUUID();
    await onBudgetEvent?.({ type: "reservation", reservation_id: reservationId, usd: reservation });
    telemetry.reserved_usd = roundUsd(telemetry.reserved_usd + reservation);
    const reply = await client.chat.completions.create(request);
    const promptTokens = reply.usage?.prompt_tokens;
    const completionTokens = reply.usage?.completion_tokens;
    const actual = promptTokens === undefined || completionTokens === undefined
      ? reservation : roundUsd((promptTokens * price.input + completionTokens * price.output) / 1_000_000);
    await onBudgetEvent?.({ type: "settlement", reservation_id: reservationId, usd: actual });
    telemetry.reserved_usd = roundUsd(telemetry.reserved_usd - reservation);
    telemetry.actual_usd = roundUsd(telemetry.actual_usd + actual);
    return reply;
  } } } };
}

export function estimatePr15Calls(
  replays: readonly FrozenPr15Replay[],
  contract: Pr15Contract,
  seeds: number,
  profileCount = 2,
  maxRetries = 0,
): Pr15CallPlan {
  if (!Number.isSafeInteger(seeds) || seeds < 1 || !Number.isSafeInteger(profileCount) || profileCount < 1) {
    throw new Error("PR-15 call-plan seeds and profile count must be positive safe integers.");
  }
  const probes = replays.flatMap((replay) => replay.probes);
  const multiplier = contract.arms.length * seeds * profileCount;
  const modelCalls = probes.length * multiplier;
  const judgedProbes = probes.filter((probe) => {
    const wave7 = probe.wave7;
    if (!wave7) return false;
    return (wave7.expected_behavior === "answer" && probe.check.kind === "llm")
      || wave7.safety_invariant_check.kind === "llm"
      || wave7.repeated_dead_work_check?.kind === "llm"
      || wave7.missed_uncommitted_work_check?.kind === "llm";
  }).length;
  const maxJudgeCalls = judgedProbes * multiplier;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error("PR-15 call-plan retries must be a safe integer from 0 to 10.");
  }
  const maxTotalLogicalCalls = modelCalls + maxJudgeCalls;
  return { model_calls: modelCalls, max_judge_calls: maxJudgeCalls,
    max_total_logical_calls: maxTotalLogicalCalls,
    max_provider_attempts: maxTotalLogicalCalls * (maxRetries + 1) };
}

function assertProfiles(input: readonly Pr15ExecutableProfile[]): Pr15ExecutableProfile[] {
  const profiles = [...input];
  assertProfileDefinitions(profiles.map((profile) => profile.definition));
  return profiles;
}

function assertProfileDefinitions(input: readonly Pr15ExecutionProfile[]): void {
  if (input.length !== 2 || input[0]?.model_profile !== "primary" || input[1]?.model_profile !== "weak") {
    throw new Error("PR-15 execution requires exactly [primary, weak] model profiles in that order.");
  }
  for (const value of input) {
    if (![value.provider_id, value.provider_version, value.base_url, value.model, value.model_revision,
      value.judge_provider_id, value.judge_provider_version, value.judge_base_url, value.judge_model, value.judge_model_revision]
      .every((item) => typeof item === "string" && item.trim().length > 0)
      || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2
      || !Number.isSafeInteger(value.max_completion_tokens) || value.max_completion_tokens < 1
      || !Number.isSafeInteger(value.judge_max_completion_tokens) || value.judge_max_completion_tokens < 1
      || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoning_effort)
      || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.judge_reasoning_effort)) {
      throw new Error(`Invalid PR-15 ${value.model_profile} execution profile.`);
    }
    assertRequestCompatibility(value.request_compatibility ?? defaultRequestCompatibility());
    assertRequestCompatibility(value.judge_request_compatibility ?? defaultRequestCompatibility());
  }
  if (input[0]!.model_revision === input[1]!.model_revision
    && input[0]!.provider_id === input[1]!.provider_id) {
    throw new Error("PR-15 weak-model ablation must differ from the primary model/provider identity.");
  }
}

function defaultRequestCompatibility(): Pr15RequestCompatibility {
  return { token_limit_parameter: "max_completion_tokens", send_reasoning_effort: true, send_seed: true };
}

function assertRequestCompatibility(value: Pr15RequestCompatibility): void {
  if (!value || !["max_completion_tokens", "max_tokens"].includes(value.token_limit_parameter)
    || typeof value.send_reasoning_effort !== "boolean" || typeof value.send_seed !== "boolean") {
    throw new Error("Invalid PR-15 request compatibility profile.");
  }
}

function assertSpendApproval(approval: Pr15SpendApproval, plan: Pr15CallPlan): void {
  if (!approval || approval.max_logical_calls !== plan.max_total_logical_calls
    || approval.max_provider_attempts !== plan.max_provider_attempts
    || !Number.isFinite(approval.max_usd) || approval.max_usd <= 0) {
    throw new Error(`PR-15 spend is not approved; no model calls made. Exact approval required: `
      + `${plan.max_total_logical_calls} logical calls, ${plan.max_provider_attempts} provider attempts, and a positive USD ceiling.`);
  }
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
function assertDigest(value: string): string { if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error("Invalid PR-15 execution-contract digest."); return value; }
function roundUsd(value: number): number { return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000; }
function sumUsd(values: readonly number[]): number { return values.reduce((sum, value) => roundUsd(sum + value), 0); }

interface Pr15JournalBinding {
  schema_version: typeof PR15_JOURNAL_VERSION;
  benchmark_id: string;
  contract_digest: string;
  corpus_digest: string;
  execution_contract_digest: string;
  seeds: number;
  retry_policy: Pr15RetryPolicy;
  call_plan: Pr15CallPlan;
  spend_approval: Pr15SpendApproval;
  profiles: Pr15ExecutionProfile[];
}

async function readOrCreateJournal(path: string, binding: Pr15JournalBinding): Promise<{
  results: Pr15ProbeResult[]; budget: Pr15CostTelemetry;
}> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  const header = { type: "header", binding, binding_digest: digest(canonicalJson(binding)) };
  try {
    await writeFile(output, `${JSON.stringify(header)}\n`, { flag: "wx" });
    return { results: [], budget: { actual_usd: 0, reserved_usd: 0 } };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const lines = (await readFile(output, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("Invalid PR-15 resume journal: missing header.");
  const storedHeader = JSON.parse(lines[0]!) as typeof header;
  if (storedHeader.type !== "header" || storedHeader.binding_digest !== digest(canonicalJson(storedHeader.binding))
    || canonicalJson(storedHeader.binding) !== canonicalJson(binding)) {
    throw new Error("Invalid PR-15 resume journal: binding mismatch.");
  }
  const results: Pr15ProbeResult[] = [];
  const reservations = new Map<string, number>();
  let actualUsd = 0;
  for (const line of lines.slice(1)) {
    const record = JSON.parse(line) as Record<string, unknown>;
    const { record_digest: recordDigest, ...body } = record;
    if (recordDigest !== digest(canonicalJson(body))) throw new Error("Invalid PR-15 resume journal: record digest mismatch.");
    if (record.type === "result" && record.result) results.push(record.result as Pr15ProbeResult);
    else if (record.type === "reservation" && typeof record.reservation_id === "string"
      && typeof record.usd === "number" && Number.isFinite(record.usd) && record.usd >= 0
      && !reservations.has(record.reservation_id)) reservations.set(record.reservation_id, record.usd);
    else if (record.type === "settlement" && typeof record.reservation_id === "string"
      && typeof record.usd === "number" && Number.isFinite(record.usd) && record.usd >= 0
      && reservations.has(record.reservation_id)) {
      reservations.delete(record.reservation_id);
      actualUsd = roundUsd(actualUsd + record.usd);
    } else throw new Error("Invalid PR-15 resume journal: invalid record sequence.");
  }
  return { results, budget: { actual_usd: actualUsd,
    reserved_usd: sumUsd([...reservations.values()]) } };
}

async function appendJournalResult(path: string, result: Pr15ProbeResult): Promise<void> {
  await appendJournalRecord(path, { type: "result", result });
}

async function appendJournalBudgetEvent(path: string, event: Pr15BudgetEvent): Promise<void> {
  await appendJournalRecord(path, event);
}

async function appendJournalRecord(path: string, body: Record<string, unknown>): Promise<void> {
  await appendFile(resolve(path), `${JSON.stringify({ ...body, record_digest: digest(canonicalJson(body)) })}\n`,
    { encoding: "utf8" });
}

async function assertOutputAbsent(path: string): Promise<void> {
  try {
    await access(resolve(path));
    throw new Error(`PR-15 proof receipt already exists; no model calls made: ${resolve(path)}`);
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
  const outputPath = flag("out");
  const executionPath = flag("execution");
  if (!fixturesPath || !outputPath || !executionPath) throw new Error("Usage: pr15-execute.ts --fixtures <frozen-directory> --execution <execution-contract.json> --out <receipt.json> [--contract <json>]");
  const contract = await readPr15Contract(flag("contract") ? resolve(flag("contract")!) : undefined);
  const replays = await loadFrozenPr15Replays(resolve(fixturesPath));
  const readiness = evaluateCorpusReadiness(replays, contract);
  if (!readiness.ready_for_model_spend) {
    process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const execution = await readPr15ExecutionContract(executionPath);
  await verifyPr15ProviderCatalog(execution);
  const [primary, weak] = execution.profiles;
  const retryPolicy = execution.retry_policy;
  const callPlan = estimatePr15Calls(replays, contract, execution.seeds, 2, retryPolicy.max_retries);
  const spendApproval = { max_logical_calls: envInteger("SEEDROP_PR15_APPROVED_LOGICAL_CALLS", -1),
    max_provider_attempts: envInteger("SEEDROP_PR15_APPROVED_PROVIDER_ATTEMPTS", -1),
    max_usd: envPositiveNumber("SEEDROP_PR15_APPROVED_MAX_USD") };
  assertSpendApproval(spendApproval, callPlan);
  await assertOutputAbsent(outputPath);
  const executionContractDigest = digest(canonicalJson(execution));
  const journalPath = flag("journal") ?? `${outputPath}.journal.jsonl`;
  const journal = await readOrCreateJournal(journalPath, {
    schema_version: PR15_JOURNAL_VERSION,
    benchmark_id: contract.benchmark_id,
    contract_digest: digest(canonicalJson(contract)),
    corpus_digest: corpusDigest(replays),
    execution_contract_digest: executionContractDigest,
    seeds: execution.seeds,
    retry_policy: retryPolicy,
    call_plan: callPlan,
    spend_approval: spendApproval,
    profiles: execution.profiles,
  });
  const { default: OpenAI } = (await import("openai" as string).catch(() => {
    throw new Error(`Install the frozen PR-15 client: npm install --no-save openai@${execution.provider_client.version}`);
  })) as { default: new (config: { apiKey: string; baseURL: string }) => LLMClient };
  const installedVersion = ((await import("openai/version" as string)) as { VERSION?: string }).VERSION;
  if (installedVersion !== execution.provider_client.version) {
    throw new Error(`PR-15 provider client mismatch: expected openai@${execution.provider_client.version}, found ${installedVersion ?? "unknown"}.`);
  }
  const makeExecutable = (definition: Pr15ExecutionProfile, prefix: "PRIMARY" | "WEAK"): Pr15ExecutableProfile => {
    const apiKey = requireEnv(`SEEDROP_PR15_${prefix}_API_KEY`);
    const judgeApiKey = process.env[`SEEDROP_PR15_${prefix}_JUDGE_API_KEY`] ?? apiKey;
    const client = new OpenAI({ apiKey, baseURL: definition.base_url });
    const judgeClient = definition.judge_base_url === definition.base_url && judgeApiKey === apiKey
      ? client : new OpenAI({ apiKey: judgeApiKey, baseURL: definition.judge_base_url });
    return { definition, client, judge_client: judgeClient };
  };
  process.stdout.write(`PR-15 readiness and spend approval passed. Call ceiling: ${callPlan.model_calls} model + ${callPlan.max_judge_calls} batched judge = ${callPlan.max_total_logical_calls} logical; ${callPlan.max_provider_attempts} provider attempts including retries.\n`);
  const receipt = await executePr15Proof({ replays, contract,
    profiles: [makeExecutable(primary!, "PRIMARY"), makeExecutable(weak!, "WEAK")], seeds: execution.seeds,
    retry_policy: retryPolicy, spend_approval: spendApproval,
    pricing_basis: execution.pricing_basis, execution_contract_digest: executionContractDigest,
    resume_results: journal.results, budget_state: journal.budget,
    on_budget_event: async (event) => appendJournalBudgetEvent(journalPath, event),
    on_result: async (result) => appendJournalResult(journalPath, result) });
  await writePr15ProofReceipt(outputPath, receipt);
  process.stdout.write(`${JSON.stringify({ receipt: resolve(outputPath), receipt_digest: receipt.receipt_digest,
    gate_passed: receipt.summary.gate_passed, results: receipt.results.length }, null, 2)}\n`);
}

function requireEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing required env var: ${name}`); return value; }
function envInteger(name: string, fallback: number): number { const value = Number(process.env[name] ?? String(fallback)); if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`); return value; }
function envPositiveNumber(name: string): number { const value = Number(process.env[name] ?? "NaN"); if (!Number.isFinite(value) || value <= 0) return NaN; return value; }

if (process.argv[1] && process.argv[1].endsWith("pr15-execute.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
