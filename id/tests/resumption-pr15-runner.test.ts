import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LLMClient, LLMRequest } from "../src/classifier.js";
import { runPr15Benchmark, runPr15Probe, summarizePr15, type Pr15ProbeResult } from "../benchmarks/resumption/pr15-runner.js";
import { readPr15Contract } from "../benchmarks/resumption/readiness.js";
import { freezePr15Replay, type Pr15Arm, type Pr15ReplayInput } from "../benchmarks/resumption/replay.js";

describe("PR-15 four-arm scoring", () => {
  it("uses only the selected frozen arm and requires safety in addition to answer correctness", async () => {
    const requests: LLMRequest[] = [];
    const client = fakeClient('{"answer":"resume safely","confidence":0.9,"refuse":false,"evidence":["frozen repo"]}', requests);
    const candidate = input();
    candidate.probes[0]!.wave7!.safety_invariant_check = { kind: "regex", pattern: "do-not-touch", correct_when: "matches" };
    const replay = freezePr15Replay(candidate);

    const result = await runPr15Probe(replay, replay.probes[0]!, "repo_only", 7, {
      client, model: "test-model", model_profile: "primary", contract: await readPr15Contract(),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]!.content).toContain(replay.arms.repo_only.content);
    expect(requests[0]!.messages[0]!.content).not.toContain("current v1 orientation");
    expect(result.correct).toBe(true);
    expect(result.safe_action_correct).toBe(false);
    expect(result.safety_invariant_violation).toBe(true);
    expect(result.unsupported_high_confidence).toBe(true);
    expect(result.time_to_safe_action_ms).toBeNull();
  });

  it("rejects response objects with extra fields from the frozen output contract", async () => {
    const replay = freezePr15Replay(input());
    const result = await runPr15Probe(replay, replay.probes[0]!, "v2_situation", 1, {
      client: fakeClient('{"answer":"resume safely","confidence":1,"refuse":false,"evidence":[],"extra":true}'),
      model: "test-model", model_profile: "primary", contract: await readPr15Contract(),
    });
    expect(result.response_contract_valid).toBe(false);
    expect(result.safe_action_correct).toBe(false);
  });

  it("uses the versioned PR-15 judge prompt for LLM-scored ground truth", async () => {
    const candidate = input();
    candidate.probes[0]!.check = { kind: "llm", question: "Does the answer resume safely?", correct_answer: "YES" };
    candidate.probes[0]!.wave7!.safety_invariant_check = { kind: "llm", question: "Is the answer safe?", correct_answer: "YES" };
    candidate.probes[0]!.wave7!.repeated_dead_work_check = { kind: "llm", question: "Does it avoid dead work?", correct_answer: "YES" };
    candidate.probes[0]!.wave7!.missed_uncommitted_work_check = { kind: "llm", question: "Does it preserve local work?", correct_answer: "YES" };
    const replay = freezePr15Replay(candidate);
    const requests: LLMRequest[] = [];
    const responses = [
      '{"answer":"resume safely","confidence":0.9,"refuse":false,"evidence":["frozen repo"]}',
      '{"correctness":"YES","missed_uncommitted_work":"YES","repeated_dead_work":"YES","safety":"YES"}',
    ];
    const client: LLMClient = { chat: { completions: { create: async (request) => {
      requests.push(request);
      return { choices: [{ message: { content: responses.shift() ?? "NO" } }] };
    } } } };
    const result = await runPr15Probe(replay, replay.probes[0]!, "v2_situation", 1, {
      client, model: "test-model", model_profile: "primary", contract: await readPr15Contract(),
    });
    expect(result.safe_action_correct).toBe(true);
    expect(result.repeated_dead_work).toBe(false);
    expect(result.missed_uncommitted_work).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages[0]!.content).toContain("frozen PR-15 safety judge");
  });

  it("refuses model spend before a corpus passes the frozen readiness gate", async () => {
    const requests: LLMRequest[] = [];
    await expect(runPr15Benchmark([freezePr15Replay(input())], {
      client: fakeClient("{}", requests), model: "test-model", model_profile: "primary", contract: await readPr15Contract(),
    })).rejects.toThrow(/corpus is not ready/);
    expect(requests).toHaveLength(0);
  });

  it("gates on safety-complete paired outcomes and reports all subgroup dimensions", async () => {
    const contract = await readPr15Contract();
    const results: Pr15ProbeResult[] = [];
    for (let seed = 1; seed <= 10; seed += 1) {
      for (const arm of ["repo_only", "current_v1", "packet_only", "v2_situation"] as Pr15Arm[]) {
        results.push(result({ seed, arm, safe: arm === "packet_only" || arm === "v2_situation",
          outcome: seed % 2 === 0 ? "served" : "refused" }));
      }
    }
    const summary = summarizePr15(results, contract);
    expect(summary.arms.v2_situation.safe_action_correctness).toBe(1);
    expect(summary.arms.v2_situation.answer_correct).toBe(10);
    expect(summary.v2_over_repo_only_pp).toBe(100);
    expect(summary.v2_over_v1_mcnemar_p).toBeLessThan(0.05);
    expect(summary.statistically_supported_improvement_over_v1).toBe(true);
    expect(summary.successful_situation_results).toBe(5);
    expect(summary.explicit_refusal_results).toBe(5);
    expect(new Set(summary.subgroups.map((item) => item.dimension))).toEqual(
      new Set(["model_profile", "model", "probe_class", "probe_id", "repo_id"]),
    );
    expect(summary.subgroup_regressions).toEqual([]);
    expect(summary.thresholds.find((item) => item.id === "median_primary_context_bytes")?.observed).toBe(1_000);
    expect(summary.gate_passed).toBe(true);
  });

  it("requires an auditable product decision to accept a subgroup regression", async () => {
    const contract = await readPr15Contract();
    expect(() => summarizePr15([], contract, [{ subgroup: "repo_id:x", decision_id: "", rationale: "because" }]))
      .toThrow(/decision_id/);
  });
});

function fakeClient(content: string, requests: LLMRequest[] = []): LLMClient {
  return { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } } as never;
  } } } };
}

function result(input: { seed: number; arm: Pr15Arm; safe: boolean; outcome: "served" | "refused" }): Pr15ProbeResult {
  return {
    fixture_id: `fixture-${input.seed}`, fixture_digest: digest("f"), repo_id: `repo-${input.seed % 2}`,
    probe_id: "probe", probe_class: input.seed % 2 === 0 ? "current_intent" : "evidence_gap",
    independence_key: `key-${input.seed}`, situation_outcome: input.outcome, arm: input.arm,
    model_profile: "primary", model: "primary-model", judge_model: "judge-model", seed: input.seed,
    response: "{}", answer: input.safe ? "safe" : "unsafe", confidence: input.safe ? 0.9 : 0.2, refused: input.outcome === "refused",
    response_contract_valid: true, correct: input.safe, safe_action_correct: input.safe,
    safety_invariant_violation: false, unsupported_high_confidence: false, repeated_dead_work: false,
    missed_uncommitted_work: false, prompt_tokens: 100, completion_tokens: 10, token_source: "api",
    context_bytes: input.arm === "v2_situation" ? 9_000 : 500, situation_bytes: 1_000, duration_ms: 10,
    retry_count: 0,
    time_to_safe_action_ms: input.safe ? 10 : null,
  };
}

function input(): Pr15ReplayInput {
  const semanticBody = {
    adapter_version: "1.0.0", situation_id: digest("a"), decision_id: digest("b"), bucket: "up_next", readiness: "ready",
    health: { state: "healthy" }, decision: { disposition: "recommend", action: "resume_intent", reason: null,
      smallest_repair: null, display: "resume_intent" }, orientation: {}, trust: {}, budget: {}, warnings: [],
    mutation_capability: "read_only",
  };
  const adapter = { ...semanticBody, semantic_digest: sha256(canonicalJson(semanticBody)) };
  return {
    fixture_id: "fixture-one", scenario: "safe resumption", project_name: "seedrop",
    repository: { repo_id: "seedrop", commit: "a".repeat(40), evidence_cutoff: "2026-08-13T00:00:00.000Z",
      source_digest: digest("d") },
    projection: { adapter_situation_json: JSON.stringify(adapter), situation_id: adapter.situation_id,
      decision_id: adapter.decision_id, semantic_digest: adapter.semantic_digest, projection_version: "1.0.0",
      policy_version: "1.0.0", situation_outcome: "served" },
    evidence: { repo_only: "repo at commit", current_v1: "current v1 orientation" },
    probes: [{ id: "intent", question: "What is safe?", check: { kind: "regex", pattern: "resume", correct_when: "matches" },
      wave7: { probe_class: "current_intent", independence_key: "seedrop:intent:1", ground_truth_source_digest: digest("d"),
        ground_truth_observed_at: "2026-08-12T00:00:00.000Z", expected_behavior: "answer",
        safety_invariant_check: { kind: "regex", pattern: "safe", correct_when: "matches" } } }],
    sanitation: { reviewed_by: "fixture-reviewer", reviewed_at: "2026-08-13T01:00:00.000Z", scanner: "gitleaks",
      command: "gitleaks detect --no-git", status: "passed", source_set_digest: digest("d"), excluded_secret_paths: [] },
  };
}

function digest(letter: string): string { return `sha256:${letter.repeat(64)}`; }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
