import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  MessageSchema,
  NotificationSchema,
  SessionSchema,
  SpaceMetaSchema,
} from "@seedrop/space";
import { canonicalJson, canonicalJsonDigest } from "@seedrop/protocol";
import type { JsonValue, ProjectTransactionDigest } from "@seedrop/protocol";
import { MigrationContractError, buildMigrationCorpus } from "./contract.js";
import type {
  CoordinationAuthorityClass,
  CoordinationDiagnostic,
  CoordinationSourceFamily,
  CoordinationSourceRecord,
  MachineCoordinationCollection,
  MigrationSourceSummary,
} from "./types.js";

interface PhysicalFile {
  ref: string;
  path: string;
  bytes: number;
  mode: number;
  digest: ProjectTransactionDigest;
}

interface SafeSchema {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues: readonly { path: PropertyKey[]; code: string; message: string }[] };
  };
}

type DatabaseRow = Record<string, string | number | bigint | Uint8Array | null>;
type DatabaseLike = {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
};
type DatabaseCtor = new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => DatabaseLike;

export async function collectMachineCoordination(options: {
  space_root?: string;
  migration_root?: string;
} = {}): Promise<MachineCoordinationCollection> {
  const spaceRoot = resolve(options.space_root ?? join(process.env.HOME ?? "", ".seedrop", "space"));
  const migrationRoot = resolve(options.migration_root ?? join(spaceRoot, "..", "migrations", "space-root"));
  const before = await physicalInventory(spaceRoot, migrationRoot);
  const records: CoordinationSourceRecord[] = [];
  const sources: MigrationSourceSummary[] = [];

  await collectSpaces(spaceRoot, sources, records);
  await collectNotifications(spaceRoot, sources, records);
  await collectSessionCaches(spaceRoot, sources, records);
  await collectLiveDatabase(spaceRoot, before, sources, records);
  await collectRootMigrations(migrationRoot, sources, records);
  addPhysicalReplicaSources(before, sources);

  const after = await physicalInventory(spaceRoot, migrationRoot);
  if (canonicalJson(before.map(physicalEvidence)) !== canonicalJson(after.map(physicalEvidence))) {
    throw new MigrationContractError("source_changed", {
      expected_digest: physicalDigest(before),
      observed_digest: physicalDigest(after),
    });
  }
  const corpus = buildMigrationCorpus(sources);
  const orderedRecords = records.sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  if (corpus.counts.records !== orderedRecords.length) invalid("coordination.records", "source_conservation_failed");
  if (corpus.counts.files !== before.length) invalid("coordination.files", "physical_file_conservation_failed");
  const bytes = before.reduce((sum, file) => sum + file.bytes, 0);
  if (corpus.counts.bytes !== bytes) invalid("coordination.bytes", "physical_byte_conservation_failed");
  return deepFreeze({
    corpus,
    source_tree_digest: physicalDigest(before),
    physical_file_count: before.length,
    physical_byte_count: bytes,
    records: orderedRecords,
  });
}

async function collectSpaces(
  spaceRoot: string,
  sources: MigrationSourceSummary[],
  records: CoordinationSourceRecord[],
): Promise<void> {
  const spacesRoot = join(spaceRoot, "spaces");
  for (const directory of await directories(spacesRoot)) {
    const metaPath = join(spacesRoot, directory, "meta.json");
    if (await exists(metaPath)) {
      const raw = await stableRead(metaPath);
      const sourceRef = `coordination:canonical:spaces/${directory}/meta.json`;
      const parsed = parseJson(raw, SpaceMetaSchema);
      if (parsed.diagnostics.length > 0 || !isObject(parsed.payload)) {
        sources.push(sourceSummary(sourceRef, raw, 1));
        records.push(record(sourceRef, "space", "durable_authority", digest(raw), parsed.payload, parsed.diagnostics));
      } else {
        const meta = asObject(parsed.payload);
        const members = Array.isArray(meta.members) ? meta.members : [];
        sources.push(sourceSummary(sourceRef, raw, 1 + members.length));
        const { members: _members, ...space } = meta;
        records.push(record(`${sourceRef}#space`, "space", "durable_authority", canonicalDigest(space), space, []));
        for (const [index, member] of members.entries()) {
          const payload = asJson({ space_id: meta.id, ...asObject(member) });
          records.push(record(
            `${sourceRef}#membership:${String(index).padStart(6, "0")}`,
            "membership",
            "durable_authority",
            canonicalDigest(payload),
            payload,
            [],
          ));
        }
      }
    }

    const messagesPath = join(spacesRoot, directory, "messages.jsonl");
    if (await exists(messagesPath)) {
      const raw = await stableRead(messagesPath);
      const sourceRef = `coordination:canonical:spaces/${directory}/messages.jsonl`;
      const lines = nonemptyLines(raw);
      sources.push(sourceSummary(sourceRef, raw, lines.length));
      for (const [index, line] of lines.entries()) {
        const parsed = parseJson(line, MessageSchema);
        records.push(record(
          `${sourceRef}#${String(index).padStart(8, "0")}`,
          "message",
          "durable_authority",
          parsed.payload === null ? digest(line) : canonicalDigest(parsed.payload),
          parsed.payload,
          parsed.diagnostics,
        ));
      }
    }
  }
}

async function collectNotifications(
  spaceRoot: string,
  sources: MigrationSourceSummary[],
  records: CoordinationSourceRecord[],
): Promise<void> {
  const root = join(spaceRoot, "notifications");
  for (const file of await files(root, (name) => name.endsWith(".jsonl"))) {
    const raw = await stableRead(file);
    const sourceRef = `coordination:canonical:notifications/${basename(file)}`;
    const lines = nonemptyLines(raw);
    sources.push(sourceSummary(sourceRef, raw, lines.length));
    for (const [index, line] of lines.entries()) {
      const parsed = parseJson(line, NotificationSchema);
      records.push(record(
        `${sourceRef}#${String(index).padStart(8, "0")}`,
        "notification",
        "durable_authority",
        parsed.payload === null ? digest(line) : canonicalDigest(parsed.payload),
        parsed.payload,
        parsed.diagnostics,
      ));
    }
  }
}

async function collectSessionCaches(
  spaceRoot: string,
  sources: MigrationSourceSummary[],
  records: CoordinationSourceRecord[],
): Promise<void> {
  const root = join(spaceRoot, "sessions");
  for (const file of await files(root, (name) => name.endsWith(".json"))) {
    const raw = await stableRead(file);
    const sourceRef = `coordination:client-cache:sessions/${basename(file)}`;
    const parsed = parseJson(raw);
    let payload = parsed.payload;
    const diagnostics = [...parsed.diagnostics];
    if (diagnostics.length === 0 && isObject(payload)) {
      const cache = asObject(payload);
      const allowed = Object.keys(cache).every((key) => key === "sessionId" || key === "spaceId");
      if (!allowed || typeof cache.sessionId !== "string" || cache.sessionId.length === 0
        || (cache.spaceId !== undefined && typeof cache.spaceId !== "string")) {
        diagnostics.push(diagnostic("schema_validation", "Session cache requires sessionId and optional spaceId."));
      } else {
        payload = asJson({
          passport_id: basename(file, ".json"),
          session_id: cache.sessionId,
          space_id: cache.spaceId ?? null,
        });
      }
    }
    sources.push(sourceSummary(sourceRef, raw, 1));
    records.push(record(sourceRef, "session_cache", "client_cache", digest(raw), payload, diagnostics));
  }
}

async function collectLiveDatabase(
  spaceRoot: string,
  inventory: readonly PhysicalFile[],
  sources: MigrationSourceSummary[],
  records: CoordinationSourceRecord[],
): Promise<void> {
  const sourceRef = "coordination:canonical:live-db";
  const dbFiles = inventory.filter((file) => /^canonical\/live\.db(?:-(?:wal|shm))?$/.test(file.ref));
  if (dbFiles.length === 0) return;
  const databasePath = join(spaceRoot, "live.db");
  let databaseRecords: CoordinationSourceRecord[];
  try {
    const Database = await databaseConstructor();
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      databaseRecords = collectDatabaseRows(db, sourceRef);
    } finally {
      db.close();
    }
  } catch (error) {
    databaseRecords = [record(
      `${sourceRef}#unreadable`,
      "unknown_sqlite_record",
      "durable_authority",
      physicalDigest(dbFiles),
      null,
      [diagnostic("sqlite_unreadable", errorMessage(error))],
    )];
  }
  sources.push(physicalSourceSummary(sourceRef, dbFiles, databaseRecords.length));
  records.push(...databaseRecords);
}

function collectDatabaseRows(db: DatabaseLike, sourceRef: string): CoordinationSourceRecord[] {
  const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  const records: CoordinationSourceRecord[] = [];
  for (const { name } of tableRows) {
    const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(name)} ORDER BY rowid`).all() as DatabaseRow[];
    for (const [index, row] of rows.entries()) {
      const ref = `${sourceRef}#${name}:${String(index).padStart(8, "0")}`;
      if (name === "sessions") records.push(databaseSession(ref, row));
      else if (name === "mentions") records.push(databaseMention(ref, row));
      else if (name === "post_outbox_v2") records.push(databaseOutbox(ref, row));
      else records.push(record(
        ref,
        "unknown_sqlite_record",
        "durable_authority",
        canonicalDigest(sqliteRowJson(row)),
        asJson({ table: name, row: sqliteRowJson(row) }),
        [diagnostic("unsupported_sqlite_table", `No v1 coordination adapter is registered for SQLite table ${name}.`)],
      ));
    }
  }
  return records;
}

function databaseSession(sourceRef: string, row: DatabaseRow): CoordinationSourceRecord {
  // The v1 SQLite table predates schema envelopes. Its adapter supplies the
  // public Session version for validation without changing or re-hashing the row.
  const normalized = { schema_version: "1.0", ...compactNulls(row) };
  const parsed = SessionSchema.safeParse(normalized);
  return record(
    sourceRef,
    "session",
    "ttl_projection",
    canonicalDigest(sqliteRowJson(row)),
    sqliteRowJson(row),
    parsed.success ? [] : zodDiagnostics(parsed.error?.issues),
  );
}

function databaseMention(sourceRef: string, row: DatabaseRow): CoordinationSourceRecord {
  const diagnostics: CoordinationDiagnostic[] = [];
  const required = [
    "id", "message_id", "space_id", "space_name", "recipient_passport_id", "sender_passport_id", "content", "created_at",
  ];
  if (required.some((field) => typeof row[field] !== "string" || (row[field] as string).length === 0)) {
    diagnostics.push(diagnostic("schema_validation", "Mention row is missing a required string field."));
  }
  for (const field of ["created_at", "delivered_at", "acked_at", "deferred_until"] as const) {
    if (row[field] !== null && (typeof row[field] !== "string" || !isoTimestamp(row[field] as string))) {
      diagnostics.push(diagnostic("schema_validation", `Mention ${field} must be an ISO timestamp with an explicit offset or null.`));
    }
  }
  if (row.ack_result !== null && !["done", "deferred", "ignored"].includes(String(row.ack_result))) {
    diagnostics.push(diagnostic("schema_validation", "Mention ack_result is unsupported."));
  }
  let chain: JsonValue = [];
  try {
    chain = row.sender_principal_chain === null ? [] : asJson(JSON.parse(String(row.sender_principal_chain)));
    if (!Array.isArray(chain) || chain.some((value) => typeof value !== "string" || value.length === 0)) throw new Error("chain");
  } catch {
    diagnostics.push(diagnostic("schema_validation", "Mention sender_principal_chain must be a JSON string array."));
  }
  const payload = asJson({ ...asObject(sqliteRowJson(row)), sender_principal_chain: chain });
  return record(sourceRef, "mention", "durable_authority", canonicalDigest(sqliteRowJson(row)), payload, diagnostics);
}

function databaseOutbox(sourceRef: string, row: DatabaseRow): CoordinationSourceRecord {
  const diagnostics: CoordinationDiagnostic[] = [];
  if (row.schema_version !== "2.0" || !["pending", "processing", "completed", "dead_letter"].includes(String(row.state))) {
    diagnostics.push(diagnostic("schema_validation", "Outbox schema version or state is unsupported."));
  }
  let message: JsonValue | null = null;
  const arrays: Record<string, JsonValue> = {};
  try {
    message = asJson(JSON.parse(String(row.message_json)));
    if (!MessageSchema.safeParse(message).success) throw new Error("message schema");
  } catch {
    diagnostics.push(diagnostic("schema_validation", "Outbox message_json is not a valid Message."));
  }
  for (const field of ["recipients_json", "unknown_recipients_json", "effect_keys_json"] as const) {
    try {
      const parsed = asJson(JSON.parse(String(row[field])));
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || value.length === 0)) throw new Error("array");
      arrays[field] = parsed;
    } catch {
      diagnostics.push(diagnostic("schema_validation", `Outbox ${field} must be a JSON string array.`));
      arrays[field] = [];
    }
  }
  const payload = asJson({
    ...asObject(sqliteRowJson(row)),
    message_json: message,
    recipients_json: arrays.recipients_json ?? [],
    unknown_recipients_json: arrays.unknown_recipients_json ?? [],
    effect_keys_json: arrays.effect_keys_json ?? [],
  });
  return record(sourceRef, "outbox", "durable_authority", canonicalDigest(sqliteRowJson(row)), payload, diagnostics);
}

async function collectRootMigrations(
  migrationRoot: string,
  sources: MigrationSourceSummary[],
  records: CoordinationSourceRecord[],
): Promise<void> {
  const manifests: Array<{ directory: string; path: string; payload: Record<string, any> }> = [];
  for (const directory of await directories(migrationRoot)) {
    const path = join(migrationRoot, directory, "manifest.json");
    if (!await exists(path)) continue;
    const raw = await stableRead(path);
    const sourceRef = `coordination:root-migration:${directory}:manifest`;
    const parsed = parseJson(raw);
    const diagnostics = [...parsed.diagnostics];
    let payload = parsed.payload;
    if (diagnostics.length === 0 && isObject(payload)) {
      diagnostics.push(...validateRootManifest(payload));
      if (diagnostics.length === 0) manifests.push({ directory, path, payload });
      const observation = await observeRootManifest(payload);
      const observed = asObject(observation);
      const coverage = asObject(observed.canonical_coverage);
      if (observed.backup_matches === false) diagnostics.push(diagnostic("root_backup_mismatch", "Migration backup no longer reconciles to the manifest source."));
      if (coverage.present !== coverage.expected) diagnostics.push(diagnostic("root_canonical_incomplete", "Current canonical root does not contain every manifest path."));
      payload = asJson({ manifest: payload, observed: observation });
    }
    sources.push(sourceSummary(sourceRef, raw, 1));
    records.push(record(sourceRef, "root_migration", "migration_evidence", digest(raw), payload, diagnostics));
  }
  const applied = manifests.filter((item) => item.payload.status === "applied").sort((left, right) => String(left.payload.updated_at).localeCompare(String(right.payload.updated_at))).at(-1);
  if (applied) {
    const target = records.find((record) => record.source_ref === `coordination:root-migration:${applied.directory}:manifest`);
    const targetPayload = target && isObject(target.source_payload) ? asObject(target.source_payload) : null;
    const targetObserved = targetPayload && isObject(targetPayload.observed) ? asObject(targetPayload.observed) : null;
    if (target && targetObserved?.legacy_matches === false) {
      const diagnostics = [...target.diagnostics, diagnostic("root_legacy_mismatch", "Applied migration legacy root no longer reconciles to the source receipt.")];
      const index = records.indexOf(target);
      records[index] = record(target.source_ref, target.source_family, target.authority_class, target.source_digest, target.source_payload, diagnostics);
    }
  }
}

async function observeRootManifest(manifest: Record<string, any>): Promise<JsonValue> {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  return asJson({
    backup_matches: await entriesMatch(String(manifest.backup_root), entries),
    legacy_matches: await entriesMatch(String(manifest.legacy_root), entries),
    canonical_coverage: await entryCoverage(String(manifest.canonical_root), entries),
  });
}

function validateRootManifest(manifest: Record<string, any>): CoordinationDiagnostic[] {
  const diagnostics: CoordinationDiagnostic[] = [];
  if (manifest.schema_version !== "1.0" || typeof manifest.migration_id !== "string"
    || !["preview", "prepared", "applied", "rolled_back"].includes(String(manifest.status))
    || !Array.isArray(manifest.entries) || !isObject(manifest.source)) {
    diagnostics.push(diagnostic("schema_validation", "Root migration manifest shape or status is invalid."));
  }
  return diagnostics;
}

async function entriesMatch(root: string, entries: readonly any[]): Promise<boolean> {
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.relative_path !== "string" || typeof entry.sha256 !== "string") return false;
    try {
      const raw = await stableRead(join(root, entry.relative_path));
      if (digest(raw) !== `sha256:${entry.sha256}` || raw.byteLength !== entry.bytes) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function entryCoverage(root: string, entries: readonly any[]): Promise<JsonValue> {
  let present = 0;
  let matching = 0;
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.relative_path !== "string") continue;
    try {
      const raw = await stableRead(join(root, entry.relative_path));
      present += 1;
      if (raw.byteLength === entry.bytes && digest(raw) === `sha256:${entry.sha256}`) matching += 1;
    } catch {
      // Missing current canonical evidence is reflected in the counts.
    }
  }
  return { expected: entries.length, present, matching };
}

function addPhysicalReplicaSources(inventory: readonly PhysicalFile[], sources: MigrationSourceSummary[]): void {
  const legacy = inventory.filter((file) => file.ref.startsWith("legacy/"));
  if (legacy.length > 0) sources.push(physicalSourceSummary("coordination:physical:legacy-root", legacy, 0));
  const backupIds = [...new Set(inventory
    .filter((file) => file.ref.startsWith("migrations/") && !file.ref.endsWith("/manifest.json"))
    .map((file) => file.ref.split("/")[1]!))].sort();
  for (const id of backupIds) {
    const files = inventory.filter((file) => file.ref.startsWith(`migrations/${id}/`) && !file.ref.endsWith("/manifest.json"));
    sources.push(physicalSourceSummary(`coordination:physical:root-backup:${id}`, files, 0));
  }
}

async function physicalInventory(spaceRoot: string, migrationRoot: string): Promise<PhysicalFile[]> {
  const paths: Array<{ root: string; ref: string }> = [
    { root: join(spaceRoot, "spaces"), ref: "canonical/spaces" },
    { root: join(spaceRoot, "notifications"), ref: "canonical/notifications" },
    { root: join(spaceRoot, "sessions"), ref: "client-cache/sessions" },
    { root: join(spaceRoot, ".seedrop", "space"), ref: "legacy" },
    { root: migrationRoot, ref: "migrations" },
  ];
  const discovered: PhysicalFile[] = [];
  // SQLite's shared-memory file is a process lock map, not durable coordination
  // state. A read-only connection may update it, so it is deliberately excluded
  // from the live canonical snapshot. Historical backup copies remain evidence.
  for (const name of ["live.db", "live.db-wal"]) {
    const path = join(spaceRoot, name);
    if (await exists(path)) discovered.push(await physicalFile(path, `canonical/${name}`));
  }
  for (const entry of paths) discovered.push(...await walkPhysical(entry.root, entry.ref));
  return discovered.sort((left, right) => left.ref.localeCompare(right.ref));
}

async function walkPhysical(root: string, ref: string): Promise<PhysicalFile[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const result: PhysicalFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    const childRef = `${ref}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await walkPhysical(path, childRef));
    else if (entry.isFile()) result.push(await physicalFile(path, childRef));
    else throw new Error(`Unsupported coordination source entry: ${path}`);
  }
  return result;
}

async function physicalFile(path: string, ref: string): Promise<PhysicalFile> {
  const raw = await stableRead(path);
  const details = await lstat(path);
  return { ref: portable(ref), path, bytes: raw.byteLength, mode: details.mode & 0o777, digest: digest(raw) };
}

function physicalEvidence(file: PhysicalFile): JsonValue {
  return { ref: file.ref, bytes: file.bytes, mode: file.mode, digest: file.digest };
}

function physicalDigest(files: readonly PhysicalFile[]): ProjectTransactionDigest {
  return canonicalJsonDigest(files.map(physicalEvidence)) as ProjectTransactionDigest;
}

function physicalSourceSummary(sourceRef: string, files: readonly PhysicalFile[], recordCount: number): MigrationSourceSummary {
  return {
    source_ref: sourceRef,
    source_kind: "coordination",
    source_digest: physicalDigest(files),
    file_count: files.length,
    byte_count: files.reduce((sum, file) => sum + file.bytes, 0),
    record_count: recordCount,
  };
}

function sourceSummary(sourceRef: string, raw: Uint8Array, recordCount: number): MigrationSourceSummary {
  return {
    source_ref: sourceRef,
    source_kind: "coordination",
    source_digest: digest(raw),
    file_count: 1,
    byte_count: raw.byteLength,
    record_count: recordCount,
  };
}

function record(
  sourceRef: string,
  sourceFamily: CoordinationSourceFamily,
  authorityClass: CoordinationAuthorityClass,
  sourceDigest: ProjectTransactionDigest,
  payload: JsonValue | null,
  diagnostics: readonly CoordinationDiagnostic[],
): CoordinationSourceRecord {
  return deepFreeze({
    source_ref: sourceRef,
    source_family: sourceFamily,
    authority_class: authorityClass,
    source_digest: sourceDigest,
    source_payload: payload,
    diagnostics: diagnostics.map((item) => Object.freeze({ ...item })),
  });
}

function parseJson(raw: Uint8Array, schema?: SafeSchema): { payload: JsonValue | null; diagnostics: CoordinationDiagnostic[] } {
  let payload: JsonValue;
  try {
    payload = asJson(JSON.parse(Buffer.from(raw).toString("utf8")));
  } catch (error) {
    return { payload: null, diagnostics: [diagnostic("invalid_json", errorMessage(error))] };
  }
  if (!schema) return { payload, diagnostics: [] };
  const result = schema.safeParse(payload);
  return result.success ? { payload, diagnostics: [] } : { payload, diagnostics: zodDiagnostics(result.error?.issues) };
}

function zodDiagnostics(issues: readonly { path: PropertyKey[]; code: string; message: string }[] | undefined): CoordinationDiagnostic[] {
  const reason = issues?.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}:${issue.message}`).join("; ")
    ?? "Schema validation failed.";
  return [diagnostic("schema_validation", reason)];
}

function diagnostic(code: CoordinationDiagnostic["code"], reason: string): CoordinationDiagnostic {
  return Object.freeze({ code, reason });
}

async function stableRead(path: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await lstat(path, { bigint: true });
    const raw = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs) return raw;
  }
  throw new Error(`Could not obtain a stable read: ${path}`);
}

async function databaseConstructor(): Promise<DatabaseCtor> {
  const loaded = await import("better-sqlite3") as unknown as { default: DatabaseCtor };
  return loaded.default;
}

async function directories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function files(root: string, accept: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && accept(entry.name)).map((entry) => join(root, entry.name)).sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch((error) => errorCode(error) === "ENOENT" ? null : Promise.reject(error))) !== null;
}

function nonemptyLines(raw: Uint8Array): Buffer[] {
  return Buffer.from(raw).toString("utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => Buffer.from(line));
}

function compactNulls(row: DatabaseRow): Record<string, string | number | bigint | Uint8Array> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as Record<string, string | number | bigint | Uint8Array>;
}

function sqliteRowJson(row: DatabaseRow): JsonValue {
  return asJson(Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value === "bigint") return [key, value.toString()];
    if (value instanceof Uint8Array) {
      return [key, { blob_sha256: digest(value), bytes: value.byteLength }];
    }
    return [key, value];
  })));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function digest(raw: Uint8Array): ProjectTransactionDigest {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function canonicalDigest(value: JsonValue): ProjectTransactionDigest {
  return canonicalJsonDigest(value) as ProjectTransactionDigest;
}

function asJson(value: unknown): JsonValue {
  canonicalJson(value as JsonValue);
  return value as JsonValue;
}

function asObject(value: unknown): Record<string, JsonValue> {
  return isObject(value) ? value as Record<string, JsonValue> : {};
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portable(value: string): string {
  return value.split(sep).join("/");
}

function errorCode(error: unknown): string {
  return isObject(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(field: string, reason: string): never {
  throw new MigrationContractError("invalid_contract", { field, reason });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
