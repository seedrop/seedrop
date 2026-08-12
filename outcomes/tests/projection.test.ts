import { describe, expect, it } from "vitest";
import { buildProjectTransaction, generateCanonicalId } from "@seedrop/protocol";
import type { JsonValue, ProjectTransaction, ProjectTransactionDigest } from "@seedrop/protocol";
import { compileOutcomeProjection, outcomeProjectionBytes } from "../src/index.js";

const id = <K extends "principal" | "project" | "episode" | "command" | "event">(kind: K, seed: number) =>
  generateCanonicalId(kind, { now: 1_725_000_000_000 + seed, entropy: Uint8Array.from({ length: 10 }, (_, i) => seed + i) });
const PRINCIPAL = id("principal", 1);
const PROJECT = id("project", 2);
const EPISODE = id("episode", 3);
const INPUT_A = `sha256:${"a".repeat(64)}` as ProjectTransactionDigest;
const INPUT_B = `sha256:${"b".repeat(64)}` as ProjectTransactionDigest;

describe("Outcome projection", () => {
  it.each(["uncommitted", "committed", "review_open", "merged", "reverted", "superseded", "absent"] as const)(
    "keeps reported completion separate from %s delivery",
    (delivery) => {
      const transaction = tx(1, [
        event(1, "seedrop.migration.record_imported", { source_family: "run", source_payload: { status: "completed" } }),
        event(2, "seedrop.outcome.validation_observed", observation({ status: "passed" })),
        event(3, "seedrop.outcome.delivery_observed", observation({ outcome: delivery })),
      ]);
      const result = compileOutcomeProjection({ transactions: [transaction] });
      expect(result.subjects[0]).toMatchObject({ reported_lifecycle: "reported_complete", evidence: "passed", delivery });
      if (["reverted", "superseded", "absent"].includes(delivery)) {
        expect(result.subjects[0]?.contradictions).toEqual([`reported_complete_but_${delivery}`]);
      }
    },
  );

  it("does not guess absence and marks validation stale when inputs move", () => {
    const transaction = tx(1, [event(1, "seedrop.outcome.validation_observed", observation({ status: "passed" }))]);
    const projected = compileOutcomeProjection({ transactions: [transaction], current_input_digests: { [EPISODE]: INPUT_B } });
    expect(projected.subjects[0]).toMatchObject({ evidence: "stale", delivery: "unobserved" });
  });

  it("selects the latest observation deterministically without rewriting history", () => {
    const first = tx(1, [event(1, "seedrop.outcome.delivery_observed", observation({ outcome: "uncommitted", observed_at: "2026-08-12T00:00:00.000Z" }))]);
    const second = tx(2, [event(2, "seedrop.outcome.delivery_observed", observation({ outcome: "survived", observed_at: "2026-08-12T01:00:00.000Z" }))]);
    const forward = compileOutcomeProjection({ transactions: [first, second] });
    const reverse = compileOutcomeProjection({ transactions: [second, first] });
    expect(forward.subjects[0]).toMatchObject({ delivery: "committed" });
    expect(outcomeProjectionBytes(reverse)).toEqual(outcomeProjectionBytes(forward));
    expect(forward.observation_count).toBe(2);
  });

  it("rejects unsupported delivery claims rather than promoting them", () => {
    const transaction = tx(1, [event(1, "seedrop.outcome.delivery_observed", observation({ outcome: "probably_shipped" }))]);
    expect(() => compileOutcomeProjection({ transactions: [transaction] })).toThrow(/Unknown delivery state/);
  });
});

function tx(seed: number, events: ReturnType<typeof event>[]): ProjectTransaction {
  return buildProjectTransaction({ command_id: id("command", 20 + seed), command_version: "1.0.0",
    command_name: "seedrop.fixture.outcomes", principal_id: PRINCIPAL, project_id: PROJECT,
    idempotency_key: `outcome-${seed}`, input_digest: INPUT_A, previous_transaction_digest: null,
    recorded_at: "2026-08-12T02:00:00.000Z", events });
}
function event(seed: number, event_type: string, payload: JsonValue) {
  return { event_id: id("event", 40 + seed), event_type, subject_id: EPISODE,
    occurred_at: "2026-08-12T01:00:00.000Z", payload };
}
function observation(extra: Record<string, JsonValue>): JsonValue {
  return { observed_at: "2026-08-12T00:00:00.000Z", input_digest: INPUT_A,
    build_identity: null, source_ref: "fixture:outcome", ...extra };
}
