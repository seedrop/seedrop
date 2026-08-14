import { describe, expect, it } from "vitest";
import { buildHealthEnvelope, generateCanonicalId } from "@seedrop/protocol";
import type { CanonicalId, ProjectTransactionDigest } from "@seedrop/protocol";
import type { ProjectProjection, WorkProjection } from "@seedrop/project";
import type { GraveProjection, OutcomeProjection, SourceInvalidationProjection } from "@seedrop/outcomes";
import { boundedSituationBytes, compileBoundedSituation, compileSituation, SituationBudgetInsufficientError, situationBytes } from "../src/index.js";
import type { CompileSituationInput, SituationReadPort } from "../src/index.js";

const id = <K extends "principal" | "project" | "intent" | "episode" | "event" | "claim">(kind: K, seed: number) =>
  generateCanonicalId(kind, { now: 1_725_000_000_000 + seed, entropy: Uint8Array.from({ length: 10 }, (_, index) => seed + index) });
const PROJECT = id("project", 1), PRINCIPAL = id("principal", 2), INTENT = id("intent", 3), EPISODE = id("episode", 4);
const OTHER_EPISODE = id("episode", 5), CLAIM = id("claim", 6), EVENT = id("event", 7);
const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;

describe("Situation compiler", () => {
  it("compiles one provenance-aware recommendation with intent, risk, delivery, Grave, and health", () => {
    const result = compileSituation(fixture());
    expect(result.intent.value).toMatchObject({ intent_id: INTENT, episode_id: EPISODE, goal: "Ship v2" });
    expect(result.delivery.value).toMatchObject({ evidence: "passed", delivery: "committed" });
    expect(result.grave.value).toMatchObject({ subject_id: OTHER_EPISODE, kind: "failed" });
    expect(result.source_health.value).toMatchObject({ substrate: "healthy", quarantine_count: 0 });
    expect(result.next_action.value).toMatchObject({ disposition: "recommend", action: "resume_intent" });
    for (const field of [result.identity, result.coordination, result.intent, result.risk, result.delivery, result.grave, result.source_health, result.next_action]) {
      expect(field).toMatchObject({ freshness: "current", completeness: "complete", missing: [] });
      expect(field.provenance.length).toBeGreaterThan(0);
    }
  });

  it("is byte- and decision-identical when source collection order changes", () => {
    const first = fixture();
    const second = fixture();
    second.project.value!.work = { ...second.project.value!.work,
      intents: [...second.project.value!.work.intents].reverse(), episodes: [...second.project.value!.work.episodes].reverse() };
    second.graves.value = { ...second.graves.value!, graves: [...second.graves.value!.graves].reverse() };
    const a = compileSituation(first), b = compileSituation(second);
    expect(situationBytes(b)).toEqual(situationBytes(a));
    expect(b.decision_id).toBe(a.decision_id);
  });

  it("refuses when identity is ambiguous or a relevant Claim is invalidated", () => {
    const input = fixture();
    input.identity.value = { principal_id: null, display_name: null, status: "ambiguous", candidates: [PRINCIPAL] };
    input.invalidation.value = { source_digest: digest("f"), claims: [{ claim_id: CLAIM, state: "invalidated", changed_source_ids: ["git:head"] }] };
    const result = compileSituation(input);
    expect(result.risk.value.map((risk) => risk.code)).toContain("relevant_claim_invalidated");
    expect(result.next_action.value).toMatchObject({ disposition: "refuse" });
    if (result.next_action.value.disposition === "refuse") {
      expect(result.next_action.value.blocking_unknowns).toEqual(expect.arrayContaining(["principal_not_resolved", "relevant_claim_invalidated"]));
      expect(result.next_action.value.smallest_repair).not.toBe("");
    }
  });

  it("allows only local resumption when coordination is unavailable", () => {
    const input = fixture();
    input.coordination.value = { status: "unavailable", active_claims: [], inbox_unacked: 0 };
    const result = compileSituation(input);
    expect(result.next_action.value).toMatchObject({ disposition: "recommend", action: "resume_local_intent", restrictions: ["coordination_actions_disabled"] });
  });

  it("never promotes reported completion without validation evidence", () => {
    const input = fixture();
    input.outcomes.value = { ...input.outcomes.value!, subjects: [{ ...input.outcomes.value!.subjects[0]!, reported_lifecycle: "reported_complete", evidence: "unverified", delivery: "unobserved" }] };
    const result = compileSituation(input);
    expect(result.risk.value.map((risk) => risk.code)).toContain("reported_complete_without_validation");
    expect(result.next_action.value).toMatchObject({ disposition: "recommend", action: "validate_reported_completion" });
  });

  it("refuses when the governing project projection is stale", () => {
    const input = fixture();
    input.project.value = { ...input.project.value!, health: { ...input.project.value!.health, substrate: "degraded", stale_projections: [{ projection: "work", source_id: "project", projection_watermark: digest("a"), source_high_watermark: digest("b"), observed_at: "2026-08-12T02:00:00.000Z", reason: "behind" }] } };
    const result = compileSituation(input);
    expect(result.next_action.value).toMatchObject({ disposition: "refuse" });
    expect(result.risk.value.map((risk) => risk.code)).toContain("stale_projection:work");
  });

  it.each([2, 4, 8, 16])("emits valid exact-budget JSON at %d KiB over indexed scale", (kib) => {
    const bounded = compileBoundedSituation(compileSituation(fixture()), { requested_bytes: kib * 1024,
      metrics: { candidate_count: 38_000, indexed_count: 38_000, scanned_count: 0, event_count: 100_000, file_count: 38_000 } });
    const bytes = boundedSituationBytes(bounded);
    expect(bytes.byteLength).toBe(bounded.budget.actual_bytes);
    expect(bytes.byteLength).toBeLessThanOrEqual(kib * 1024);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(bounded);
    expect(bounded.budget).toMatchObject({ requested_bytes: kib * 1024, event_count: 100_000, file_count: 38_000,
      candidate_count: 38_000, indexed_count: 38_000, scanned_count: 0 });
    expect(Object.keys(bounded.orientation).sort()).toEqual(["delivery", "grave", "intent", "next_action", "risk", "source_health"]);
    if (kib >= 4) expect(bounded.trust).toBeDefined();
  });

  it("returns a typed refusal when mandatory truth cannot fit", () => {
    expect(() => compileBoundedSituation(compileSituation(fixture()), { requested_bytes: 128,
      metrics: { candidate_count: 1, indexed_count: 1, scanned_count: 0, event_count: 1, file_count: 1 } }))
      .toThrow(SituationBudgetInsufficientError);
  });

  it("surfaces an in-progress imported episode even when no task lists it", () => {
    const input = fixture();
    input.project.value!.work = { ...input.project.value!.work, intents: [], episodes: [], claims: [] };
    input.project.value!.imported_orientation = {
      projection_version: "1.0.0", project_id: PROJECT, source_high_watermark: digest("a"), ignored_event_count: 0,
      intents: [{ intent_id: INTENT, title: "Unrelated backlog item", state: "open", source_ref: "task:1",
        observed_at: "2026-08-12T01:00:00.000Z", related_episode_ids: [] }],
      episodes: [{ episode_id: EPISODE, goal: "Finish the live run", state: "in_progress", source_ref: "run:1",
        observed_at: "2026-08-12T02:00:00.000Z" }],
    };
    const result = compileSituation(input);
    expect(result.intent.value).toMatchObject({
      episode_id: EPISODE, goal: "Finish the live run", state: "in_progress",
    });
  });
});

function fixture(): CompileSituationInput {
  const work: WorkProjection = {
    projection_version: "1.0.0", project_id: PROJECT, source_high_watermark: digest("a"),
    intents: [{ record: { intent_version: "1.0.0", intent_id: INTENT, project_id: PROJECT, title: "Wave 5", state: "queued", created_by: PRINCIPAL, created_at: "2026-08-12T00:00:00.000Z" }, state: "active", state_event_id: EVENT, correction_event_ids: [] }],
    episodes: [{ record: { episode_version: "1.0.0", episode_id: EPISODE, project_id: PROJECT, intent_id: INTENT, goal: "Ship v2", state: "active", started_by: PRINCIPAL, started_at: "2026-08-12T01:00:00.000Z" }, state: "active", state_event_id: EVENT, correction_event_ids: [] }],
    claims: [{ claim_version: "1.0.0", claim_id: CLAIM, project_id: PROJECT, intent_id: INTENT, episode_id: EPISODE, claim_kind: "scope", statement: "Own situation", evidence_digests: [digest("a")], corrects_claim_id: null, recorded_by: PRINCIPAL, recorded_at: "2026-08-12T01:00:00.000Z" }], receipts: [], leases: [],
  };
  const projection: ProjectProjection = { projection_version: "1.0.0", project_id: PROJECT, source_digest: digest("a"), source_high_watermark: digest("a"), transaction_count: 1, event_count: 1,
    applied: [{ transaction_digest: digest("a"), command_id: generateCanonicalId("command", { now: 1_725_000_000_100, entropy: Uint8Array.from({ length: 10 }, (_, i) => i + 10) }), recorded_at: "2026-08-12T01:00:00.000Z", event_ids: [EVENT] }],
    lag: { committed_transactions: 1, applied_transactions: 1, unapplied_transactions: 0, quarantined_artifacts: 0, complete: true }, quarantined: [] };
  const health = buildHealthEnvelope({ generated_at: "2026-08-12T02:00:00.000Z", projection_version: "1.0.0",
    policy: { policy_id: "seedrop.situation.fixture", policy_version: "1.0.0", required_projection_version: "1.0.0", required_source_ids: ["project"] },
    sources: [{ source_id: "project", kind: "transactions", status: "available", high_watermark: EVENT, content_digest: digest("a"), observed_at: "2026-08-12T02:00:00.000Z", governing_record_id: EVENT }],
    budget: { requested_bytes: 4096, actual_bytes: 100, complete: true, candidate_count: 1, indexed_count: 1, scanned_count: 0, omitted_categories: [] } });
  const outcomes: OutcomeProjection = { projection_version: "1.0.0", source_digest: digest("b"), observation_count: 2, ignored_event_count: 0,
    subjects: [{ subject_id: EPISODE, reported_lifecycle: "active", evidence: "passed", delivery: "committed", validation_observation: null, delivery_observation: null, contradictions: [] }] };
  const graves: GraveProjection = { projection_version: "1.0.0", source_digest: digest("c"), graves: [{ subject_id: OTHER_EPISODE, kind: "failed", goal: "Old path", cause: "Tests failed", scope: ["old.ts"], evidence_event_ids: [EVENT], source_transaction_digests: [digest("c")], source_refs: ["fixture"], retry: { status: "ready", condition: "Fix tests" }, correction_event_ids: [], completeness: { status: "complete", missing_fields: [] } }] };
  const invalidation: SourceInvalidationProjection = { source_digest: digest("d"), claims: [{ claim_id: CLAIM, state: "current", changed_source_ids: [] }] };
  return { generated_at: "2026-08-12T03:00:00.000Z",
    project: port("project", "a", { projection, work, health }), outcomes: port("outcomes", "b", outcomes), graves: port("graves", "c", graves),
    identity: port("identity", "d", { principal_id: PRINCIPAL, display_name: "jerry", status: "resolved", candidates: [] }),
    coordination: port("coordination", "e", { status: "available", active_claims: [], inbox_unacked: 0 }), invalidation: port("invalidation", "f", invalidation) };
}

function port<T>(source_id: string, letter: string, value: T): SituationReadPort<T> {
  return { source_id, source_digest: digest(letter), observed_at: "2026-08-12T02:00:00.000Z", freshness: "current", completeness: "complete", value, missing: [] };
}
