import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { generateCanonicalId, reconcilePrincipalCandidates } from "@seedrop/protocol";
import type { CanonicalId } from "@seedrop/protocol";
import {
  assertMachineCoordinationReconciliation,
  collectMachineCoordination,
  machineCoordinationBytes,
  machineCoordinationDigest,
  reconcileMachineCoordination,
} from "../src/index.js";

const roots: string[] = [];
const SNAPSHOT_AT = "2026-08-12T12:00:00.000Z";
const RECENT = "2026-08-12T11:59:30.000Z";
const OLD = "2026-08-12T11:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("v1 machine coordination shadow reconciliation", () => {
  it("conserves authority, TTL projections, caches, migration evidence, and failures without Project coupling", async () => {
    const fixture = await createFixture();
    const collection = await collectMachineCoordination(fixture);
    const result = reconcileMachineCoordination({
      collection,
      principal_registry: principalRegistry(),
      snapshot_at: SNAPSHOT_AT,
    });

    expect(collection.corpus.counts).toEqual({ sources: 8, files: 8, bytes: expect.any(Number), records: 11 });
    expect(result.receipt.counts).toEqual({
      source_records: 11,
      imported_records: 8,
      quarantined_records: 2,
      unresolved_records: 1,
    });
    expect(result.receipt.presence).toEqual({ sessions: 2, online: 1, offline: 1 });
    expect(result.receipt.root_migrations).toEqual({ manifests: 1, applied: 1, rolled_back: 0 });
    expect(result.receipt.authority_counts).toEqual(expect.arrayContaining([
      expect.objectContaining({ authority_class: "durable_authority", source_records: 7 }),
      expect.objectContaining({ authority_class: "ttl_projection", source_records: 2 }),
      expect.objectContaining({ authority_class: "client_cache", source_records: 1 }),
      expect.objectContaining({ authority_class: "migration_evidence", source_records: 1 }),
    ]));
    expect(result.records.find((record) => record.source_ref.includes("messages.jsonl#00000001"))).toEqual(expect.objectContaining({
      disposition: "quarantined",
      diagnostics: [expect.objectContaining({ code: "invalid_json" })],
    }));
    expect(result.records.find((record) => record.source_ref.includes("#future_table:"))).toEqual(expect.objectContaining({
      disposition: "quarantined",
      diagnostics: [expect.objectContaining({ code: "unsupported_sqlite_table" })],
    }));
    expect(result.records.find((record) => record.source_ref.includes("#sessions:00000001"))).toEqual(expect.objectContaining({
      disposition: "unresolved",
      diagnostics: [expect.objectContaining({ code: "principal_unresolved" })],
      projection: { presence: expect.objectContaining({ online: false }) },
    }));
    expect(result.records.find((record) => record.source_family === "session_cache")?.projection).toEqual({ cache_state: "stale" });
    expect(JSON.stringify(result)).not.toContain("project_id");
    expect(JSON.stringify(result)).not.toContain("transaction");
  });

  it("is byte-identical across reruns and discovery order while leaving every selected source unchanged", async () => {
    const fixture = await createFixture();
    const sourcePaths = await fixturePaths(fixture);
    const before = await rawDigests(sourcePaths);
    const firstCollection = await collectMachineCoordination(fixture);
    const secondCollection = await collectMachineCoordination(fixture);
    const first = reconcileMachineCoordination({ collection: firstCollection, principal_registry: principalRegistry(), snapshot_at: SNAPSHOT_AT });
    const second = reconcileMachineCoordination({
      collection: { ...secondCollection, records: [...secondCollection.records].reverse() },
      principal_registry: principalRegistry(),
      snapshot_at: SNAPSHOT_AT,
    });
    const after = await rawDigests(sourcePaths);

    expect(after).toEqual(before);
    expect(secondCollection.source_tree_digest).toBe(firstCollection.source_tree_digest);
    expect(machineCoordinationBytes(second)).toEqual(machineCoordinationBytes(first));
    expect(machineCoordinationDigest(second)).toBe(machineCoordinationDigest(first));
  });

  it("binds TTL evaluation to the supplied snapshot and rejects tampered receipts", async () => {
    const fixture = await createFixture();
    const collection = await collectMachineCoordination(fixture);
    const result = reconcileMachineCoordination({
      collection,
      principal_registry: principalRegistry(),
      snapshot_at: SNAPSHOT_AT,
      ttl_seconds: 20,
    });
    expect(result.receipt.presence).toEqual({ sessions: 2, online: 0, offline: 2 });

    const tampered = {
      ...result,
      receipt: { ...result.receipt, record_mapping_digest: `sha256:${"0".repeat(64)}` },
    };
    expect(() => assertMachineCoordinationReconciliation(tampered as typeof result)).toThrow(/invalid_contract/);

    const absorbed = {
      ...result,
      receipt: { ...result.receipt, project_id: id("project", "forbidden") },
    };
    expect(() => assertMachineCoordinationReconciliation(absorbed as typeof result)).toThrow(/invalid_contract/);
  });

  it("quarantines malformed sessions without promoting them into the presence projection", async () => {
    const fixture = await createFixture();
    const collection = await collectMachineCoordination(fixture);
    const malformed = {
      ...collection,
      records: collection.records.map((record) => record.source_ref.includes("#sessions:00000000")
        ? { ...record, source_payload: null, diagnostics: [{ code: "schema_validation" as const, reason: "fixture corruption" }] }
        : record),
    };
    const result = reconcileMachineCoordination({
      collection: malformed,
      principal_registry: principalRegistry(),
      snapshot_at: SNAPSHOT_AT,
    });
    expect(result.records.find((record) => record.source_ref.includes("#sessions:00000000"))).toEqual(expect.objectContaining({
      disposition: "quarantined",
      projection: {},
    }));
    expect(result.receipt.presence).toEqual({ sessions: 1, online: 0, offline: 1 });
  });

  it("marks a drifted root backup unresolved instead of silently accepting migration evidence", async () => {
    const fixture = await createFixture({ corruptBackup: true });
    const collection = await collectMachineCoordination(fixture);
    const result = reconcileMachineCoordination({ collection, principal_registry: principalRegistry(), snapshot_at: SNAPSHOT_AT });
    expect(result.records.find((record) => record.source_family === "root_migration")).toEqual(expect.objectContaining({
      disposition: "unresolved",
      diagnostics: [expect.objectContaining({ code: "root_backup_mismatch" })],
    }));
  });
});

async function createFixture(options: { corruptBackup?: boolean } = {}): Promise<{
  space_root: string;
  migration_root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-coordination-import-"));
  roots.push(root);
  const spaceRoot = join(root, ".seedrop", "space");
  const migrationRoot = join(root, ".seedrop", "migrations", "space-root");
  const legacyRoot = join(spaceRoot, ".seedrop", "space");
  const backupRoot = join(migrationRoot, "migration-1");
  const metaPath = join(spaceRoot, "spaces", "team", "meta.json");
  const messagesPath = join(spaceRoot, "spaces", "team", "messages.jsonl");
  const notificationPath = join(spaceRoot, "notifications", "agent-b.jsonl");
  const cachePath = join(spaceRoot, "sessions", "agent-a.json");
  await Promise.all([metaPath, messagesPath, notificationPath, cachePath].map((path) => mkdir(dirname(path), { recursive: true })));

  const meta = {
    schema_version: "1.0",
    id: "space-1",
    name: "team",
    lifecycle: "active",
    members: [{ passport_id: "agent-a", joined_at: OLD }],
    created_at: OLD,
    ended_at: null,
    archived_at: null,
  };
  await writeJson(metaPath, meta);
  const message = {
    schema_version: "1.0",
    id: "message-1",
    space_id: "space-1",
    author_passport_id: "agent-a",
    principal_chain: ["agent-a"],
    role: "agent",
    created_at: OLD,
    content: "fixture",
  };
  await writeFile(messagesPath, `${JSON.stringify(message)}\n{broken\n`, "utf8");
  await writeFile(notificationPath, `${JSON.stringify({
    schema_version: "1.0",
    id: "notification-1",
    recipient_passport_id: "agent-b",
    sender_passport_id: "agent-a",
    created_at: OLD,
    expires_at: "2026-08-13T12:00:00.000Z",
    pointer: { kind: "space-message", ref: "space-1/message-1" },
    acked_at: null,
  })}\n`, "utf8");
  await writeJson(cachePath, { sessionId: "old-session", spaceId: "space-1" });

  const db = new Database(join(spaceRoot, "live.db"));
  db.exec(`
    CREATE TABLE sessions (
      schema_version TEXT NOT NULL, id TEXT NOT NULL PRIMARY KEY, passport_id TEXT NOT NULL,
      space_id TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, working_on TEXT
    );
    CREATE TABLE mentions (
      id TEXT NOT NULL PRIMARY KEY, message_id TEXT NOT NULL, space_id TEXT NOT NULL, space_name TEXT NOT NULL,
      recipient_passport_id TEXT NOT NULL, sender_passport_id TEXT NOT NULL, sender_principal_chain TEXT,
      content TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, acked_at TEXT,
      ack_result TEXT, ack_note TEXT, deferred_until TEXT
    );
    CREATE TABLE future_table (payload BLOB NOT NULL);
  `);
  const sessionInsert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)");
  sessionInsert.run("1.0", "session-a", "agent-a", "team", OLD, RECENT, "testing");
  sessionInsert.run("1.0", "session-ghost", "ghost", "space-1", OLD, OLD, null);
  db.prepare("INSERT INTO mentions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "mention-1", "message-1", "space-1", "team", "agent-b", "agent-a", JSON.stringify(["agent-a"]),
    "@agent-b fixture", OLD, OLD, OLD, "deferred", null, "2026-08-12T14:00:00+02:00",
  );
  db.prepare("INSERT INTO future_table VALUES (?)").run(Buffer.from([1, 2, 3]));
  db.close();

  const metaRaw = await readFile(metaPath);
  const relativePath = "spaces/team/meta.json";
  const legacyPath = join(legacyRoot, relativePath);
  const backupPath = join(backupRoot, relativePath);
  await Promise.all([mkdir(dirname(legacyPath), { recursive: true }), mkdir(dirname(backupPath), { recursive: true })]);
  await writeFile(legacyPath, metaRaw);
  await writeFile(backupPath, options.corruptBackup ? Buffer.from("drift") : metaRaw);
  await writeJson(join(backupRoot, "manifest.json"), {
    schema_version: "1.0",
    migration_id: "migration-1",
    status: "applied",
    legacy_root: legacyRoot,
    canonical_root: spaceRoot,
    backup_root: backupRoot,
    source: { files: 1, bytes: metaRaw.byteLength, digest: digest(metaRaw) },
    entries: [{ relative_path: relativePath, bytes: metaRaw.byteLength, sha256: digest(metaRaw) }],
    created_at: OLD,
    updated_at: OLD,
  });
  return { space_root: spaceRoot, migration_root: migrationRoot };
}

function principalRegistry() {
  return reconcilePrincipalCandidates([
    { source_ref: "agent:a", kind: "agent", aliases: [{ namespace: "passport_id", value: "agent-a" }] },
    { source_ref: "agent:b", kind: "agent", aliases: [{ namespace: "passport_id", value: "agent-b" }] },
  ], { mint_id: (source) => id("principal", source) }).registry;
}

function id<K extends "principal" | "project">(kind: K, source: string): CanonicalId<K> {
  const bytes = new TextEncoder().encode(source.padEnd(10, "0")).slice(0, 10);
  return generateCanonicalId(kind, { now: 1_725_000_000_000, entropy: bytes });
}

async function fixturePaths(fixture: { space_root: string; migration_root: string }): Promise<string[]> {
  return [
    join(fixture.space_root, "spaces", "team", "meta.json"),
    join(fixture.space_root, "spaces", "team", "messages.jsonl"),
    join(fixture.space_root, "notifications", "agent-b.jsonl"),
    join(fixture.space_root, "sessions", "agent-a.json"),
    join(fixture.space_root, "live.db"),
    join(fixture.space_root, ".seedrop", "space", "spaces", "team", "meta.json"),
    join(fixture.migration_root, "migration-1", "manifest.json"),
    join(fixture.migration_root, "migration-1", "spaces", "team", "meta.json"),
  ];
}

async function rawDigests(paths: readonly string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, digest(await readFile(path))])));
}

function digest(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
