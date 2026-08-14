import { compileAdapterSituation } from "@seedrop/situation";
import type { AdapterSituationProjection, BoundedSituationProjection, ProjectTransactionDigest } from "@seedrop/situation";
import type { Pr15ReplayInput } from "../benchmarks/resumption/replay.js";

const digest = (letter: string): ProjectTransactionDigest => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;

export function boundedSituation(overrides: Partial<BoundedSituationProjection> = {}): BoundedSituationProjection {
  const orientation = {
    intent: { intent_id: "sd_int_fixture", state: "active", title: "Wave 7" },
    risk: [],
    delivery: { evidence: "passed", delivery: "committed" },
    grave: null,
    source_health: { substrate: "healthy", degraded_source_ids: [], quarantine_count: 0, unresolved_disagreement_count: 0 },
    next_action: { disposition: "recommend", action: "resume_intent" },
    ...(overrides.orientation ?? {}),
  };
  return {
    schema_version: "1.0.0",
    situation_id: digest("a"),
    decision_id: digest("b"),
    budget: {
      requested_bytes: 4096, actual_bytes: 1200, complete: true, candidate_count: 10, indexed_count: 10,
      scanned_count: 0, event_count: 10, file_count: 20, omitted_categories: [],
    },
    trust: Object.fromEntries(["intent", "risk", "delivery", "grave", "source_health", "next_action"].map((name) =>
      [name, { freshness: "current", completeness: "complete", source_ids: ["project"], missing: [] }])),
    ...overrides,
    orientation,
  };
}

export function servedAdapter(overrides: Partial<BoundedSituationProjection> = {}): AdapterSituationProjection {
  return compileAdapterSituation(boundedSituation(overrides));
}

export function brochureReplayInput(): Pr15ReplayInput {
  const semanticBody = {
    adapter_version: "1.0.0",
    situation_id: digest("a"),
    decision_id: digest("b"),
    bucket: "up_next",
    readiness: "ready",
    health: { state: "healthy" },
    decision: { disposition: "recommend", action: "resume_intent", reason: null, smallest_repair: null, display: "resume_intent" },
    orientation: {}, trust: {}, budget: {}, warnings: [], mutation_capability: "read_only",
  };
  return servedReplayInput({
    projection: {
      adapter_situation_json: JSON.stringify({ ...semanticBody, semantic_digest: digest("c") }),
      situation_id: digest("a"),
      decision_id: digest("b"),
      semantic_digest: digest("c"),
      projection_version: "1.0.0",
      policy_version: "1.0.0",
      situation_outcome: "served",
    },
  });
}

export function servedReplayInput(
  overrides: Partial<Pr15ReplayInput> = {},
  bounded: BoundedSituationProjection = boundedSituation(),
): Pr15ReplayInput {
  const adapter = compileAdapterSituation(bounded);
  return {
    fixture_id: "fixture-one",
    scenario: "safe resumption",
    project_name: "seedrop",
    repository: { repo_id: "seedrop", commit: "a".repeat(40), evidence_cutoff: "2026-08-13T00:00:00.000Z", source_digest: digest("d") },
    projection: {
      adapter_situation_json: JSON.stringify(adapter),
      situation_id: adapter.situation_id,
      decision_id: adapter.decision_id,
      semantic_digest: adapter.semantic_digest,
      projection_version: adapter.adapter_version,
      policy_version: "1.0.0",
      situation_outcome: adapter.decision.disposition === "refuse" ? "refused" : "served",
    },
    evidence: { repo_only: "repo at commit", current_v1: "current v1 orientation" },
    probes: [{ id: "intent", question: "What is current?", check: { kind: "regex", pattern: "resume", correct_when: "matches" },
      wave7: { probe_class: "current_intent", independence_key: "seedrop:intent:1", ground_truth_source_digest: digest("d"),
        ground_truth_observed_at: "2026-08-12T00:00:00.000Z", expected_behavior: "answer",
        safety_invariant_check: { kind: "regex", pattern: "resume", correct_when: "matches" } } }],
    sanitation: { reviewed_by: "fixture-reviewer", reviewed_at: "2026-08-13T01:00:00.000Z", scanner: "gitleaks",
      command: "gitleaks detect --no-git", status: "passed", source_set_digest: digest("d"), excluded_secret_paths: [] },
    ...overrides,
  };
}
