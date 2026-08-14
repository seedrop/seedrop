import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canaryAnswersWave7Questions,
  readWave7QuestionsContract,
  scoreWave7Questions,
} from "../benchmarks/resumption/wave7-questions.js";
import { readPr15CanaryContract } from "../benchmarks/resumption/pr15-canary.js";
import { buildPr15SystemPrompt, runPr15Probe, type Pr15ProbeResult } from "../benchmarks/resumption/pr15-runner.js";
import { readPr15Contract } from "../benchmarks/resumption/readiness.js";
import { freezePr15Replay, type Pr15Arm } from "../benchmarks/resumption/replay.js";
import { servedReplayInput } from "./pr15-served-fixture.js";
import type { LLMRequest } from "../src/classifier.js";

describe("Wave 7 questions locked into the PR-15 runner", () => {
  it("loads a frozen contract for Q1 replacement economics and Q2 refusal provenance", async () => {
    const questions = await readWave7QuestionsContract();
    expect(questions.questions_id).toBe("seedrop.pr15.wave7.questions.v1");
    expect(questions.q1.prompt_mode).toBe("untutored");
    expect(questions.q1.arms).toEqual(["v2_situation", "packet_only", "current_v1"]);
    expect(questions.q1.situation_outcomes).toEqual(["served"]);
    expect(questions.q2.prompt_modes).toEqual(["untutored", "tutored_refuse"]);
    expect(questions.q2.v2_win_prompt_mode).toBe("untutored");
  });

  it("omits refuse=true tutoring from the Q1 prompt and keeps it on the Q2 control", () => {
    const replay = freezePr15Replay(servedReplayInput());
    const q1 = buildPr15SystemPrompt(replay, "v2_situation", "untutored");
    const q2 = buildPr15SystemPrompt(replay, "v2_situation", "tutored_refuse");
    expect(q1).not.toContain("set refuse=true");
    expect(q1).toContain(replay.arms.v2_situation.content);
    expect(q2).toContain("set refuse=true");
    expect(q1).not.toContain("expected_behavior");
    expect(q2).not.toContain("expected_behavior");
  });

  it("stamps prompt_mode on probe results so Q1 cannot silently inherit tutoring", async () => {
    const requests: LLMRequest[] = [];
    const replay = freezePr15Replay(servedReplayInput());
    const result = await runPr15Probe(replay, replay.probes[0]!, "packet_only", 1, {
      client: {
        chat: { completions: { create: async (request) => {
          requests.push(request);
          return { choices: [{ message: { content: '{"answer":"resume","confidence":0.9,"refuse":false,"evidence":["frozen"]}' } }] };
        } } },
      },
      model: "test-model",
      model_profile: "primary",
      contract: await readPr15Contract(),
      prompt_mode: "untutored",
      max_completion_tokens: 512,
      reasoning_effort: "none",
      judge_max_completion_tokens: 256,
      judge_reasoning_effort: "none",
    });
    expect(result.prompt_mode).toBe("untutored");
    expect(result.arm).toBe("packet_only");
    expect(requests[0]!.messages[0]!.content).not.toContain("set refuse=true");
  });

  it("does not treat tutored v2-beats-v1 as Q1 replacement economics", async () => {
    const questions = await readWave7QuestionsContract();
    const tutored = [
      probe({ arm: "v2_situation", prompt_mode: "tutored_refuse", safe: true, missed: false, dead: false }),
      probe({ arm: "packet_only", prompt_mode: "tutored_refuse", safe: false, missed: true, dead: true }),
      probe({ arm: "current_v1", prompt_mode: "tutored_refuse", safe: false, missed: true, dead: true }),
    ];
    const scored = scoreWave7Questions(tutored, questions);
    expect(scored.q1.eligible).toBe(false);
    expect(scored.q1.exclusion_reason).toMatch(/untutored/);
    expect(scored.q1.v2_beats_packet_only).toBeNull();
    expect(scored.wave7_v2_win).toBe(false);
  });

  it("scores Q1 only on served untutored v2 vs packet_only vs current_v1", async () => {
    const questions = await readWave7QuestionsContract();
    const results = [
      probe({ arm: "v2_situation", prompt_mode: "untutored", safe: true, missed: false, dead: false }),
      probe({ arm: "packet_only", prompt_mode: "untutored", safe: false, missed: true, dead: true }),
      probe({ arm: "current_v1", prompt_mode: "untutored", safe: false, missed: true, dead: true }),
      probe({ arm: "repo_only", prompt_mode: "untutored", safe: false, missed: true, dead: true }),
      probe({ arm: "v2_situation", prompt_mode: "tutored_refuse", safe: true, missed: false, dead: false }),
    ];
    const scored = scoreWave7Questions(results, questions);
    expect(scored.q1.eligible).toBe(true);
    expect(scored.q1.n).toBe(3);
    expect(scored.q1.metrics.safe_action_correctness.v2_situation).toBe(1);
    expect(scored.q1.metrics.safe_action_correctness.packet_only).toBe(0);
    expect(scored.q1.metrics.safe_action_correctness.current_v1).toBe(0);
    expect(scored.q1.v2_beats_packet_only).toBe(true);
    expect(scored.q1.v2_beats_current_v1).toBe(true);
    expect(scored.wave7_v2_win).toBe(false);
  });

  it("attributes Q2 refusals to tutoring when the Situation arm only refuses after refuse=true tutoring", async () => {
    const questions = await readWave7QuestionsContract();
    const results = [
      probe({
        arm: "v2_situation", prompt_mode: "untutored", outcome: "refused", refused: false, correct: false, safe: false,
      }),
      probe({
        arm: "v2_situation", prompt_mode: "tutored_refuse", outcome: "refused", refused: true, correct: true, safe: true,
      }),
    ];
    const scored = scoreWave7Questions(results, questions);
    expect(scored.q2.eligible).toBe(true);
    expect(scored.q2.attribution).toBe("tutoring");
    expect(scored.q2.situation_caused_refusals).toBe(0);
    expect(scored.q2.tutored_only_refusals).toBe(1);
    expect(scored.wave7_v2_win).toBe(false);
  });

  it("attributes Q2 refusals to the Situation only on the untutored v2 arm", async () => {
    const questions = await readWave7QuestionsContract();
    const results = [
      probe({
        arm: "v2_situation", prompt_mode: "untutored", outcome: "refused", refused: true, correct: true, safe: true,
      }),
      probe({
        arm: "v2_situation", prompt_mode: "tutored_refuse", outcome: "refused", refused: true, correct: true, safe: true,
      }),
    ];
    const scored = scoreWave7Questions(results, questions);
    expect(scored.q2.attribution).toBe("situation");
    expect(scored.q2.situation_caused_refusals).toBe(1);
    expect(scored.wave7_v2_win).toBe(false);
  });

  it("refuses to treat the compatibility or repair canaries as Wave 7 product evidence", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const compatibility = await readPr15CanaryContract(
      resolve(here, "../benchmarks/resumption/pr15-failed-attempt-compatibility-canary-2026-08-14.json"),
    );
    const repair = await readPr15CanaryContract(
      resolve(here, "../benchmarks/resumption/pr15-repair-canary-2026-08-14.json"),
    );
    expect(canaryAnswersWave7Questions(compatibility)).toBe(false);
    expect(canaryAnswersWave7Questions(repair)).toBe(false);
    expect(compatibility.arms).not.toContain("v2_situation");
  });
});

function probe(input: {
  arm: Pr15Arm;
  prompt_mode: "untutored" | "tutored_refuse";
  outcome?: "served" | "refused";
  refused?: boolean;
  correct?: boolean;
  safe?: boolean;
  missed?: boolean;
  dead?: boolean;
}): Pr15ProbeResult {
  const outcome = input.outcome ?? "served";
  const safe = input.safe ?? true;
  return {
    fixture_id: "fixture-one",
    fixture_digest: `sha256:${"a".repeat(64)}`,
    repo_id: "seedrop",
    probe_id: outcome === "refused" ? "gap" : "intent",
    probe_class: outcome === "refused" ? "evidence_gap" : "current_intent",
    independence_key: "key-1",
    situation_outcome: outcome,
    arm: input.arm,
    prompt_mode: input.prompt_mode,
    model_profile: "primary",
    model: "test-model",
    judge_model: "test-model",
    system_fingerprint: null,
    seed: 1,
    response: "{}",
    answer: safe ? "safe" : "unsafe",
    confidence: 0.9,
    refused: input.refused ?? false,
    response_contract_valid: true,
    correct: input.correct ?? safe,
    safe_action_correct: safe,
    safety_invariant_violation: false,
    unsupported_high_confidence: false,
    repeated_dead_work: input.dead ?? false,
    missed_uncommitted_work: input.missed ?? false,
    prompt_tokens: 10,
    completion_tokens: 10,
    token_source: "estimated",
    context_bytes: 100,
    situation_bytes: 100,
    duration_ms: 1,
    retry_count: 0,
    provider_attempt_count: 1,
    provider_cost_usd: 0,
    time_to_safe_action_ms: safe ? 1 : null,
  };
}
