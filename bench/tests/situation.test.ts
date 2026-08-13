import { describe, expect, it } from "vitest";
import type { AdapterSituationSelection } from "@seedrop/observer";
import { benchSharedSituationView } from "../src/situation.js";

describe("Bench shared Situation presenter", () => {
  it("presents canonical fields without deriving local health or bucket policy", () => {
    const selection = {
      mode: "v2",
      reason: null,
      warning: null,
      served: {
        kind: "v2_situation",
        payload: {
          adapter_version: "1.0.0",
          situation_id: digest("a"),
          decision_id: digest("b"),
          semantic_digest: digest("c"),
          bucket: "up_next",
          health: {
            state: "degraded",
            substrate: "healthy",
            freshness: "stale",
            completeness: "complete",
            degraded_source_ids: [],
            quarantine_count: 0,
            unresolved_disagreement_count: 0,
          },
          orientation: {
            intent: { title: "Ship the adapter wave", state: "active" },
            risk: [],
            delivery: null,
            grave: null,
            source_health: {},
            next_action: { disposition: "recommend", action: "run_parity_gate" },
          },
          trust: {},
          budget: {
            requested_bytes: 4096,
            actual_bytes: 1000,
            complete: true,
            candidate_count: 1,
            indexed_count: 1,
            scanned_count: 0,
            event_count: 1,
            file_count: 1,
            omitted_categories: [],
          },
          warnings: ["freshness:stale"],
          mutation_capability: "read_only",
        },
      },
    } as AdapterSituationSelection;

    expect(benchSharedSituationView({ adapter_situation: selection })).toEqual({
      situationId: digest("a"),
      decisionId: digest("b"),
      semanticDigest: digest("c"),
      bucket: "up_next",
      health: "degraded",
      intent: "Ship the adapter wave",
      nextAction: "run_parity_gate",
      warnings: ["freshness:stale"],
    });
  });

  it("does not reinterpret a legacy fallback", () => {
    const selection = {
      mode: "v1_fallback",
      reason: "projection_mismatch",
      warning: "projection_mismatch: v1 remains served",
      served: { kind: "v1", payload: { status: "attention" } },
    } as AdapterSituationSelection;

    expect(benchSharedSituationView({ adapter_situation: selection })).toBeNull();
  });
});

function digest(letter: string): `sha256:${string}` {
  return `sha256:${letter.repeat(64)}`;
}
