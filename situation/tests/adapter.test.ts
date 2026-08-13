import { describe, expect, it } from "vitest";
import type { JsonValue, ProjectTransactionDigest } from "@seedrop/protocol";
import { AdapterMutationRejectedError, adapterFeatureEnabled, adapterSituationBytes,
  assertAdapterReadOnlyOperation, compileAdapterSituation, selectAdapterSituation } from "../src/index.js";
import { assertAdapterSituation } from "../src/index.js";
import type { BoundedSituationProjection } from "../src/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;

describe("canonical adapter Situation", () => {
  it("centralizes healthy active semantics and produces a stable digest", () => {
    const first = compileAdapterSituation(fixture());
    const second = compileAdapterSituation(fixture());
    expect(first).toMatchObject({ bucket: "ongoing", readiness: "active", health: { state: "healthy" },
      decision: { disposition: "recommend", action: "resume_intent", display: "resume_intent" },
      warnings: [], mutation_capability: "read_only" });
    expect(adapterSituationBytes(second)).toEqual(adapterSituationBytes(first));
    expect(first.semantic_digest).toMatch(/^sha256:/);
    expect(() => assertAdapterSituation(JSON.parse(new TextDecoder().decode(adapterSituationBytes(first))))).not.toThrow();
  });

  it("rejects a serialized projection whose semantics were changed", () => {
    const changed = { ...compileAdapterSituation(fixture()), bucket: "quiet" };
    expect(() => assertAdapterSituation(changed)).toThrow(/semantic_digest_mismatch/);
  });

  it("centralizes refusal, degraded health, and explicit budget warnings", () => {
    const input = fixture();
    input.orientation.next_action = { disposition: "refuse", smallest_repair: "repair" };
    input.orientation.source_health = { substrate: "degraded", degraded_source_ids: ["git"], quarantine_count: 2, unresolved_disagreement_count: 0 };
    input.trust!.source_health = { freshness: "stale", completeness: "partial", source_ids: ["project"], missing: ["git"] };
    input.budget = { ...input.budget, complete: false, omitted_categories: ["risk_text"] };
    const result = compileAdapterSituation(input);
    expect(result).toMatchObject({ bucket: "needs_attention", readiness: "blocked",
      health: { state: "degraded", freshness: "stale", completeness: "partial" },
      decision: { disposition: "refuse", smallest_repair: "repair", display: "repair" } });
    expect(result.warnings).toEqual(["budget_limited:risk_text", "completeness:partial", "freshness:stale", "quarantine:2"]);
  });

  it("serves v2 only when enabled and expected identities agree", () => {
    const shared = compileAdapterSituation(fixture()), legacy = { schema_version: "1.0", source: "v1" } as JsonValue;
    const selected = selectAdapterSituation({ feature_enabled: true, shared, legacy,
      expected: { situation_id: shared.situation_id, decision_id: shared.decision_id, semantic_digest: shared.semantic_digest } });
    expect(selected).toMatchObject({ mode: "v2", served: { kind: "v2_situation" } });
    expect(selectAdapterSituation({ feature_enabled: false, shared, legacy })).toMatchObject({ mode: "v1_fallback", reason: "feature_disabled", served: { kind: "v1", payload: legacy } });
  });

  it("falls back to v1 and names projection mismatch", () => {
    const shared = compileAdapterSituation(fixture()), legacy = { source: "v1" } as JsonValue;
    const selected = selectAdapterSituation({ feature_enabled: true, shared, legacy, expected: { decision_id: digest("f") } });
    expect(selected).toEqual({ mode: "v1_fallback", reason: "projection_mismatch",
      warning: "projection_mismatch: v1 remains served", served: { kind: "v1", payload: legacy } });
  });

  it("parses feature flags and rejects direct adapter mutation", () => {
    expect([true, "1", "true", "enabled"].every(adapterFeatureEnabled)).toBe(true);
    expect([false, undefined, "0", "yes"].some(adapterFeatureEnabled)).toBe(false);
    expect(() => assertAdapterReadOnlyOperation("render")).not.toThrow();
    expect(() => assertAdapterReadOnlyOperation("write_project")).toThrow(AdapterMutationRejectedError);
  });
});

function fixture(): BoundedSituationProjection {
  return { schema_version: "1.0.0", situation_id: digest("a"), decision_id: digest("b"),
    budget: { requested_bytes: 4096, actual_bytes: 1200, complete: true, candidate_count: 10, indexed_count: 10,
      scanned_count: 0, event_count: 10, file_count: 20, omitted_categories: [] },
    orientation: { intent: { intent_id: "sd_int_fixture", state: "active", title: "Wave 6" }, risk: [],
      delivery: { evidence: "passed", delivery: "committed" }, grave: null,
      source_health: { substrate: "healthy", degraded_source_ids: [], quarantine_count: 0, unresolved_disagreement_count: 0 },
      next_action: { disposition: "recommend", action: "resume_intent" } },
    trust: Object.fromEntries(["intent", "risk", "delivery", "grave", "source_health", "next_action"].map((name) =>
      [name, { freshness: "current", completeness: "complete", source_ids: ["project"], missing: [] }])) };
}
