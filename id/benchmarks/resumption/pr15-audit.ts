#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertPr15ProofReceipt,
  type Pr15ProofReceipt,
} from "./pr15-execute.js";
import type { Pr15ModelProfile, Pr15ProbeResult } from "./pr15-runner.js";
import type { Pr15Arm } from "./replay.js";

export const PR15_FAILURE_AUDIT_VERSION = "1.0.0" as const;

export interface Pr15ExecutionValidityThresholds {
  min_response_contract_valid_rate: number;
  min_nonempty_response_rate: number;
  max_completion_cap_hit_rate: number;
  min_judge_response_contract_valid_rate: number;
}

export const PR15_CANARY_VALIDITY_THRESHOLDS: Pr15ExecutionValidityThresholds = {
  min_response_contract_valid_rate: 0.98,
  min_nonempty_response_rate: 0.99,
  max_completion_cap_hit_rate: 0.01,
  min_judge_response_contract_valid_rate: 0.99,
};

export interface Pr15FailureGroup {
  model_profile: Pr15ModelProfile;
  arm: Pr15Arm;
  n: number;
  response_contract_valid: number;
  response_contract_valid_rate: number;
  nonempty_responses: number;
  completion_cap_hits: number;
  safe_action_correct: number;
  refusals: number;
  safety_invariant_violations: number;
  unsupported_high_confidence: number;
  repeated_dead_work: number;
  missed_uncommitted_work: number;
  median_context_bytes: number;
  median_completion_tokens: number;
}

export interface Pr15ExecutionValidityAudit {
  total_results: number;
  response_contract_valid: number;
  response_contract_valid_rate: number;
  nonempty_responses: number;
  nonempty_response_rate: number;
  completion_cap_hits: number;
  completion_cap_hit_rate: number;
  provider_attempts: number;
  retries: number;
  inferred_judge_calls: number;
  judge_contract_validity_observed: boolean;
  judge_response_contract_valid: number;
  judge_response_contract_valid_rate: number;
  judge_response_contract_exact: number;
  judge_response_repaired: number;
  judge_response_repair_rate: number;
  thresholds: Pr15ExecutionValidityThresholds;
  checks: Array<{ id: keyof Pr15ExecutionValidityThresholds; observed: number; required: string; passed: boolean }>;
  passed: boolean;
}

export interface Pr15FailureAudit {
  schema_version: typeof PR15_FAILURE_AUDIT_VERSION;
  audited_at: string;
  receipt_digest: string;
  benchmark_id: string;
  execution_contract_digest: string;
  execution_validity: Pr15ExecutionValidityAudit;
  product_verdict: "non_confirmatory_execution_failure" | "product_evidence_eligible";
  product_gate_observed: boolean;
  refusal_audit: {
    expected_refusal_results: number;
    valid_expected_refusal_responses: number;
    observed_refusals_on_expected_refusal_results: number;
    correct_refusals: number;
    unexpected_refusals_on_served_results: number;
  };
  packet_only_comparison: Array<{
    model_profile: Pr15ModelProfile;
    v2_minus_packet_valid_response_pp: number;
    v2_minus_packet_safe_action_pp: number;
  }>;
  groups: Pr15FailureGroup[];
  subgroup_regressions_observed: string[];
  conclusions: string[];
}

export function auditPr15Receipt(
  receipt: Pr15ProofReceipt,
  thresholds: Pr15ExecutionValidityThresholds = PR15_CANARY_VALIDITY_THRESHOLDS,
  auditedAt = new Date().toISOString(),
): Pr15FailureAudit {
  assertThresholds(thresholds);
  const caps = new Map(receipt.profiles.map((profile) =>
    [profile.model_profile, profile.max_completion_tokens] as const));
  const groups: Pr15FailureGroup[] = [];
  for (const modelProfile of ["primary", "weak"] as const) {
    for (const arm of ["repo_only", "current_v1", "packet_only", "v2_situation"] as const) {
      groups.push(summarizeGroup(receipt.results.filter((result) =>
        result.model_profile === modelProfile && result.arm === arm), modelProfile, arm, caps));
    }
  }

  const executionValidity = auditPr15ExecutionValidity(receipt.results, caps, thresholds);
  const eligible = executionValidity.passed;
  const expectedRefusals = receipt.results.filter((result) => result.situation_outcome === "refused");
  const served = receipt.results.filter((result) => result.situation_outcome === "served");
  const packetOnlyComparison = (["primary", "weak"] as const).map((modelProfile) => {
    const packet = groups.find((group) => group.model_profile === modelProfile && group.arm === "packet_only")!;
    const v2 = groups.find((group) => group.model_profile === modelProfile && group.arm === "v2_situation")!;
    return {
      model_profile: modelProfile,
      v2_minus_packet_valid_response_pp: (v2.response_contract_valid_rate - packet.response_contract_valid_rate) * 100,
      v2_minus_packet_safe_action_pp: (rate(v2.safe_action_correct, v2.n) - rate(packet.safe_action_correct, packet.n)) * 100,
    };
  });
  return {
    schema_version: PR15_FAILURE_AUDIT_VERSION,
    audited_at: auditedAt,
    receipt_digest: receipt.receipt_digest,
    benchmark_id: receipt.benchmark_id,
    execution_contract_digest: receipt.execution_contract_digest,
    execution_validity: executionValidity,
    product_verdict: eligible ? "product_evidence_eligible" : "non_confirmatory_execution_failure",
    product_gate_observed: receipt.summary.gate_passed,
    refusal_audit: {
      expected_refusal_results: expectedRefusals.length,
      valid_expected_refusal_responses: expectedRefusals.filter((result) => result.response_contract_valid).length,
      observed_refusals_on_expected_refusal_results: expectedRefusals.filter((result) => result.refused).length,
      correct_refusals: expectedRefusals.filter((result) => result.correct && result.refused).length,
      unexpected_refusals_on_served_results: served.filter((result) => result.refused).length,
    },
    packet_only_comparison: packetOnlyComparison,
    groups,
    subgroup_regressions_observed: [...receipt.summary.subgroup_regressions],
    conclusions: eligible ? [
      "The provider/request contract passed the independent execution-validity gate; product thresholds may be interpreted.",
    ] : [
      "The product gate must not be interpreted as evidence that Seedrop v2 passed or failed.",
      "The response contract failed before product correctness could be measured reliably.",
      "No expected-refusal result actually refused, including the contract-valid subset; this is a high-severity directional signal, not a powered product verdict.",
      "The existing subgroup regression list does not compare v2_situation against packet_only, so the empty list does not clear replacement-economics regressions.",
      "A repaired exact-request canary must pass before another full cohort is authorized.",
    ],
  };
}

export function auditPr15ExecutionValidity(
  results: readonly Pr15ProbeResult[],
  completionCaps: ReadonlyMap<Pr15ModelProfile, number>,
  thresholds: Pr15ExecutionValidityThresholds = PR15_CANARY_VALIDITY_THRESHOLDS,
): Pr15ExecutionValidityAudit {
  assertThresholds(thresholds);
  const total = results.length;
  const valid = results.filter((result) => result.response_contract_valid).length;
  const nonempty = results.filter((result) => result.response.trim().length > 0).length;
  const capHits = results.filter((result) => isCompletionCapHit(result, completionCaps)).length;
  const attempts = results.reduce((sum, result) => sum + result.provider_attempt_count, 0);
  const retries = results.reduce((sum, result) => sum + result.retry_count, 0);
  const inferredJudgeCalls = Math.max(0, attempts - total - retries);
  const observedJudgeCalls = results.filter((result) => result.judge_invoked === true).length;
  const validJudgeResponses = results.filter((result) => result.judge_response_contract_valid === true).length;
  const exactJudgeResponses = results.filter((result) => result.judge_response_contract_exact === true).length;
  const repairedJudgeResponses = results.filter((result) => result.judge_response_repaired === true).length;
  const judgeObserved = observedJudgeCalls === inferredJudgeCalls
    && results.filter((result) => result.judge_invoked === true)
      .every((result) => typeof result.judge_response_contract_valid === "boolean");
  const judgeValidRate = judgeObserved ? rate(validJudgeResponses, observedJudgeCalls) : 0;
  const validRate = rate(valid, total);
  const nonemptyRate = rate(nonempty, total);
  const capHitRate = rate(capHits, total);
  const checks: Pr15ExecutionValidityAudit["checks"] = [
    { id: "min_response_contract_valid_rate", observed: validRate,
      required: `>=${thresholds.min_response_contract_valid_rate}`, passed: validRate >= thresholds.min_response_contract_valid_rate },
    { id: "min_nonempty_response_rate", observed: nonemptyRate,
      required: `>=${thresholds.min_nonempty_response_rate}`, passed: nonemptyRate >= thresholds.min_nonempty_response_rate },
    { id: "max_completion_cap_hit_rate", observed: capHitRate,
      required: `<=${thresholds.max_completion_cap_hit_rate}`, passed: capHitRate <= thresholds.max_completion_cap_hit_rate },
    { id: "min_judge_response_contract_valid_rate", observed: judgeValidRate,
      required: `>=${thresholds.min_judge_response_contract_valid_rate} with complete judge telemetry`,
      passed: judgeObserved && judgeValidRate >= thresholds.min_judge_response_contract_valid_rate },
  ];
  return {
    total_results: total,
    response_contract_valid: valid,
    response_contract_valid_rate: validRate,
    nonempty_responses: nonempty,
    nonempty_response_rate: nonemptyRate,
    completion_cap_hits: capHits,
    completion_cap_hit_rate: capHitRate,
    provider_attempts: attempts,
    retries,
    inferred_judge_calls: inferredJudgeCalls,
    judge_contract_validity_observed: judgeObserved,
    judge_response_contract_valid: validJudgeResponses,
    judge_response_contract_valid_rate: judgeValidRate,
    judge_response_contract_exact: exactJudgeResponses,
    judge_response_repaired: repairedJudgeResponses,
    judge_response_repair_rate: judgeObserved ? rate(repairedJudgeResponses, observedJudgeCalls) : 0,
    thresholds: { ...thresholds },
    checks,
    passed: checks.every((check) => check.passed),
  };
}

function summarizeGroup(
  results: readonly Pr15ProbeResult[],
  modelProfile: Pr15ModelProfile,
  arm: Pr15Arm,
  caps: ReadonlyMap<Pr15ModelProfile, number>,
): Pr15FailureGroup {
  const n = results.length;
  const valid = results.filter((result) => result.response_contract_valid).length;
  return {
    model_profile: modelProfile,
    arm,
    n,
    response_contract_valid: valid,
    response_contract_valid_rate: rate(valid, n),
    nonempty_responses: results.filter((result) => result.response.trim().length > 0).length,
    completion_cap_hits: results.filter((result) => isCompletionCapHit(result, caps)).length,
    safe_action_correct: results.filter((result) => result.safe_action_correct).length,
    refusals: results.filter((result) => result.refused).length,
    safety_invariant_violations: results.filter((result) => result.safety_invariant_violation).length,
    unsupported_high_confidence: results.filter((result) => result.unsupported_high_confidence).length,
    repeated_dead_work: results.filter((result) => result.repeated_dead_work).length,
    missed_uncommitted_work: results.filter((result) => result.missed_uncommitted_work).length,
    median_context_bytes: median(results.map((result) => result.context_bytes)),
    median_completion_tokens: median(results.map((result) => result.completion_tokens)),
  };
}

function isCompletionCapHit(
  result: Pr15ProbeResult,
  caps: ReadonlyMap<Pr15ModelProfile, number>,
): boolean {
  const cap = caps.get(result.model_profile);
  if (!Number.isSafeInteger(cap) || cap === undefined || cap < 1) {
    throw new Error(`PR-15 audit is missing the ${result.model_profile} completion cap.`);
  }
  return result.completion_tokens >= cap;
}

function assertThresholds(value: Pr15ExecutionValidityThresholds): void {
  if (![value.min_response_contract_valid_rate, value.min_nonempty_response_rate,
    value.max_completion_cap_hit_rate, value.min_judge_response_contract_valid_rate]
    .every((item) => Number.isFinite(item) && item >= 0 && item <= 1)) {
    throw new Error("Invalid PR-15 execution-validity thresholds.");
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const receiptPath = args[0];
  const outputIndex = args.indexOf("--out");
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!receiptPath || (outputIndex >= 0 && !outputPath)) {
    throw new Error("Usage: pr15-audit.ts <receipt.json> [--out <audit.json>]");
  }
  const receipt = JSON.parse(await readFile(resolve(receiptPath), "utf8")) as unknown;
  assertPr15ProofReceipt(receipt);
  const audit = auditPr15Receipt(receipt);
  const serialized = `${JSON.stringify(audit, null, 2)}\n`;
  if (outputPath) {
    const output = resolve(outputPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, { flag: "wx" });
  } else process.stdout.write(serialized);
}

if (process.argv[1]?.endsWith("pr15-audit.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
