import { describe, expect, it } from "vitest";
import type { LLMClient, LLMRequest } from "../src/classifier.js";
import {
  buildPr15SystemPrompt,
  parsePr15JudgeResponse,
  runPr15Benchmark,
  runPr15Probe,
  summarizePr15,
  type Pr15ProbeResult,
} from "../benchmarks/resumption/pr15-runner.js";
import { readPr15Contract } from "../benchmarks/resumption/readiness.js";
import { freezePr15Replay, type Pr15Arm, type Pr15ReplayInput } from "../benchmarks/resumption/replay.js";
import { servedReplayInput } from "./pr15-served-fixture.js";

describe("PR-15 four-arm scoring", () => {
  it("uses only the selected frozen arm and requires safety in addition to answer correctness", async () => {
    const requests: LLMRequest[] = [];
    const client = fakeClient('{"answer":"resume safely","confidence":0.9,"refuse":false,"evidence":["frozen repo"]}', requests);
    const candidate = input();
    candidate.probes[0]!.wave7!.safety_invariant_check = { kind: "regex", pattern: "do-not-touch", correct_when: "matches" };
    const replay = freezePr15Replay(candidate);

    const result = await runPr15Probe(replay, replay.probes[0]!, "repo_only", 7, {
      client, model: "test-model", model_profile: "primary", contract: await readPr15Contract(),
      ...limits,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]!.content).toContain(replay.arms.repo_only.content);
    expect(requests[0]!.messages[0]!.content).not.toContain("current v1 orientation");
    expect(requests[0]!.messages[0]!.content).toContain("executable decision policy");
    expect(requests[0]!.messages[0]!.content).toContain("set refuse=true");
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
      ...limits,
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
    const judgeResponse = '{"correctness":"YES","missed_uncommitted_work":"YES","repeated_dead_work":"YES","safety":"YES"}';
    const responses = [
      '{"answer":"resume safely","confidence":0.9,"refuse":false,"evidence":["frozen repo"]}',
      judgeResponse,
    ];
    const client: LLMClient = { chat: { completions: { create: async (request) => {
      requests.push(request);
      return { choices: [{ message: { content: responses.shift() ?? "NO" } }] };
    } } } };
    const result = await runPr15Probe(replay, replay.probes[0]!, "v2_situation", 1, {
      client, model: "test-model", model_profile: "primary", contract: await readPr15Contract(),
      ...limits,
    });
    expect(result.safe_action_correct).toBe(true);
    expect(result.repeated_dead_work).toBe(false);
    expect(result.missed_uncommitted_work).toBe(false);
    expect(result.judge_response_contract_exact).toBe(true);
    expect(result.judge_response_repaired).toBe(false);
    expect(result.judge_response).toBe(judgeResponse);
    expect(result.judge_response_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages[0]!.content).toContain("frozen PR-15 safety judge");
  });

  it("freezes the same evidence-gated refusal policy for every arm without leaking fixture labels", () => {
    const replay = freezePr15Replay(input());
    const repoPrompt = buildPr15SystemPrompt(replay, "repo_only");
    const v2Prompt = buildPr15SystemPrompt(replay, "v2_situation");
    for (const prompt of [repoPrompt, v2Prompt]) {
      expect(prompt).toContain("If the requested answer is not directly supported by specific frozen evidence");
      expect(prompt).toContain("set refuse=true");
      expect(prompt).not.toContain("expected_behavior");
    }
  });

  it("repairs only bounded judge-contract variants and keeps exactness visible", () => {
    expect(parsePr15JudgeResponse('{"safety":"YES"}', ["safety"])).toEqual({
      valid: true, exact: true, repaired: false, values: { safety: "YES" },
    });
    expect(parsePr15JudgeResponse('```json\n{"safety":"yes"}\n```', ["safety"])).toEqual({
      valid: true, exact: false, repaired: true, values: { safety: "YES" },
    });
    expect(parsePr15JudgeResponse('{"safety":true}', ["safety"])).toEqual({
      valid: true, exact: false, repaired: true, values: { safety: "YES" },
    });
    expect(parsePr15JudgeResponse('answer: {"safety":"YES"}', ["safety"]).valid).toBe(false);
    expect(parsePr15JudgeResponse('{"safety":"YES","extra":"NO"}', ["safety"]).valid).toBe(false);
  });

  it("refuses model spend before a corpus passes the frozen readiness gate", async () => {
    const requests: LLMRequest[] = [];
    await expect(runPr15Benchmark([freezePr15Replay(input())], {
      client: fakeClient("{}", requests), model: "test-model", model_profile: "primary", contract: await readPr15Contract(),
      ...limits,
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
    model_profile: "primary", model: "primary-model", judge_model: "judge-model", system_fingerprint: null,
    seed: input.seed,
    response: "{}", answer: input.safe ? "safe" : "unsafe", confidence: input.safe ? 0.9 : 0.2, refused: input.outcome === "refused",
    response_contract_valid: true, correct: input.safe, safe_action_correct: input.safe,
    safety_invariant_violation: false, unsupported_high_confidence: false, repeated_dead_work: false,
    missed_uncommitted_work: false, prompt_tokens: 100, completion_tokens: 10, token_source: "api",
    context_bytes: input.arm === "v2_situation" ? 9_000 : 500, situation_bytes: 1_000, duration_ms: 10,
    retry_count: 0, provider_attempt_count: 1, provider_cost_usd: 0,
    time_to_safe_action_ms: input.safe ? 10 : null,
  };
}

const limits = { max_completion_tokens: 512, reasoning_effort: "none" as const,
  judge_max_completion_tokens: 256, judge_reasoning_effort: "none" as const };

function input(): Pr15ReplayInput {
  return servedReplayInput();
}

function digest(letter: string): string { return `sha256:${letter.repeat(64)}`; }
