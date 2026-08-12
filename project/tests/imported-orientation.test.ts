import { describe, expect, it } from "vitest";
import { buildProjectTransaction, canonicalJsonBytes, generateCanonicalId, projectTransactionDigest } from "@seedrop/protocol";
import type { CanonicalId, JsonValue, ProjectTransactionDigest } from "@seedrop/protocol";
import { reduceImportedOrientation } from "../src/index.js";
import type { ProjectLogScan } from "../src/index.js";

const id = <K extends "principal" | "project" | "intent" | "episode" | "command" | "event">(kind: K, seed: number) =>
  generateCanonicalId(kind, { now: 1_725_000_000_000 + seed, entropy: Uint8Array.from({ length: 10 }, (_, i) => seed + i) });
const PRINCIPAL = id("principal", 1), PROJECT = id("project", 2), INTENT = id("intent", 3), EPISODE = id("episode", 4);
const INPUT = `sha256:${"a".repeat(64)}` as ProjectTransactionDigest;

describe("imported orientation projection", () => {
  it("projects legacy task/run orientation without promoting it to native Work", () => {
    const transaction = buildProjectTransaction({ command_id: id("command", 5), command_version: "1.0.0",
      command_name: "seedrop.migration.import_view_record", principal_id: PRINCIPAL, project_id: PROJECT,
      idempotency_key: "import-orientation", input_digest: INPUT, previous_transaction_digest: null,
      recorded_at: "2026-08-12T02:00:00.000Z", events: [
        event(6, INTENT, { source_ref: "task:1", source_family: "task", disposition: "imported", canonical_subject_id: INTENT,
          source_payload: { title: "Wave 5", status: "claimed", updated_at: "2026-08-12T01:00:00.000Z" }, explicit_links: { related_episode_ids: [EPISODE] } }),
        event(7, EPISODE, { source_ref: "run:1", source_family: "run", disposition: "imported", canonical_subject_id: EPISODE,
          source_payload: { goal: "Finish Wave 5", status: "in_progress", updated_at: "2026-08-12T02:00:00.000Z" }, explicit_links: {} }),
      ] });
    const digest = projectTransactionDigest(transaction);
    const scan: ProjectLogScan = { project_id: PROJECT, transactions: [{ digest, relative_path: "transactions/a.json", byte_length: canonicalJsonBytes(transaction).byteLength, transaction }],
      sources: [{ path: "transactions/a.json", expected_digest: digest, actual_digest: digest, status: "valid" }], diagnostics: [] };
    const projection = reduceImportedOrientation(scan);
    expect(projection.intents[0]).toMatchObject({ intent_id: INTENT, title: "Wave 5", state: "claimed", related_episode_ids: [EPISODE] });
    expect(projection.episodes[0]).toMatchObject({ episode_id: EPISODE, goal: "Finish Wave 5", state: "in_progress" });
  });
});

function event(seed: number, subject_id: CanonicalId, payload: JsonValue) {
  return { event_id: id("event", seed), event_type: "seedrop.migration.record_imported", subject_id,
    occurred_at: "2026-08-12T02:00:00.000Z", payload };
}
