import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateCanonicalId,
  reconcilePrincipalCandidates,
} from "@seedrop/protocol";
import type { CanonicalId } from "@seedrop/protocol";
import {
  assertViewHistoryImportResult,
  collectV1ViewHistory,
  digestReadOnlyTree,
  importViewHistory,
  viewHistoryImportBytes,
  viewHistoryImportDigest,
} from "../src/index.js";

const roots: string[] = [];
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const PACKET_ID = "33333333-3333-4333-8333-333333333333";
const SIGNAL_ID = "44444444-4444-4444-8444-444444444444";
const AT = "2026-08-10T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("v1 View history shadow import", () => {
  it("conserves imported, quarantined, and unresolved records in deterministic transactions", async () => {
    const fixture = await createFixture();
    const before = await digestReadOnlyTree(fixture.viewRoot);
    const collection = await collectV1ViewHistory({
      view_root: fixture.viewRoot,
      outcome_report_path: fixture.outcomePath,
    });
    const result = importViewHistory(importInput(collection));
    const after = await digestReadOnlyTree(fixture.viewRoot);

    expect(after).toBe(before);
    expect(collection.corpus.counts).toEqual({ sources: 6, files: 6, bytes: expect.any(Number), records: 6 });
    expect(result.receipt.counts).toEqual({
      source_records: 6,
      imported_records: 4,
      quarantined_records: 1,
      unresolved_records: 1,
      transactions: 6,
      events: 9,
    });
    expect(result.records.find((record) => record.source_family === "continuity")).toEqual(expect.objectContaining({
      disposition: "unresolved",
      diagnostic_codes: ["continuity_run_link_absent"],
    }));
    expect(result.records.find((record) => record.source_ref.endsWith("broken.json"))).toEqual(expect.objectContaining({
      disposition: "quarantined",
      diagnostic_codes: ["invalid_json"],
    }));
    const delivery = result.transactions.flatMap((transaction) => transaction.events)
      .find((event) => event.event_type === "seedrop.outcome.delivery_observed");
    expect(delivery?.payload).toEqual(expect.objectContaining({
      outcome: "survived",
      build_identity: "a".repeat(40),
      input_digest: expect.stringMatching(/^sha256:/),
    }));
  });

  it("is byte-identical across reruns and discovery order", async () => {
    const fixture = await createFixture();
    const firstCollection = await collectV1ViewHistory({ view_root: fixture.viewRoot, outcome_report_path: fixture.outcomePath });
    const secondCollection = await collectV1ViewHistory({ view_root: fixture.viewRoot, outcome_report_path: fixture.outcomePath });
    const first = importViewHistory(importInput(firstCollection));
    const second = importViewHistory(importInput({
      ...secondCollection,
      records: [...secondCollection.records].reverse(),
    }));
    expect(secondCollection.corpus).toEqual(firstCollection.corpus);
    expect(viewHistoryImportBytes(second)).toEqual(viewHistoryImportBytes(first));
    expect(viewHistoryImportDigest(second)).toBe(viewHistoryImportDigest(first));
  });

  it("rejects tampered chain evidence", async () => {
    const fixture = await createFixture();
    const collection = await collectV1ViewHistory({ view_root: fixture.viewRoot, outcome_report_path: fixture.outcomePath });
    const result = importViewHistory(importInput(collection));
    const tampered = {
      ...result,
      receipt: { ...result.receipt, transaction_chain_digest: `sha256:${"0".repeat(64)}` },
    };
    expect(() => assertViewHistoryImportResult(tampered as typeof result)).toThrow(/invalid_contract/);

    const unreasoned = {
      ...result,
      records: result.records.map((record) => record.disposition === "unresolved"
        ? { ...record, diagnostic_codes: [] }
        : record),
    };
    expect(() => assertViewHistoryImportResult(unreasoned as typeof result)).toThrow(/invalid_contract/);

    const remapped = {
      ...result,
      transactions: result.transactions.map((transaction, index) => index === 0
        ? { ...transaction, input_digest: result.records[1]!.source_digest }
        : transaction),
    };
    expect(() => assertViewHistoryImportResult(remapped as typeof result)).toThrow(/invalid_contract/);
  });
});

async function createFixture(): Promise<{ viewRoot: string; outcomePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-view-import-"));
  roots.push(root);
  const viewRoot = join(root, ".seedrop", "view");
  await Promise.all(["tasks", "runs", "continuity"].map((directory) => mkdir(join(viewRoot, directory), { recursive: true })));
  await writeJson(join(viewRoot, "tasks", `${TASK_ID}.json`), {
    schema_version: "1.0",
    task_id: TASK_ID,
    title: "Import fixture",
    status: "done",
    owner: "agent-a",
    created_at: AT,
    updated_at: AT,
    related_runs: [RUN_ID],
  });
  await writeFile(join(viewRoot, "tasks", "broken.json"), "{broken", "utf8");
  await writeJson(join(viewRoot, "runs", `${RUN_ID}.json`), {
    schema_version: "1.0",
    run_id: RUN_ID,
    agent_id: "agent-a",
    goal: "Exercise importer",
    status: "completed",
    started_at: AT,
    updated_at: AT,
    finished_at: AT,
    steps: [], decisions: [], assumptions: [], open_threads: [], changed_paths: ["src/a.ts"],
    validation: [{ command: "npm test", status: "passed", recorded_at: AT }],
    next_actions: [],
  });
  await writeJson(join(viewRoot, "continuity", "packet.json"), {
    schema_version: "1.0",
    id: PACKET_ID,
    created_at: AT,
    agent: "agent-a",
    mission: "Continue",
    summary: "Run-like reasoning with no explicit Run identity.",
    decisions: [], assumptions: [], open_threads: [], changed_paths: ["src/a.ts"],
    validation: { status: "passed", commands: ["npm test"] },
  });
  await writeJson(join(viewRoot, "signals-archive.json"), [{
    id: SIGNAL_ID,
    type: "claim",
    target: "src/a.ts",
    owner: "agent-a",
    created_at: AT,
    expires_at: "2026-08-10T13:00:00.000Z",
    intent: "Edit fixture",
    archived_at: "2026-08-10T14:00:00.000Z",
  }]);
  const outcomePath = join(root, "outcome.json");
  await writeJson(outcomePath, {
    generated_at: "2026-08-11T12:00:00.000Z",
    grace_days: 7,
    repos: [{
      root,
      head: "a".repeat(40),
      runs_total: 1,
      runs_labeled: 1,
      runs: [{ run_id: RUN_ID, agent_id: "agent-a", outcome: "survived" }],
    }],
  });
  return { viewRoot, outcomePath };
}

function importInput(collection: Awaited<ReturnType<typeof collectV1ViewHistory>>) {
  const principalRegistry = reconcilePrincipalCandidates([
    { source_ref: "agent:a", kind: "agent", aliases: [{ namespace: "agent_id", value: "agent-a" }] },
    { source_ref: "agent:migration", kind: "agent", aliases: [{ namespace: "agent_id", value: "migration" }] },
  ], { mint_id: (source) => id("principal", source) }).registry;
  return {
    collection,
    project_id: id("project", "fixture"),
    migration_principal_id: principalRegistry.principals.find((principal) => principal.source_refs.includes("agent:migration"))!.principal_id,
    principal_registry: principalRegistry,
    snapshot_recorded_at: "2026-08-12T00:00:00.000Z",
  };
}

function id<K extends "principal" | "project">(kind: K, source: string): CanonicalId<K> {
  const bytes = new TextEncoder().encode(source.padEnd(10, "0")).slice(0, 10);
  return generateCanonicalId(kind, { now: 1_725_000_000_000, entropy: bytes });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
