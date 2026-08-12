import {
  assertPrincipalRegistry,
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
  parseCanonicalId,
  resolvePrincipalIdentity,
} from "@seedrop/protocol";
import type { CanonicalId, JsonValue, PrincipalRegistry, ProjectTransactionDigest } from "@seedrop/protocol";
import { MigrationContractError, assertMigrationCorpus } from "./contract.js";
import {
  COORDINATION_AUTHORITY_CLASSES,
  COORDINATION_DIAGNOSTIC_CODES,
  COORDINATION_DISPOSITIONS,
  COORDINATION_RECONCILIATION_VERSION,
  COORDINATION_SOURCE_FAMILIES,
} from "./types.js";
import type {
  CoordinationAuthorityClass,
  CoordinationAuthorityCounts,
  CoordinationDiagnostic,
  CoordinationDisposition,
  CoordinationDispositionCounts,
  CoordinationFamilyCounts,
  CoordinationShadowRecord,
  CoordinationSourceFamily,
  CoordinationSourceRecord,
  MachineCoordinationCollection,
  MachineCoordinationReconciliationResult,
} from "./types.js";

const DEFAULT_TTL_SECONDS = 60;
const QUARANTINE_CODES = new Set([
  "invalid_json",
  "schema_validation",
  "sqlite_unreadable",
  "unsupported_sqlite_table",
]);

export function reconcileMachineCoordination(input: {
  collection: MachineCoordinationCollection;
  principal_registry: PrincipalRegistry;
  snapshot_at: string;
  ttl_seconds?: number;
}): MachineCoordinationReconciliationResult {
  assertMigrationCorpus(input.collection.corpus);
  assertPrincipalRegistry(input.principal_registry);
  assertCollection(input.collection);
  timestamp(input.snapshot_at, "snapshot_at");
  const ttlSeconds = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) invalid("ttl_seconds", "positive_safe_integer_required");

  const context = reconciliationContext(input.collection.records);
  const records = [...input.collection.records]
    .sort((left, right) => left.source_ref.localeCompare(right.source_ref))
    .map((source) => reconcileRecord(source, input.principal_registry, context, input.snapshot_at, ttlSeconds));
  const counts = dispositionCounts(records);
  const familyCounts = COORDINATION_SOURCE_FAMILIES.map((family) => Object.freeze({
    source_family: family,
    ...dispositionCounts(records.filter((record) => record.source_family === family)),
  })) satisfies CoordinationFamilyCounts[];
  const authorityCounts = COORDINATION_AUTHORITY_CLASSES.map((authority) => Object.freeze({
    authority_class: authority,
    ...dispositionCounts(records.filter((record) => record.authority_class === authority)),
  })) satisfies CoordinationAuthorityCounts[];
  const sessionRecords = records.filter((record) => record.source_family === "session" && record.disposition !== "quarantined");
  const online = sessionRecords.filter((record) => object(record.projection).presence
    && object(object(record.projection).presence).online === true).length;
  const rootStatuses = records
    .filter((record) => record.source_family === "root_migration" && record.disposition !== "quarantined")
    .map((record) => object(record.projection).status);

  const receipt = deepFreeze({
    reconciliation_version: COORDINATION_RECONCILIATION_VERSION,
    corpus_digest: input.collection.corpus.corpus_digest,
    source_tree_digest: input.collection.source_tree_digest,
    principal_registry_digest: canonicalJsonDigest(input.principal_registry) as ProjectTransactionDigest,
    record_mapping_digest: canonicalJsonDigest(records) as ProjectTransactionDigest,
    snapshot_at: input.snapshot_at,
    ttl_seconds: ttlSeconds,
    counts,
    family_counts: familyCounts,
    authority_counts: authorityCounts,
    presence: {
      sessions: sessionRecords.length,
      online,
      offline: sessionRecords.length - online,
    },
    root_migrations: {
      manifests: rootStatuses.length,
      applied: rootStatuses.filter((status) => status === "applied").length,
      rolled_back: rootStatuses.filter((status) => status === "rolled_back").length,
    },
  });
  const result = deepFreeze({ receipt, records });
  assertMachineCoordinationReconciliation(result);
  return result;
}

export function machineCoordinationBytes(result: MachineCoordinationReconciliationResult): Uint8Array {
  assertMachineCoordinationReconciliation(result);
  return canonicalJsonBytes(result);
}

export function machineCoordinationDigest(result: MachineCoordinationReconciliationResult): ProjectTransactionDigest {
  assertMachineCoordinationReconciliation(result);
  return canonicalJsonDigest(result) as ProjectTransactionDigest;
}

export function assertMachineCoordinationReconciliation(result: MachineCoordinationReconciliationResult): void {
  exact(result, ["receipt", "records"], "result");
  exact(result.receipt, [
    "reconciliation_version", "corpus_digest", "source_tree_digest", "principal_registry_digest",
    "record_mapping_digest", "snapshot_at", "ttl_seconds", "counts", "family_counts",
    "authority_counts", "presence", "root_migrations",
  ], "receipt");
  exact(result.receipt.counts, countFields(), "receipt.counts");
  exact(result.receipt.presence, ["sessions", "online", "offline"], "receipt.presence");
  exact(result.receipt.root_migrations, ["manifests", "applied", "rolled_back"], "receipt.root_migrations");
  if (result.receipt.reconciliation_version !== COORDINATION_RECONCILIATION_VERSION) {
    invalid("receipt.reconciliation_version", "unsupported");
  }
  for (const [field, value] of [
    ["corpus_digest", result.receipt.corpus_digest],
    ["source_tree_digest", result.receipt.source_tree_digest],
    ["principal_registry_digest", result.receipt.principal_registry_digest],
    ["record_mapping_digest", result.receipt.record_mapping_digest],
  ] as const) sha256(value, `receipt.${field}`);
  timestamp(result.receipt.snapshot_at, "receipt.snapshot_at");
  if (!Number.isSafeInteger(result.receipt.ttl_seconds) || result.receipt.ttl_seconds <= 0) {
    invalid("receipt.ttl_seconds", "positive_safe_integer_required");
  }

  const refs = result.records.map((record) => record.source_ref);
  if (new Set(refs).size !== refs.length || canonicalJson(refs) !== canonicalJson([...refs].sort())) {
    invalid("records", "unique_canonical_order_required");
  }
  for (const record of result.records) assertShadowRecord(record, result.receipt);
  if (result.receipt.record_mapping_digest !== canonicalJsonDigest(result.records)) {
    invalid("receipt.record_mapping_digest", "mismatch");
  }
  assertCounts(result.receipt.counts, dispositionCounts(result.records), "receipt.counts");
  assertGroupedCounts(
    result.receipt.family_counts,
    COORDINATION_SOURCE_FAMILIES,
    "source_family",
    (value) => result.records.filter((record) => record.source_family === value),
    "receipt.family_counts",
  );
  assertGroupedCounts(
    result.receipt.authority_counts,
    COORDINATION_AUTHORITY_CLASSES,
    "authority_class",
    (value) => result.records.filter((record) => record.authority_class === value),
    "receipt.authority_counts",
  );
  const sessions = result.records.filter((record) => record.source_family === "session" && record.disposition !== "quarantined");
  const online = sessions.filter((record) => object(object(record.projection).presence).online === true).length;
  const presence = result.receipt.presence;
  for (const [field, value] of Object.entries(presence)) nonnegative(value, `receipt.presence.${field}`);
  if (presence.sessions !== sessions.length || presence.online !== online
    || presence.offline !== sessions.length - online || presence.online + presence.offline !== presence.sessions) {
    invalid("receipt.presence", "summary_or_conservation_mismatch");
  }
  for (const [field, value] of Object.entries(result.receipt.root_migrations)) {
    nonnegative(value, `receipt.root_migrations.${field}`);
  }
  if (result.receipt.root_migrations.applied + result.receipt.root_migrations.rolled_back
    > result.receipt.root_migrations.manifests) invalid("receipt.root_migrations", "summary_mismatch");
  const roots = result.records.filter((record) => record.source_family === "root_migration" && record.disposition !== "quarantined");
  const statuses = roots.map((record) => object(record.projection).status);
  if (result.receipt.root_migrations.manifests !== roots.length
    || result.receipt.root_migrations.applied !== statuses.filter((status) => status === "applied").length
    || result.receipt.root_migrations.rolled_back !== statuses.filter((status) => status === "rolled_back").length) {
    invalid("receipt.root_migrations", "summary_mismatch");
  }
  canonicalJson(result);
}

interface ReconciliationContext {
  spaces: Set<string>;
  messages: Set<string>;
  sessions: Set<string>;
}

function reconciliationContext(records: readonly CoordinationSourceRecord[]): ReconciliationContext {
  return {
    // Early v1 sessions sometimes persisted the unique Space name in space_id.
    // Both explicit durable aliases are admitted; no fuzzy matching is used.
    spaces: validSpaceAliases(records),
    messages: validValues(records, "message", "id"),
    sessions: validValues(records, "session", "id"),
  };
}

function validSpaceAliases(records: readonly CoordinationSourceRecord[]): Set<string> {
  const aliases = new Set<string>();
  for (const record of records) {
    if (record.source_family !== "space" || hasQuarantineDiagnostic(record.diagnostics)) continue;
    const payload = object(record.source_payload);
    if (typeof payload.id === "string") aliases.add(payload.id);
    if (typeof payload.name === "string") aliases.add(payload.name);
  }
  return aliases;
}

function reconcileRecord(
  source: CoordinationSourceRecord,
  registry: PrincipalRegistry,
  context: ReconciliationContext,
  snapshotAt: string,
  ttlSeconds: number,
): CoordinationShadowRecord {
  const diagnostics = [...source.diagnostics];
  const structuralFailure = hasQuarantineDiagnostic(diagnostics);
  const mapped = new Set<CanonicalId<"principal">>();
  if (!structuralFailure) {
    for (const alias of principalAliases(source)) {
      try {
        mapped.add(resolvePrincipalIdentity(registry, alias));
      } catch {
        diagnostics.push({ code: "principal_unresolved", reason: `No unique Principal resolves coordination alias ${alias}.` });
      }
    }
    diagnostics.push(...referenceDiagnostics(source, context));
  }
  const orderedDiagnostics = uniqueDiagnostics(diagnostics);
  const disposition: CoordinationDisposition = structuralFailure
    ? "quarantined"
    : orderedDiagnostics.length > 0 ? "unresolved" : "imported";
  return deepFreeze({
    source_ref: source.source_ref,
    source_family: source.source_family,
    authority_class: source.authority_class,
    source_digest: source.source_digest,
    disposition,
    mapped_principal_ids: [...mapped].sort(),
    diagnostics: orderedDiagnostics,
    projection: projection(source, context, snapshotAt, ttlSeconds),
  });
}

function projection(
  source: CoordinationSourceRecord,
  context: ReconciliationContext,
  snapshotAt: string,
  ttlSeconds: number,
): JsonValue {
  if (source.source_family === "session" && !hasQuarantineDiagnostic(source.diagnostics)) {
    const payload = object(source.source_payload);
    const lastSeenAt = string(payload.last_seen_at);
    const online = lastSeenAt === null ? false
      : Date.parse(lastSeenAt) >= Date.parse(snapshotAt) - ttlSeconds * 1_000;
    return {
      presence: {
        online,
        last_seen_at: lastSeenAt,
        snapshot_at: snapshotAt,
        ttl_seconds: ttlSeconds,
      },
    };
  }
  if (source.source_family === "session_cache" && !hasQuarantineDiagnostic(source.diagnostics)) {
    const sessionId = string(object(source.source_payload).session_id);
    return { cache_state: sessionId !== null && context.sessions.has(sessionId) ? "live_match" : "stale" };
  }
  if (source.source_family === "root_migration" && !hasQuarantineDiagnostic(source.diagnostics)) {
    return { status: object(object(source.source_payload).manifest).status ?? null };
  }
  return {};
}

function principalAliases(source: CoordinationSourceRecord): string[] {
  const payload = object(source.source_payload);
  const result: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) result.push(value);
  };
  const addArray = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) add(item);
  };
  switch (source.source_family) {
    case "membership": add(payload.passport_id); break;
    case "message": add(payload.author_passport_id); addArray(payload.principal_chain); break;
    case "notification": add(payload.recipient_passport_id); add(payload.sender_passport_id); break;
    case "mention":
      add(payload.recipient_passport_id);
      add(payload.sender_passport_id);
      addArray(payload.sender_principal_chain);
      break;
    case "outbox": {
      add(payload.author_passport_id);
      addArray(payload.recipients_json);
      addArray(payload.unknown_recipients_json);
      const message = object(payload.message_json);
      add(message.author_passport_id);
      addArray(message.principal_chain);
      break;
    }
    case "session":
    case "session_cache": add(payload.passport_id); break;
  }
  return [...new Set(result)].sort();
}

function referenceDiagnostics(source: CoordinationSourceRecord, context: ReconciliationContext): CoordinationDiagnostic[] {
  const payload = object(source.source_payload);
  const diagnostics: CoordinationDiagnostic[] = [];
  const requireSpace = (value: unknown): void => {
    if (typeof value === "string" && !context.spaces.has(value)) {
      diagnostics.push({ code: "space_unresolved", reason: `Referenced Space ${value} is not present in durable authority.` });
    }
  };
  switch (source.source_family) {
    case "membership": requireSpace(payload.space_id); break;
    case "message":
      requireSpace(payload.space_id);
      if (typeof payload.replaces === "string" && !context.messages.has(payload.replaces)) {
        diagnostics.push({ code: "replacement_unresolved", reason: `Replaced Message ${payload.replaces} is not present in durable authority.` });
      }
      break;
    case "notification": {
      const pointer = object(payload.pointer);
      if (pointer.kind === "space-message" && typeof pointer.ref === "string") {
        const parts = pointer.ref.split("/").filter(Boolean);
        const messageId = parts.at(-1)!;
        if (parts.length > 1) requireSpace(parts[0]);
        if (!context.messages.has(messageId)) {
          diagnostics.push({ code: "notification_pointer_unresolved", reason: `Notification pointer Message ${messageId} is not present in durable authority.` });
        }
      }
      break;
    }
    case "mention":
      requireSpace(payload.space_id);
      if (typeof payload.message_id === "string" && !context.messages.has(payload.message_id)) {
        diagnostics.push({ code: "message_unresolved", reason: `Mention Message ${payload.message_id} is not present in durable authority.` });
      }
      break;
    case "outbox":
      requireSpace(payload.space_id);
      if (payload.state === "completed" && typeof payload.message_id === "string" && !context.messages.has(payload.message_id)) {
        diagnostics.push({ code: "message_unresolved", reason: `Completed outbox Message ${payload.message_id} is not present in durable authority.` });
      }
      break;
    case "session":
    case "session_cache": requireSpace(payload.space_id); break;
  }
  return diagnostics;
}

function assertCollection(collection: MachineCoordinationCollection): void {
  exact(collection, ["corpus", "source_tree_digest", "physical_file_count", "physical_byte_count", "records"], "collection");
  sha256(collection.source_tree_digest, "collection.source_tree_digest");
  nonnegative(collection.physical_file_count, "collection.physical_file_count");
  nonnegative(collection.physical_byte_count, "collection.physical_byte_count");
  if (collection.corpus.counts.files !== collection.physical_file_count
    || collection.corpus.counts.bytes !== collection.physical_byte_count
    || collection.corpus.counts.records !== collection.records.length) {
    invalid("collection", "corpus_conservation_mismatch");
  }
  const refs = collection.records.map((record) => record.source_ref);
  if (new Set(refs).size !== refs.length) invalid("collection.records", "unique_source_refs_required");
  for (const record of collection.records) {
    exact(record, ["source_ref", "source_family", "authority_class", "source_digest", "source_payload", "diagnostics"], "collection.records.item");
    if (!(COORDINATION_SOURCE_FAMILIES as readonly string[]).includes(record.source_family)) invalid("collection.records.source_family", "unknown");
    if (!(COORDINATION_AUTHORITY_CLASSES as readonly string[]).includes(record.authority_class)) invalid("collection.records.authority_class", "unknown");
    sha256(record.source_digest, "collection.records.source_digest");
    for (const item of record.diagnostics) assertDiagnostic(item);
  }
}

function assertShadowRecord(
  record: CoordinationShadowRecord,
  receipt: MachineCoordinationReconciliationResult["receipt"],
): void {
  exact(record, [
    "source_ref", "source_family", "authority_class", "source_digest", "disposition",
    "mapped_principal_ids", "diagnostics", "projection",
  ], "records.item");
  if (typeof record.source_ref !== "string" || record.source_ref.trim().length === 0) invalid("records.source_ref", "nonempty_required");
  if (!(COORDINATION_SOURCE_FAMILIES as readonly string[]).includes(record.source_family)) invalid("records.source_family", "unknown");
  if (!(COORDINATION_AUTHORITY_CLASSES as readonly string[]).includes(record.authority_class)) invalid("records.authority_class", "unknown");
  if (!(COORDINATION_DISPOSITIONS as readonly string[]).includes(record.disposition)) invalid("records.disposition", "unknown");
  sha256(record.source_digest, "records.source_digest");
  const principalIds = [...record.mapped_principal_ids];
  if (new Set(principalIds).size !== principalIds.length || canonicalJson(principalIds) !== canonicalJson([...principalIds].sort())) {
    invalid("records.mapped_principal_ids", "unique_canonical_order_required");
  }
  for (const principalId of principalIds) parseCanonicalId(principalId, "principal");
  for (const item of record.diagnostics) assertDiagnostic(item);
  const diagnostics = uniqueDiagnostics(record.diagnostics);
  if (canonicalJson(diagnostics) !== canonicalJson(record.diagnostics)) invalid("records.diagnostics", "unique_canonical_order_required");
  if (record.disposition === "imported" && record.diagnostics.length > 0) invalid("records.diagnostics", "imported_must_be_empty");
  if (record.disposition !== "imported" && record.diagnostics.length === 0) invalid("records.diagnostics", "non_imported_reason_required");
  if (record.disposition === "quarantined" && !hasQuarantineDiagnostic(record.diagnostics)) invalid("records.disposition", "quarantine_reason_required");
  if (record.disposition === "unresolved" && hasQuarantineDiagnostic(record.diagnostics)) invalid("records.disposition", "structural_failure_must_quarantine");
  const value = object(record.projection);
  if (record.source_family === "session" && record.disposition !== "quarantined") {
    exact(value, ["presence"], "records.projection");
    const presence = object(value.presence);
    exact(presence, ["online", "last_seen_at", "snapshot_at", "ttl_seconds"], "records.projection.presence");
    if (typeof presence.online !== "boolean" || presence.snapshot_at !== receipt.snapshot_at
      || presence.ttl_seconds !== receipt.ttl_seconds || (presence.last_seen_at !== null && typeof presence.last_seen_at !== "string")) {
      invalid("records.projection.presence", "binding_mismatch");
    }
  } else if (record.source_family === "session_cache" && record.disposition !== "quarantined") {
    exact(value, ["cache_state"], "records.projection");
    if (value.cache_state !== "live_match" && value.cache_state !== "stale") invalid("records.projection.cache_state", "unknown");
  } else if (record.source_family === "root_migration" && record.disposition !== "quarantined") {
    exact(value, ["status"], "records.projection");
    if (!["preview", "prepared", "applied", "rolled_back"].includes(String(value.status))) {
      invalid("records.projection.status", "unknown");
    }
  } else exact(value, [], "records.projection");
}

function assertDiagnostic(value: CoordinationDiagnostic): void {
  exact(value, ["code", "reason"], "diagnostic");
  if (!(COORDINATION_DIAGNOSTIC_CODES as readonly string[]).includes(value.code)) invalid("diagnostic.code", "unknown");
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) invalid("diagnostic.reason", "nonempty_required");
}

function assertGroupedCounts<K extends CoordinationSourceFamily | CoordinationAuthorityClass>(
  groups: readonly (CoordinationFamilyCounts | CoordinationAuthorityCounts)[],
  expected: readonly K[],
  key: "source_family" | "authority_class",
  records: (value: K) => readonly CoordinationShadowRecord[],
  field: string,
): void {
  if (groups.length !== expected.length) invalid(field, "complete_canonical_groups_required");
  for (const [index, value] of expected.entries()) {
    const group = groups[index] as unknown as Record<string, unknown>;
    exact(group, [key, ...countFields()], `${field}.item`);
    if (group[key] !== value) invalid(field, "complete_canonical_groups_required");
    const counts = Object.fromEntries(countFields().map((name) => [name, group[name]])) as unknown as CoordinationDispositionCounts;
    assertCounts(counts, dispositionCounts(records(value)), `${field}.${value}`);
  }
}

function dispositionCounts(records: readonly CoordinationShadowRecord[]): CoordinationDispositionCounts {
  return Object.freeze({
    source_records: records.length,
    imported_records: records.filter((record) => record.disposition === "imported").length,
    quarantined_records: records.filter((record) => record.disposition === "quarantined").length,
    unresolved_records: records.filter((record) => record.disposition === "unresolved").length,
  });
}

function assertCounts(actual: CoordinationDispositionCounts, expected: CoordinationDispositionCounts, field: string): void {
  exact(actual, countFields(), field);
  for (const [name, value] of Object.entries(actual)) nonnegative(value, `${field}.${name}`);
  if (canonicalJson(actual) !== canonicalJson(expected)
    || actual.imported_records + actual.quarantined_records + actual.unresolved_records !== actual.source_records) {
    invalid(field, "summary_or_conservation_mismatch");
  }
}

function countFields(): string[] {
  return ["source_records", "imported_records", "quarantined_records", "unresolved_records"];
}

function validValues(
  records: readonly CoordinationSourceRecord[],
  family: CoordinationSourceFamily,
  field: string,
): Set<string> {
  return new Set(records
    .filter((record) => record.source_family === family && !hasQuarantineDiagnostic(record.diagnostics))
    .map((record) => object(record.source_payload)[field])
    .filter((value): value is string => typeof value === "string"));
}

function hasQuarantineDiagnostic(diagnostics: readonly CoordinationDiagnostic[]): boolean {
  return diagnostics.some((item) => QUARANTINE_CODES.has(item.code));
}

function uniqueDiagnostics(diagnostics: readonly CoordinationDiagnostic[]): readonly CoordinationDiagnostic[] {
  const keys = new Set<string>();
  return Object.freeze(diagnostics
    .map((item) => Object.freeze({ code: item.code, reason: item.reason }))
    .sort((left, right) => left.code.localeCompare(right.code) || left.reason.localeCompare(right.reason))
    .filter((item) => {
      const key = `${item.code}\u0000${item.reason}`;
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    }));
}

function object(value: unknown): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function timestamp(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field, "canonical_timestamp_required");
}

function sha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function nonnegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field, "nonnegative_safe_integer_required");
}

function exact(value: object, allowed: readonly string[], field: string): void {
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (extras.length > 0 || missing.length > 0) {
    invalid(field, extras.length > 0 ? `unknown_fields:${extras.sort().join(",")}` : `missing_fields:${missing.join(",")}`);
  }
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
