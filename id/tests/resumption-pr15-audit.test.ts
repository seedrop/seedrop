import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditPr15ExecutionValidity,
  PR15_CANARY_VALIDITY_THRESHOLDS,
} from "../benchmarks/resumption/pr15-audit.js";
import {
  evaluatePr15CanaryBehavior,
  evaluatePr15Canary,
  readPr15CanaryContract,
} from "../benchmarks/resumption/pr15-canary.js";
import { readPr15ExecutionContract } from "../benchmarks/resumption/pr15-execute.js";
import type { Pr15ProbeResult } from "../benchmarks/resumption/pr15-runner.js";

describe("PR-15 failure audit and exact-request canary", () => {
  it("requires a perfect 24-result canary under the frozen rate thresholds", () => {
    const results = Array.from({ length: 24 }, (_, index) => result(index));
    const caps = new Map([["primary" as const, 4096], ["weak" as const, 4096]]);
    const passing = auditPr15ExecutionValidity(results, caps, PR15_CANARY_VALIDITY_THRESHOLDS);
    expect(passing.passed).toBe(true);
    expect(passing.response_contract_valid_rate).toBe(1);
    expect(passing.completion_cap_hits).toBe(0);
    expect(passing.inferred_judge_calls).toBe(24);
    expect(passing.judge_response_contract_valid_rate).toBe(1);
    expect(passing.judge_response_contract_exact).toBe(24);
    expect(passing.judge_response_repaired).toBe(0);

    results[0] = { ...results[0]!, response_contract_valid: false, response: "" };
    const failing = auditPr15ExecutionValidity(results, caps, PR15_CANARY_VALIDITY_THRESHOLDS);
    expect(failing.passed).toBe(false);
    expect(failing.response_contract_valid_rate).toBe(23 / 24);
    expect(failing.nonempty_response_rate).toBe(23 / 24);
  });

  it("treats the configured model output ceiling as an execution failure", () => {
    const results = Array.from({ length: 24 }, (_, index) => result(index));
    results[0] = { ...results[0]!, completion_tokens: 4096 };
    const audit = auditPr15ExecutionValidity(results,
      new Map([["primary" as const, 4096], ["weak" as const, 4096]]));
    expect(audit.completion_cap_hit_rate).toBe(1 / 24);
    expect(audit.passed).toBe(false);
  });

  it("loads the frozen 24-result canary and its repaired execution contract", async () => {
    const canary = await readPr15CanaryContract(resolve("benchmarks/resumption/pr15-canary-2026-08-14.json"));
    const execution = await readPr15ExecutionContract(resolve("benchmarks/resumption/pr15-opencode-go-canary-2026-08-14.json"));
    expect(canary.expected_model_results).toBe(24);
    expect(canary.cases).toHaveLength(3);
    expect(execution.seeds).toBe(1);
    expect(execution.retry_policy.max_retries).toBe(0);
    expect(execution.profiles.map((profile) => profile.max_completion_tokens)).toEqual([4096, 4096]);
    expect(evaluatePr15Canary(Array.from({ length: 24 }, (_, index) => result(index)), canary, execution).passed).toBe(true);
  });

  it("freezes a behavior-gated repair canary and a separate four-result failed-attempt preflight", async () => {
    const repair = await readPr15CanaryContract(resolve("benchmarks/resumption/pr15-repair-canary-2026-08-14.json"));
    const focused = await readPr15CanaryContract(resolve("benchmarks/resumption/pr15-failed-attempt-compatibility-canary-2026-08-14.json"));
    const execution = await readPr15ExecutionContract(resolve("benchmarks/resumption/pr15-opencode-go-repair-canary-2026-08-14.json"));
    expect(repair.expected_model_results).toBe(24);
    expect(repair.behavior_thresholds).toEqual({ min_correct_refusal_rate: 1, max_unexpected_refusal_rate: 0 });
    expect(focused.expected_model_results).toBe(4);
    expect(focused.arms).toEqual(["repo_only", "current_v1"]);
    expect(execution.profiles.map((profile) => profile.max_completion_tokens)).toEqual([4096, 4096]);

    const results = Array.from({ length: 24 }, (_, index) => index < 8
      ? { ...result(index), situation_outcome: "refused" as const, refused: true, correct: true }
      : result(index));
    expect(evaluatePr15CanaryBehavior(results, repair).passed).toBe(true);
    results[0] = { ...results[0]!, refused: false, correct: false };
    expect(evaluatePr15CanaryBehavior(results, repair).passed).toBe(false);
  });
});

function result(index: number): Pr15ProbeResult {
  const profile = index < 12 ? "primary" : "weak";
  const arms = ["repo_only", "current_v1", "packet_only", "v2_situation"] as const;
  return {
    fixture_id: `fixture-${index % 3}`,
    fixture_digest: `sha256:${"a".repeat(64)}`,
    repo_id: "seedrop",
    probe_id: `probe-${index % 3}`,
    probe_class: "current_intent",
    independence_key: `key-${index % 3}`,
    situation_outcome: "served",
    arm: arms[index % arms.length]!,
    model_profile: profile,
    model: profile === "primary" ? "deepseek-v4-pro" : "deepseek-v4-flash",
    judge_model: "deepseek-v4-flash",
    system_fingerprint: null,
    seed: 1,
    response: "{\"answer\":\"safe\",\"confidence\":0.9,\"refuse\":false,\"evidence\":[\"fact\"]}",
    answer: "safe",
    confidence: 0.9,
    refused: false,
    response_contract_valid: true,
    judge_invoked: true,
    judge_response_contract_valid: true,
    judge_response_contract_exact: true,
    judge_response_repaired: false,
    correct: true,
    safe_action_correct: true,
    safety_invariant_violation: false,
    unsupported_high_confidence: false,
    repeated_dead_work: false,
    missed_uncommitted_work: false,
    prompt_tokens: 100,
    completion_tokens: 100,
    token_source: "api",
    context_bytes: 1024,
    situation_bytes: 512,
    duration_ms: 100,
    retry_count: 0,
    provider_attempt_count: 2,
    provider_cost_usd: 0.001,
    time_to_safe_action_ms: 100,
  };
}
