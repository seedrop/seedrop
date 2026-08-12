import { describe, expect, it } from "vitest";
import { buildProjectTransaction, generateCanonicalId } from "@seedrop/protocol";
import type { CanonicalId, JsonValue, ProjectTransaction, ProjectTransactionDigest } from "@seedrop/protocol";
import { compileGraveProjection, compileOutcomeProjection, graveProjectionBytes } from "../src/index.js";

const id = <K extends "principal" | "project" | "episode" | "command" | "event">(kind: K, seed: number) =>
  generateCanonicalId(kind, { now: 1_725_000_100_000 + seed, entropy: Uint8Array.from({ length: 10 }, (_, i) => seed + i) });
const PRINCIPAL = id("principal", 1), PROJECT = id("project", 2), EPISODE = id("episode", 3);
const DIGEST = `sha256:${"d".repeat(64)}` as ProjectTransactionDigest;

describe("negative continuity Grave projection", () => {
  it.each(["failed", "blocked", "abandoned"] as const)("preserves a %s attempt with evidence and scope", (status) => {
    const transaction = tx(1, [migration(1, status, "compiler crashed", ["src/compiler.ts"])]);
    const grave = compileGraveProjection({ transactions: [transaction] }).graves[0];
    expect(grave).toMatchObject({ kind: status, goal: "Compile Situation", cause: "compiler crashed",
      scope: ["src/compiler.ts"], completeness: { status: "complete", missing_fields: [] } });
    expect(grave?.evidence_event_ids).toHaveLength(1);
    expect(grave?.source_transaction_digests).toHaveLength(1);
  });

  it("keeps unresolved linkage visible and never invents a recovery condition", () => {
    const transaction = tx(1, [migration(1, "completed", null, [], "unresolved")]);
    expect(compileGraveProjection({ transactions: [transaction] }).graves[0]).toMatchObject({
      kind: "unresolved", retry: { status: "unknown" }, completeness: { status: "partial" },
    });
  });

  it("projects superseded delivery as negative continuity", () => {
    const transaction = tx(1, [{ event_id: id("event", 1), event_type: "seedrop.outcome.delivery_observed",
      subject_id: EPISODE, occurred_at: "2026-08-12T00:00:00.000Z",
      payload: { observed_at: "2026-08-12T00:00:00.000Z", input_digest: DIGEST, build_identity: "head",
        source_ref: "outcome:1", outcome: "superseded" } }]);
    const outcomes = compileOutcomeProjection({ transactions: [transaction] });
    expect(compileGraveProjection({ transactions: [transaction], outcomes }).graves[0]).toMatchObject({
      kind: "superseded", retry: { status: "blocked" }, source_refs: ["outcome:1"],
    });
  });

  it("retains a Grave after correction and links the recovery evidence", () => {
    const failed = tx(1, [{ event_id: id("event", 1), event_type: "seedrop.episode.transitioned", subject_id: EPISODE,
      occurred_at: "2026-08-12T00:00:00.000Z", payload: { to: "failed", reason: "bad approach" } }]);
    const corrected = tx(2, [{ event_id: id("event", 2), event_type: "seedrop.episode.corrected", subject_id: EPISODE,
      occurred_at: "2026-08-12T01:00:00.000Z", payload: { reason: "new evidence permits retry" } }]);
    const forward = compileGraveProjection({ transactions: [failed, corrected] });
    const reverse = compileGraveProjection({ transactions: [corrected, failed] });
    expect(graveProjectionBytes(reverse)).toEqual(graveProjectionBytes(forward));
    expect(forward.graves[0]).toMatchObject({ kind: "failed", retry: { status: "ready" } });
    expect(forward.graves[0]?.correction_event_ids).toEqual([id("event", 2)]);
  });
});

function migration(seed: number, status: string, cause: string | null, paths: string[], disposition = "imported") {
  return { event_id: id("event", seed), event_type: `seedrop.migration.record_${disposition}`,
    subject_id: EPISODE, occurred_at: "2026-08-12T00:00:00.000Z", payload: {
      source_family: "run", source_ref: `view:runs/${seed}.json`, disposition,
      diagnostics: disposition === "unresolved" ? [{ code: "principal_unresolved", reason: "principal cannot resolve" }] : [],
      source_payload: { goal: "Compile Situation", status, cause, changed_paths: paths },
    } };
}
function tx(seed: number, events: Array<{ event_id: CanonicalId<"event">; event_type: string;
  subject_id: typeof EPISODE; occurred_at: string; payload: JsonValue }>): ProjectTransaction {
  return buildProjectTransaction({ command_id: id("command", 20 + seed), command_version: "1.0.0",
    command_name: "seedrop.fixture.grave", principal_id: PRINCIPAL, project_id: PROJECT,
    idempotency_key: `grave-${seed}`, input_digest: DIGEST, previous_transaction_digest: null,
    recorded_at: "2026-08-12T02:00:00.000Z", events });
}
