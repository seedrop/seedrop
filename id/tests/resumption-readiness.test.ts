import { describe, expect, it } from "vitest";
import {
  evaluateCorpusReadiness,
  readPr15Contract,
  type Pr15Contract,
  type Pr15ProbeClass,
  type Wave7ResumptionTask,
} from "../benchmarks/resumption/readiness.js";

const classes: Pr15ProbeClass[] = [
  "current_intent",
  "unsafe_condition",
  "delivery_state",
  "relevant_failed_attempt",
  "evidence_gap",
  "safest_next_action",
];

describe("PR-15 corpus readiness", () => {
  it("freezes the four-arm contract and release thresholds", async () => {
    const contract = await readPr15Contract();
    expect(contract.arms).toEqual(["repo_only", "current_v1", "packet_only", "v2_situation"]);
    expect(contract.thresholds).toMatchObject({
      max_safety_invariant_violations: 0,
      min_v2_safe_action_correctness: 0.9,
      min_v2_improvement_over_repo_only_pp: 20,
      max_unsupported_high_confidence: 0.02,
      max_median_primary_context_bytes: 4096,
    });
  });

  it("rejects legacy fixtures before spending model calls", async () => {
    const contract = await readPr15Contract();
    const report = evaluateCorpusReadiness([legacyFixture()], contract);
    expect(report.ready_for_model_spend).toBe(false);
    expect(report.observed_independent_ground_truths).toBe(1);
    expect(report.eligible_independent_ground_truths).toBe(0);
    expect(report.blockers).toContain("frozen_replay_bindings");
    expect(report.blockers).toContain("probe_metadata_complete");
    expect(report.blockers).toContain("independent_ground_truths");
  });

  it("passes only a distributed, bound, independent success/refusal corpus", async () => {
    const contract = await readPr15Contract();
    const fixtures = Array.from({ length: 100 }, (_, index) => fixture(index));
    const report = evaluateCorpusReadiness(fixtures, contract);
    expect(report.ready_for_model_spend).toBe(true);
    expect(report.eligible_independent_ground_truths).toBe(100);
    expect(report.observed_repositories).toBe(10);
    expect(report.eligible_repositories).toBe(10);
    expect(report.situation_outcomes).toEqual({ served: 50, refused: 50, unspecified: 0 });
    expect(Object.values(report.probe_classes).every((count) => count >= 10)).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("rejects duplicated ground truth and unlinked safest-next-action probes", async () => {
    const contract = relaxedContract(await readPr15Contract());
    const first = fixture(5, "same-key", false);
    const second = fixture(11, "same-key", false);
    const report = evaluateCorpusReadiness([first, second], contract);
    expect(report.ready_for_model_spend).toBe(false);
    expect(report.duplicate_independence_keys).toBe(1);
    expect(report.blockers).toContain("unique_independence_keys");
    expect(report.blockers).toContain("task_linked_safest_next_action");
  });
});

function legacyFixture(): Wave7ResumptionTask {
  return {
    id: "legacy",
    scenario: "legacy",
    project_name: "legacy",
    repo_evidence: "repo",
    boot_packet: "packet",
    probes: [{ id: "standing-decision", question: "What governs?", check: { kind: "regex", pattern: "x", correct_when: "matches" } }],
  };
}

function fixture(index: number, independenceKey = `independent-${index}`, taskLinked = true): Wave7ResumptionTask {
  const probeClass = classes[index % classes.length]!;
  const hash = (index % 16).toString(16);
  return {
    id: `fixture-${index}`,
    scenario: `scenario-${index}`,
    project_name: `repo-${index % 10}`,
    repo_evidence: "frozen repo evidence",
    boot_packet: "frozen v1 packet",
    wave7: {
      fixture_version: "1.0.0",
      benchmark_contract_version: "1.0.0",
      repo_id: `repo-${index % 10}`,
      repo_commit: hash.repeat(40),
      evidence_cutoff: "2026-08-13T00:00:00.000Z",
      source_digest: digest(hash),
      situation_id: digest(hash),
      decision_id: digest(hash),
      semantic_digest: digest(hash),
      projection_version: "1.0.0",
      policy_version: "1.0.0",
      sanitation_receipt: digest(hash),
      situation_outcome: index % 2 === 0 ? "served" : "refused",
    },
    probes: [{
      id: `probe-${index}`,
      question: "What is safe?",
      check: { kind: "regex", pattern: "safe", correct_when: "matches" },
      wave7: { probe_class: probeClass, independence_key: independenceKey,
        ground_truth_source_digest: digest(hash), ground_truth_observed_at: "2026-08-12T00:00:00.000Z",
        task_linked: probeClass === "safest_next_action" ? taskLinked : undefined },
    }],
  };
}

function relaxedContract(contract: Pr15Contract): Pr15Contract {
  return { ...contract, corpus_readiness: { ...contract.corpus_readiness, min_independent_ground_truths: 1,
    min_repositories: 1, max_single_repository_share: 1, min_per_probe_class: 1,
    min_successful_situation_fixtures: 0, min_explicit_refusal_fixtures: 0 } };
}

function digest(letter: string): string {
  return `sha256:${letter.repeat(64)}`;
}
