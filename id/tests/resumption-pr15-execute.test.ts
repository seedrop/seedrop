import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMClient, LLMRequest } from "../src/classifier.js";
import {
  assertPr15ProofReceipt,
  estimatePr15Calls,
  executePr15Proof,
  readPr15ExecutionContract,
  verifyPr15ProviderCatalog,
  withBudget,
  withRequestCompatibility,
  withRetries,
  writePr15ProofReceipt,
  type Pr15ExecutableProfile,
} from "../benchmarks/resumption/pr15-execute.js";
import { readPr15Contract, type Pr15Contract, type Pr15ProbeClass } from "../benchmarks/resumption/readiness.js";
import { freezePr15Replay, type Pr15ReplayInput } from "../benchmarks/resumption/replay.js";
import { boundedSituation, servedReplayInput } from "./pr15-served-fixture.js";
import type { ProjectTransactionDigest } from "@seedrop/situation";

const classes: Pr15ProbeClass[] = [
  "current_intent", "unsafe_condition", "delivery_state", "relevant_failed_attempt", "evidence_gap", "safest_next_action",
];

describe("PR-15 controlled proof execution", () => {
  it("loads the checked-in dated-snapshot execution contract", async () => {
    const contract = await readPr15ExecutionContract(resolve("benchmarks/resumption/pr15-openai-2026-08-13.json"));
    expect(contract.profiles.map((item) => item.model_revision)).toEqual([
      "gpt-5.5-2026-04-23", "gpt-5.4-nano-2026-03-17",
    ]);
    expect(contract.profiles.every((item) => item.model_revision !== item.model)).toBe(true);
    expect(contract.cohort_class).toBe("formal_reproducible");
    expect(contract.limitations).toHaveLength(4);
  });

  it("loads the catalog-bound OpenCode Go screening contract", async () => {
    const contract = await readPr15ExecutionContract(resolve("benchmarks/resumption/pr15-opencode-go-2026-08-13.json"));
    expect(contract.cohort_class).toBe("contemporary_screen");
    expect(contract.model_identity_policy).toBe("provider_alias_observed");
    expect(contract.provider_catalog?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contract.profiles.map((item) => item.model_revision)).toEqual([
      "deepseek-v4-pro", "deepseek-v4-flash",
    ]);
    await expect(verifyPr15ProviderCatalog(contract, async () => new Response(JSON.stringify({ data: [
      { id: "deepseek-v4-pro", object: "model", owned_by: "changed" },
      { id: "deepseek-v4-flash", object: "model", owned_by: "changed" },
    ] }))))
      .rejects.toThrow(/catalog changed; no model calls made/);
  });

  it("makes zero model calls when the corpus readiness gate fails", async () => {
    let calls = 0;
    const client = responseClient(() => { calls += 1; return validResponse(false); });
    await expect(executePr15Proof({ replays: [freezePr15Replay(fixture(0))], contract: await readPr15Contract(),
      profiles: profiles(client, client), spend_approval: { max_logical_calls: 0, max_provider_attempts: 0, max_usd: 1 },
      pricing_basis: testPricing, execution_contract_digest: testExecutionDigest }))
      .rejects.toThrow(/no model calls made/);
    expect(calls).toBe(0);
  });

  it("makes zero model calls without an exact spend approval", async () => {
    const contract = relaxedContract(await readPr15Contract());
    const replays = classes.map((_, index) => freezePr15Replay(fixture(index)));
    let calls = 0;
    const client = responseClient(() => { calls += 1; return validResponse(false); });
    await expect(executePr15Proof({ replays, contract, profiles: profiles(client, client), seeds: 1,
      retry_policy: { max_retries: 1, base_delay_ms: 0 },
      spend_approval: { max_logical_calls: 48, max_provider_attempts: 95, max_usd: 1 },
      pricing_basis: testPricing, execution_contract_digest: testExecutionDigest }))
      .rejects.toThrow(/48 logical calls, 96 provider attempts/);
    expect(calls).toBe(0);
  });

  it("executes pinned primary and weak profiles and seals an exclusive receipt", async () => {
    const contract = relaxedContract(await readPr15Contract());
    const replays = classes.map((_, index) => freezePr15Replay(fixture(index)));
    let calls = 0;
    let failedOnce = false;
    const requests: LLMRequest[] = [];
    const client = responseClient((request) => {
      calls += 1;
      requests.push(request);
      if (!failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error("transient provider failure"), { status: 503 });
      }
      return validResponse(request.messages[1]!.content.includes("REFUSE"));
    });
    const times = [new Date("2026-08-13T00:00:00.000Z"), new Date("2026-08-13T00:00:01.000Z")];
    const receipt = await executePr15Proof({ replays, contract, profiles: profiles(client, client), seeds: 1,
      retry_policy: { max_retries: 1, base_delay_ms: 0 },
      spend_approval: { max_logical_calls: 48, max_provider_attempts: 96, max_usd: 1 },
      pricing_basis: testPricing, execution_contract_digest: testExecutionDigest,
      now: () => times.shift()!, sleep: async () => undefined });

    expect(calls).toBe(49);
    expect(receipt.results).toHaveLength(48);
    expect(receipt.fixtures).toHaveLength(6);
    expect(receipt.profiles.map((item) => item.model_profile)).toEqual(["primary", "weak"]);
    expect(receipt.profiles.map((item) => item.total_retries)).toEqual([1, 0]);
    expect(receipt.profiles.map((item) => item.total_provider_attempts)).toEqual([25, 24]);
    expect(receipt.results.filter((item) => item.retry_count === 1)).toHaveLength(1);
    expect(receipt.elapsed_ms).toBe(1_000);
    expect(receipt.spend_approval).toEqual({ max_logical_calls: 48, max_provider_attempts: 96, max_usd: 1 });
    expect(receipt.spend_actual_usd).toBeGreaterThan(0);
    expect(receipt.call_plan.max_provider_attempts).toBe(96);
    expect(new Set(requests.map((item) => item.model))).toEqual(new Set(["primary-rev-1", "weak-rev-1"]));
    expect(requests.every((item) => item.max_completion_tokens === 512 && item.reasoning_effort === "none")).toBe(true);
    expect(receipt.receipt_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => assertPr15ProofReceipt(receipt)).not.toThrow();

    const root = await mkdtemp(join(tmpdir(), "seedrop-pr15-receipt-"));
    const output = join(root, "proof.json");
    await writePr15ProofReceipt(output, receipt);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(receipt);
    await expect(writePr15ProofReceipt(output, receipt)).rejects.toMatchObject({ code: "EEXIST" });
    const changed = JSON.parse(JSON.stringify(receipt)) as typeof receipt;
    changed.results[0]!.answer = "tampered";
    expect(() => assertPr15ProofReceipt(changed)).toThrow(/digest_mismatch/);

    const callsBeforeResume = calls;
    const resumed = await executePr15Proof({ replays, contract, profiles: profiles(client, client), seeds: 1,
      retry_policy: { max_retries: 1, base_delay_ms: 0 },
      spend_approval: { max_logical_calls: 48, max_provider_attempts: 96, max_usd: 1 },
      pricing_basis: testPricing, execution_contract_digest: testExecutionDigest, resume_results: receipt.results,
      budget_state: { actual_usd: receipt.spend_actual_usd,
        reserved_usd: receipt.spend_unsettled_reservations_usd },
      now: () => new Date("2026-08-13T00:00:02.000Z") });
    expect(calls).toBe(callsBeforeResume);
    expect(resumed.results).toEqual(receipt.results);
    expect(resumed.profiles.map((item) => item.total_provider_attempts)).toEqual([25, 24]);
    expect(resumed.profiles.map((item) => item.actual_usd)).toEqual(receipt.profiles.map((item) => item.actual_usd));
  });

  it("persists deterministic transient retry counts", async () => {
    let calls = 0;
    const raw = responseClient(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return validResponse(false);
    });
    const telemetry = { total_retries: 0, total_provider_attempts: 0 };
    const delays: number[] = [];
    const client = withRetries(raw, { max_retries: 2, base_delay_ms: 10 }, telemetry,
      async (milliseconds) => { delays.push(milliseconds); });
    await client.chat.completions.create({ model: "m", messages: [], temperature: 0 });
    expect(calls).toBe(2);
    expect(telemetry.total_retries).toBe(1);
    expect(telemetry.total_provider_attempts).toBe(2);
    expect(delays).toEqual([10]);
  });

  it("adapts the frozen request to the proven OpenCode-compatible parameter shape", async () => {
    const requests: LLMRequest[] = [];
    const client = withRequestCompatibility(responseClient((request) => {
      requests.push(request);
      return validResponse(false);
    }), { token_limit_parameter: "max_tokens", send_reasoning_effort: false, send_seed: false });
    await client.chat.completions.create({ model: "deepseek-v4-flash", messages: [], temperature: 0,
      max_completion_tokens: 256, reasoning_effort: "none", seed: 5 });
    expect(requests).toEqual([{ model: "deepseek-v4-flash", messages: [], temperature: 0, max_tokens: 256 }]);
  });

  it("enforces the approved USD ceiling before a provider call", async () => {
    let calls = 0;
    const client = responseClient(() => { calls += 1; return validResponse(false); });
    const budgeted = withBudget(client, { model: { input: 1_000, output: 1_000 } }, 0.01,
      { actual_usd: 0, reserved_usd: 0 });
    await expect(budgeted.chat.completions.create({ model: "model", messages: [{ role: "user", content: "large" }],
      max_completion_tokens: 100, reasoning_effort: "none" })).rejects.toThrow(/hard USD ceiling reached/);
    expect(calls).toBe(0);
  });

  it("writes a conservative reservation before the provider call and settles usage afterward", async () => {
    const events: Array<{ type: string; usd: number }> = [];
    const telemetry = { actual_usd: 0, reserved_usd: 0 };
    const client = withBudget(responseClient(() => validResponse(false)), { model: { input: 1, output: 2 } },
      1, telemetry, async (event) => { events.push(event); });
    await client.chat.completions.create({ model: "model", messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 10, reasoning_effort: "none" });
    expect(events.map((item) => item.type)).toEqual(["reservation", "settlement"]);
    expect(events[0]!.usd).toBeGreaterThan(events[1]!.usd);
    expect(telemetry.reserved_usd).toBe(0);
    expect(telemetry.actual_usd).toBe(events[1]!.usd);
  });

  it("retains an unsettled reservation when the provider outcome is unknown", async () => {
    const events: Array<{ type: string; usd: number }> = [];
    const telemetry = { actual_usd: 0, reserved_usd: 0 };
    const failing: LLMClient = { chat: { completions: { create: async () => { throw new Error("connection lost"); } } } };
    const client = withBudget(failing, { model: { input: 1, output: 2 } }, 1, telemetry,
      async (event) => { events.push(event); });
    await expect(client.chat.completions.create({ model: "model", messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 10, reasoning_effort: "none" })).rejects.toThrow(/connection lost/);
    expect(events.map((item) => item.type)).toEqual(["reservation"]);
    expect(telemetry.reserved_usd).toBe(events[0]!.usd);
    expect(telemetry.actual_usd).toBe(0);
  });

  it("preflights the maximum logical call matrix", async () => {
    const contract = relaxedContract(await readPr15Contract());
    const candidate = fixture(0);
    candidate.probes[0]!.wave7!.safety_invariant_check = { kind: "llm", question: "Is it safe?", correct_answer: "YES" };
    const replay = freezePr15Replay(candidate);
    const plan = estimatePr15Calls([replay], contract, 5, 2);
    expect(plan).toEqual({ model_calls: 40, max_judge_calls: 40, max_total_logical_calls: 80,
      max_provider_attempts: 80 });
  });
});

function profiles(primaryClient: LLMClient, weakClient: LLMClient): Pr15ExecutableProfile[] {
  return [
    { definition: { model_profile: "primary", provider_id: "provider-a", provider_version: "2026-08-01",
      base_url: "https://a.invalid/v1", model: "primary-model", model_revision: "primary-rev-1",
      judge_provider_id: "provider-a", judge_provider_version: "2026-08-01", judge_base_url: "https://a.invalid/v1",
      judge_model: "judge-model", judge_model_revision: "judge-rev-1", temperature: 0,
      max_completion_tokens: 512, reasoning_effort: "none", judge_max_completion_tokens: 256,
      judge_reasoning_effort: "none" },
      client: primaryClient, judge_client: primaryClient },
    { definition: { model_profile: "weak", provider_id: "provider-a", provider_version: "2026-08-01",
      base_url: "https://a.invalid/v1", model: "weak-model", model_revision: "weak-rev-1",
      judge_provider_id: "provider-a", judge_provider_version: "2026-08-01", judge_base_url: "https://a.invalid/v1",
      judge_model: "judge-model", judge_model_revision: "judge-rev-1", temperature: 0,
      max_completion_tokens: 512, reasoning_effort: "none", judge_max_completion_tokens: 256,
      judge_reasoning_effort: "none" },
      client: weakClient, judge_client: weakClient },
  ];
}

function responseClient(response: (request: LLMRequest) => string): LLMClient {
  return { chat: { completions: { create: async (request) => ({ choices: [{ message: { content: response(request) } }],
    usage: { prompt_tokens: 20, completion_tokens: 8 } } as never) } } };
}

function validResponse(refuse: boolean): string {
  return JSON.stringify({ answer: "safe frozen action", confidence: refuse ? 0.2 : 0.9, refuse, evidence: ["frozen fact"] });
}

function relaxedContract(contract: Pr15Contract): Pr15Contract {
  return { ...contract, corpus_readiness: { ...contract.corpus_readiness, min_independent_ground_truths: 6,
    min_repositories: 1, max_single_repository_share: 1, min_per_probe_class: 1,
    min_successful_situation_fixtures: 1, min_explicit_refusal_fixtures: 1 } };
}

function fixture(index: number): Pr15ReplayInput {
  const hash = index.toString(16);
  const refused = index === 1;
  const id = digest(hash) as ProjectTransactionDigest;
  const bounded = boundedSituation({
    situation_id: id,
    decision_id: id,
    orientation: {
      next_action: refused
        ? { disposition: "refuse", reason: "insufficient evidence", smallest_repair: "inspect evidence" }
        : { disposition: "recommend", action: "safe frozen action" },
    },
  });
  const probeClass = classes[index]!;
  return servedReplayInput({
    fixture_id: `fixture-${index}`,
    scenario: `scenario-${index}`,
    repository: { repo_id: "seedrop", commit: hash.repeat(40), evidence_cutoff: "2026-08-13T00:00:00.000Z", source_digest: id },
    evidence: { repo_only: `repo evidence ${index}`, current_v1: `v1 evidence ${index}` },
    probes: [{ id: `probe-${index}`, question: refused ? "REFUSE safely" : "ANSWER safely",
      check: { kind: "regex", pattern: "safe", correct_when: "matches" },
      wave7: { probe_class: probeClass, independence_key: `key-${index}`, ground_truth_source_digest: id,
        ground_truth_observed_at: "2026-08-12T00:00:00.000Z", expected_behavior: refused ? "refuse" : "answer",
        safety_invariant_check: { kind: "regex", pattern: "safe", correct_when: "matches" },
        task_linked: probeClass === "safest_next_action" ? true : undefined } }],
    sanitation: { reviewed_by: "reviewer", reviewed_at: "2026-08-13T00:30:00.000Z", scanner: "gitleaks",
      command: "gitleaks detect --no-git", status: "passed", source_set_digest: id, excluded_secret_paths: [] },
  }, bounded);
}

function digest(letter: string): string { return `sha256:${letter.repeat(64)}`; }

const testExecutionDigest = `sha256:${"a".repeat(64)}`;
const testPricing = { currency: "USD" as const, unit: "per_1m_tokens" as const,
  observed_at: "2026-08-13T00:00:00.000Z",
  models: { "primary-rev-1": { input: 1, output: 1 }, "weak-rev-1": { input: 1, output: 1 },
    "judge-rev-1": { input: 1, output: 1 } } };
