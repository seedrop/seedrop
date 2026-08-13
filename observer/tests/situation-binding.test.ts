import { describe, expect, it } from "vitest";
import {
  compileAdapterSituation,
  type BoundedSituationProjection,
  type ProjectTransactionDigest,
} from "@seedrop/situation";
import { bindObserverSituation } from "../src/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;

describe("Observer Situation binding", () => {
  it("passes through the canonical projection without reclassifying it", () => {
    const shared = compileAdapterSituation(fixture());

    const selected = bindObserverSituation({
      feature: true,
      projection: shared,
      legacy: { status: "broken", situation: { resumption: { readiness: "blocked" } } },
      expected: {
        situation_id: shared.situation_id,
        decision_id: shared.decision_id,
        semantic_digest: shared.semantic_digest,
      },
    });

    expect(selected).toEqual({
      mode: "v2",
      reason: null,
      warning: null,
      served: { kind: "v2_situation", payload: shared },
    });
  });

  it("keeps the complete legacy project available on mismatch", () => {
    const legacy = { id: "seedrop", status: "active", counts: { openTasks: 1 } };
    const selected = bindObserverSituation({
      feature: "enabled",
      projection: compileAdapterSituation(fixture()),
      legacy,
      expected: { decision_id: digest("f") },
    });

    expect(selected).toEqual({
      mode: "v1_fallback",
      reason: "projection_mismatch",
      warning: "projection_mismatch: v1 remains served",
      served: { kind: "v1", payload: legacy },
    });
  });
});

function fixture(): BoundedSituationProjection {
  return {
    schema_version: "1.0.0",
    situation_id: digest("a"),
    decision_id: digest("b"),
    budget: {
      requested_bytes: 4096,
      actual_bytes: 1200,
      complete: true,
      candidate_count: 10,
      indexed_count: 10,
      scanned_count: 0,
      event_count: 10,
      file_count: 20,
      omitted_categories: [],
    },
    orientation: {
      intent: { intent_id: "sd_int_fixture", state: "active", title: "Wave 6" },
      risk: [],
      delivery: { evidence: "passed", delivery: "committed" },
      grave: null,
      source_health: {
        substrate: "healthy",
        degraded_source_ids: [],
        quarantine_count: 0,
        unresolved_disagreement_count: 0,
      },
      next_action: { disposition: "recommend", action: "resume_intent" },
    },
    trust: Object.fromEntries(["intent", "risk", "delivery", "grave", "source_health", "next_action"].map((name) =>
      [name, { freshness: "current", completeness: "complete", source_ids: ["project"], missing: [] }],
    )),
  };
}
