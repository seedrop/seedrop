import { createHash } from "node:crypto";
import {
  assertPrincipalRegistry,
  assertProjectTransaction,
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
  generateCanonicalId,
  parseCanonicalId,
  projectTransactionDigest,
  resolvePrincipalIdentity,
  buildProjectTransaction,
} from "@seedrop/protocol";
import type {
  CanonicalId,
  JsonValue,
  PrincipalRegistry,
  ProjectEventEnvelope,
  ProjectTransaction,
  ProjectTransactionDigest,
} from "@seedrop/protocol";
import { MigrationContractError, assertMigrationCorpus } from "./contract.js";
import {
  VIEW_HISTORY_IMPORT_VERSION,
  VIEW_SOURCE_DIAGNOSTIC_CODES,
  VIEW_SOURCE_DISPOSITIONS,
  VIEW_SOURCE_FAMILIES,
} from "./types.js";
import type {
  ViewHistoryCollection,
  ViewHistoryImportResult,
  ViewImportRecordReceipt,
  ViewSourceDiagnostic,
  ViewSourceDiagnosticCode,
  ViewSourceDisposition,
  ViewSourceRecord,
} from "./types.js";

const IMPORT_EPOCH_MS = 1_725_000_000_000;
const COMMAND_VERSION = "1.0.0" as const;

export function importViewHistory(input: {
  collection: ViewHistoryCollection;
  project_id: CanonicalId<"project">;
  migration_principal_id: CanonicalId<"principal">;
  principal_registry: PrincipalRegistry;
  snapshot_recorded_at: string;
}): ViewHistoryImportResult {
  assertMigrationCorpus(input.collection.corpus);
  assertPrincipalRegistry(input.principal_registry);
  parseCanonicalId(input.project_id, "project");
  parseCanonicalId(input.migration_principal_id, "principal");
  if (!input.principal_registry.principals.some((principal) => principal.principal_id === input.migration_principal_id)) {
    invalid("migration_principal_id", "unregistered");
  }
  canonicalTimestamp(input.snapshot_recorded_at, "snapshot_recorded_at");
  const sourceRefs = input.collection.records.map((record) => record.source_ref);
  if (new Set(sourceRefs).size !== sourceRefs.length) invalid("collection.records", "duplicate_source_ref");
  if (input.collection.corpus.counts.records !== sourceRefs.length) invalid("collection.records", "corpus_count_mismatch");

  const records = [...input.collection.records].sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  const taskIds = validIds(records, "task", "task_id");
  const runIds = validIds(records, "run", "run_id");
  const transactionRecords: ViewImportRecordReceipt[] = [];
  const transactions: ProjectTransaction[] = [];
  let previousDigest: ProjectTransactionDigest | null = null;

  for (const source of records) {
    const diagnostics = classifyDiagnostics(source, input.principal_registry, taskIds, runIds);
    const disposition = dispositionFor(source, diagnostics);
    const sourcePrincipal = disposition === "quarantined"
      ? null
      : resolveSourcePrincipal(source, input.principal_registry);
    const canonicalSubject = disposition === "quarantined" ? null : canonicalSubjectId(source);
    const occurredAt = sourceTimestamp(source) ?? input.snapshot_recorded_at;
    const recordedAt = occurredAt > input.snapshot_recorded_at ? occurredAt : input.snapshot_recorded_at;
    const baseEvent = event(source, "base", dispositionEvent(disposition), canonicalSubject ?? input.project_id, occurredAt, {
      import_version: VIEW_HISTORY_IMPORT_VERSION,
      source_ref: source.source_ref,
      source_family: source.source_family,
      source_digest: source.source_digest,
      source_schema_version: sourceSchemaVersion(source),
      source_principal_id: sourcePrincipal,
      canonical_subject_id: canonicalSubject,
      disposition,
      diagnostics: diagnostics.map(({ code, reason }) => ({ code, reason })),
      source_payload: disposition === "quarantined" ? null : source.source_payload,
      explicit_links: explicitLinks(source, taskIds, runIds),
    });
    const outcomeEvents = disposition === "quarantined"
      ? []
      : observationEvents(source, canonicalSubject, sourcePrincipal, input.project_id);
    const transaction = buildProjectTransaction({
      command_id: deterministicId("command", `${source.source_ref}\u0000command`),
      command_version: COMMAND_VERSION,
      command_name: "seedrop.migration.import_view_record",
      principal_id: input.migration_principal_id,
      project_id: input.project_id,
      idempotency_key: `seedrop.view-history.v1:${source.source_digest}:${source.source_ref}`,
      input_digest: source.source_digest,
      previous_transaction_digest: previousDigest,
      recorded_at: recordedAt,
      events: [baseEvent, ...outcomeEvents],
    });
    const transactionDigest = projectTransactionDigest(transaction);
    transactions.push(transaction);
    transactionRecords.push(deepFreeze({
      source_ref: source.source_ref,
      source_family: source.source_family,
      source_digest: source.source_digest,
      disposition,
      diagnostic_codes: diagnostics.map((item) => item.code),
      transaction_digest: transactionDigest,
    }));
    previousDigest = transactionDigest;
  }

  const counts = Object.freeze({
    source_records: records.length,
    imported_records: transactionRecords.filter((record) => record.disposition === "imported").length,
    quarantined_records: transactionRecords.filter((record) => record.disposition === "quarantined").length,
    unresolved_records: transactionRecords.filter((record) => record.disposition === "unresolved").length,
    transactions: transactions.length,
    events: transactions.reduce((sum, transaction) => sum + transaction.events.length, 0),
  });
  const result = deepFreeze({
    receipt: {
      import_version: VIEW_HISTORY_IMPORT_VERSION,
      corpus_digest: input.collection.corpus.corpus_digest,
      source_tree_digest: input.collection.source_tree_digest,
      project_id: input.project_id,
      migration_principal_id: input.migration_principal_id,
      transaction_chain_digest: canonicalJsonDigest(transactions.map(projectTransactionDigest)) as ProjectTransactionDigest,
      record_mapping_digest: canonicalJsonDigest(transactionRecords) as ProjectTransactionDigest,
      counts,
    },
    records: transactionRecords,
    transactions,
  });
  assertViewHistoryImportResult(result);
  return result;
}

export function viewHistoryImportBytes(result: ViewHistoryImportResult): Uint8Array {
  assertViewHistoryImportResult(result);
  return canonicalJsonBytes(result);
}

export function viewHistoryImportDigest(result: ViewHistoryImportResult): ProjectTransactionDigest {
  assertViewHistoryImportResult(result);
  return canonicalJsonDigest(result) as ProjectTransactionDigest;
}

export function assertViewHistoryImportResult(result: ViewHistoryImportResult): void {
  exact(result, ["receipt", "records", "transactions"], "result");
  exact(result.receipt, [
    "import_version", "corpus_digest", "source_tree_digest", "project_id",
    "migration_principal_id", "transaction_chain_digest", "record_mapping_digest", "counts",
  ], "receipt");
  exact(result.receipt.counts, [
    "source_records", "imported_records", "quarantined_records", "unresolved_records", "transactions", "events",
  ], "receipt.counts");
  parseCanonicalId(result.receipt.project_id, "project");
  parseCanonicalId(result.receipt.migration_principal_id, "principal");
  if (result.receipt.import_version !== VIEW_HISTORY_IMPORT_VERSION) invalid("receipt.import_version", "unsupported");
  sha256(result.receipt.corpus_digest, "receipt.corpus_digest");
  sha256(result.receipt.source_tree_digest, "receipt.source_tree_digest");
  sha256(result.receipt.transaction_chain_digest, "receipt.transaction_chain_digest");
  sha256(result.receipt.record_mapping_digest, "receipt.record_mapping_digest");
  const sourceRefs = result.records.map((record) => record.source_ref);
  if (new Set(sourceRefs).size !== sourceRefs.length || canonicalJson(sourceRefs) !== canonicalJson([...sourceRefs].sort())) {
    invalid("records", "unique_canonical_order_required");
  }
  if (result.records.length !== result.transactions.length) invalid("transactions", "one_per_source_required");
  let previous: ProjectTransactionDigest | null = null;
  for (const [index, transaction] of result.transactions.entries()) {
    const record = result.records[index]!;
    exact(record, [
      "source_ref", "source_family", "source_digest", "disposition", "diagnostic_codes", "transaction_digest",
    ], "records.item");
    if (typeof record.source_ref !== "string" || record.source_ref.trim().length === 0) invalid("records.source_ref", "nonempty_required");
    if (!(VIEW_SOURCE_FAMILIES as readonly unknown[]).includes(record.source_family)) invalid("records.source_family", "unknown");
    if (!(VIEW_SOURCE_DISPOSITIONS as readonly unknown[]).includes(record.disposition)) invalid("records.disposition", "unknown");
    if (new Set(record.diagnostic_codes).size !== record.diagnostic_codes.length
      || record.diagnostic_codes.some((code) => !(VIEW_SOURCE_DIAGNOSTIC_CODES as readonly unknown[]).includes(code))) {
      invalid("records.diagnostic_codes", "unknown_or_duplicate");
    }
    if (record.disposition === "imported" && record.diagnostic_codes.length !== 0) invalid("records.diagnostic_codes", "imported_must_be_empty");
    if (record.disposition !== "imported" && record.diagnostic_codes.length === 0) invalid("records.diagnostic_codes", "reason_required");
    sha256(record.source_digest, "records.source_digest");
    sha256(record.transaction_digest, "records.transaction_digest");
    assertProjectTransaction(transaction);
    if (transaction.project_id !== result.receipt.project_id
      || transaction.principal_id !== result.receipt.migration_principal_id
      || transaction.command_name !== "seedrop.migration.import_view_record") {
      invalid("transactions", "binding_mismatch");
    }
    if (transaction.previous_transaction_digest !== previous) invalid("transactions", "chain_mismatch");
    const transactionDigest = projectTransactionDigest(transaction);
    if (record.transaction_digest !== transactionDigest) invalid("records.transaction_digest", "mismatch");
    if (record.source_digest !== transaction.input_digest) invalid("records.source_digest", "input_mismatch");
    const baseEvent = transaction.events[0];
    const expectedEvent = dispositionEvent(record.disposition);
    const basePayload = baseEvent && isObject(baseEvent.payload)
      ? baseEvent.payload as Record<string, JsonValue>
      : null;
    if (!baseEvent || baseEvent.event_type !== expectedEvent || basePayload === null
      || basePayload.source_ref !== record.source_ref
      || basePayload.source_family !== record.source_family
      || basePayload.source_digest !== record.source_digest
      || basePayload.disposition !== record.disposition) {
      invalid("transactions.events", "source_mapping_mismatch");
    }
    previous = transactionDigest;
  }
  if (result.receipt.transaction_chain_digest !== canonicalJsonDigest(result.transactions.map(projectTransactionDigest))) {
    invalid("receipt.transaction_chain_digest", "mismatch");
  }
  if (result.receipt.record_mapping_digest !== canonicalJsonDigest(result.records)) invalid("receipt.record_mapping_digest", "mismatch");
  const counts = result.receipt.counts;
  for (const [field, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`receipt.counts.${field}`, "nonnegative_safe_integer_required");
  }
  if (counts.source_records !== result.records.length
    || counts.transactions !== result.transactions.length
    || counts.events !== result.transactions.reduce((sum, transaction) => sum + transaction.events.length, 0)
    || counts.imported_records !== result.records.filter((record) => record.disposition === "imported").length
    || counts.quarantined_records !== result.records.filter((record) => record.disposition === "quarantined").length
    || counts.unresolved_records !== result.records.filter((record) => record.disposition === "unresolved").length
    || counts.imported_records + counts.quarantined_records + counts.unresolved_records !== counts.source_records) {
    invalid("receipt.counts", "summary_or_conservation_mismatch");
  }
  canonicalJson(result);
}

function classifyDiagnostics(
  source: ViewSourceRecord,
  registry: PrincipalRegistry,
  taskIds: Set<string>,
  runIds: Set<string>,
): readonly ViewSourceDiagnostic[] {
  if (source.diagnostics.length > 0) return source.diagnostics;
  const diagnostics: ViewSourceDiagnostic[] = [];
  const actor = sourceActor(source);
  if (actor && resolveAlias(actor, registry) === null) {
    diagnostics.push({ code: "principal_unresolved", reason: `No unique Principal alias resolves source actor ${actor}.` });
  }
  const payload = objectPayload(source);
  if (source.source_family === "task") {
    for (const blocker of strings(payload.blocked_by)) {
      if (!taskIds.has(blocker)) diagnostics.push({ code: "task_blocker_missing", reason: `Task blocker ${blocker} is not present in the admitted View.` });
    }
    for (const run of strings(payload.related_runs)) {
      if (!runIds.has(run)) diagnostics.push({ code: "related_run_missing", reason: `Related Run ${run} is not present in the admitted View.` });
    }
  }
  if (source.source_family === "continuity") {
    diagnostics.push({
      code: "continuity_run_link_absent",
      reason: "ContinuityPacket v1 has no explicit run_id; no timestamp or text heuristic was used.",
    });
  }
  if (source.source_family === "delivery_observation") {
    const observation = isObject(payload.observation) ? payload.observation : {};
    if (typeof observation.run_id !== "string" || !runIds.has(observation.run_id)) {
      diagnostics.push({ code: "delivery_run_missing", reason: "Delivery observation does not resolve to an admitted Run." });
    }
  }
  return Object.freeze(diagnostics.map((item) => Object.freeze(item)));
}

function dispositionFor(source: ViewSourceRecord, diagnostics: readonly ViewSourceDiagnostic[]): ViewSourceDisposition {
  if (source.diagnostics.some((item) => ["invalid_json", "schema_validation", "source_container_invalid"].includes(item.code))) {
    return "quarantined";
  }
  return diagnostics.length > 0 ? "unresolved" : "imported";
}

function dispositionEvent(disposition: ViewSourceDisposition): string {
  switch (disposition) {
    case "imported": return "seedrop.migration.record_imported";
    case "quarantined": return "seedrop.migration.record_quarantined";
    case "unresolved": return "seedrop.migration.record_unresolved";
  }
}

function observationEvents(
  source: ViewSourceRecord,
  canonicalSubject: CanonicalId | null,
  sourcePrincipal: CanonicalId<"principal"> | null,
  projectId: CanonicalId<"project">,
): ProjectEventEnvelope[] {
  const payload = objectPayload(source);
  const events: ProjectEventEnvelope[] = [];
  if (source.source_family === "run" && Array.isArray(payload.validation)) {
    for (const [index, item] of payload.validation.entries()) {
      if (!isObject(item)) continue;
      const observedAt = typeof item.recorded_at === "string" ? item.recorded_at : sourceTimestamp(source)!;
      events.push(event(source, `validation:${index}`, "seedrop.outcome.validation_observed", canonicalSubject ?? projectId, observedAt, {
        observer_principal_id: sourcePrincipal,
        subject_episode_id: canonicalSubject,
        status: item.status ?? "unknown",
        commands: typeof item.command === "string" ? [item.command] : [],
        notes: item.notes ?? null,
        observed_at: observedAt,
        input_digest: source.source_digest,
        build_identity: null,
        source_ref: source.source_ref,
      }));
    }
  }
  if (source.source_family === "continuity" && isObject(payload.validation)) {
    const observedAt = sourceTimestamp(source)!;
    events.push(event(source, "validation:0", "seedrop.outcome.validation_observed", projectId, observedAt, {
      observer_principal_id: sourcePrincipal,
      subject_episode_id: null,
      status: payload.validation.status ?? "unknown",
      commands: strings(payload.validation.commands),
      notes: payload.validation.notes ?? null,
      observed_at: observedAt,
      input_digest: source.source_digest,
      build_identity: null,
      source_ref: source.source_ref,
    }));
  }
  if (source.source_family === "delivery_observation" && isObject(payload.observation)) {
    const observedAt = typeof payload.observed_at === "string" ? payload.observed_at : sourceTimestamp(source)!;
    const episodeId = typeof payload.observation.run_id === "string"
      ? deterministicId("episode", `run:${payload.observation.run_id}`)
      : null;
    events.push(event(source, "delivery:0", "seedrop.outcome.delivery_observed", episodeId ?? projectId, observedAt, {
      observer: payload.observer ?? null,
      observer_principal_id: sourcePrincipal,
      subject_episode_id: episodeId,
      outcome: payload.observation.outcome ?? "unknown",
      observed_at: observedAt,
      input_digest: source.source_digest,
      build_identity: payload.build_identity ?? null,
      repo_root: payload.repo_root ?? null,
      source_ref: source.source_ref,
    }));
  }
  return events;
}

function explicitLinks(source: ViewSourceRecord, taskIds: Set<string>, runIds: Set<string>): JsonValue {
  const payload = objectPayload(source);
  if (source.source_family === "task") {
    return {
      blocked_intent_ids: strings(payload.blocked_by).filter((id) => taskIds.has(id)).map((id) => deterministicId("intent", `task:${id}`)),
      related_episode_ids: strings(payload.related_runs).filter((id) => runIds.has(id)).map((id) => deterministicId("episode", `run:${id}`)),
    };
  }
  if (source.source_family === "delivery_observation" && isObject(payload.observation)
    && typeof payload.observation.run_id === "string" && runIds.has(payload.observation.run_id)) {
    return { related_episode_ids: [deterministicId("episode", `run:${payload.observation.run_id}`)] };
  }
  return {};
}

function canonicalSubjectId(source: ViewSourceRecord): CanonicalId | null {
  const payload = objectPayload(source);
  if (source.source_family === "task" && typeof payload.task_id === "string") return deterministicId("intent", `task:${payload.task_id}`);
  if (source.source_family === "run" && typeof payload.run_id === "string") return deterministicId("episode", `run:${payload.run_id}`);
  if (source.source_family === "signal" && typeof payload.id === "string") return deterministicId("claim", `signal:${payload.id}`);
  if (source.source_family === "delivery_observation" && isObject(payload.observation) && typeof payload.observation.run_id === "string") {
    return deterministicId("episode", `run:${payload.observation.run_id}`);
  }
  return null;
}

function sourceTimestamp(source: ViewSourceRecord): string | null {
  const payload = objectPayload(source);
  const candidates = source.source_family === "task" ? [payload.updated_at, payload.created_at]
    : source.source_family === "run" ? [payload.updated_at, payload.finished_at, payload.started_at]
      : source.source_family === "continuity" ? [payload.created_at]
        : source.source_family === "signal" ? [payload.archived_at, payload.created_at]
          : [payload.observed_at];
  return candidates.find((value): value is string => typeof value === "string" && isCanonicalTimestamp(value)) ?? null;
}

function sourceSchemaVersion(source: ViewSourceRecord): string | null {
  const payload = objectPayload(source);
  return typeof payload.schema_version === "string" ? payload.schema_version : null;
}

function sourceActor(source: ViewSourceRecord): string | null {
  const payload = objectPayload(source);
  if (source.source_family === "task") return typeof payload.owner === "string" ? payload.owner : null;
  if (source.source_family === "run") return typeof payload.agent_id === "string" ? payload.agent_id : null;
  if (source.source_family === "continuity") return typeof payload.agent === "string" ? payload.agent : null;
  if (source.source_family === "signal") return typeof payload.owner === "string" ? payload.owner : null;
  if (source.source_family === "delivery_observation" && isObject(payload.observation)) {
    return typeof payload.observation.agent_id === "string" ? payload.observation.agent_id : null;
  }
  return null;
}

function resolveSourcePrincipal(source: ViewSourceRecord, registry: PrincipalRegistry): CanonicalId<"principal"> | null {
  const actor = sourceActor(source);
  return actor ? resolveAlias(actor, registry) : null;
}

function resolveAlias(value: string, registry: PrincipalRegistry): CanonicalId<"principal"> | null {
  try {
    return resolvePrincipalIdentity(registry, value);
  } catch {
    return null;
  }
}

function validIds(records: readonly ViewSourceRecord[], family: ViewSourceRecord["source_family"], field: string): Set<string> {
  return new Set(records
    .filter((record) => record.source_family === family && record.diagnostics.length === 0)
    .map((record) => objectPayload(record)[field])
    .filter((value): value is string => typeof value === "string"));
}

function event(
  source: ViewSourceRecord,
  suffix: string,
  eventType: string,
  subjectId: CanonicalId,
  occurredAt: string,
  payload: JsonValue,
): ProjectEventEnvelope {
  return {
    event_version: "1.0.0",
    event_id: deterministicId("event", `${source.source_ref}\u0000${suffix}`),
    event_type: eventType,
    subject_id: subjectId,
    occurred_at: occurredAt,
    payload,
  };
}

function deterministicId<K extends "command" | "event" | "intent" | "episode" | "claim">(
  kind: K,
  identity: string,
): CanonicalId<K> {
  return generateCanonicalId(kind, {
    now: IMPORT_EPOCH_MS,
    entropy: createHash("sha256")
      .update(`seedrop.view-history-import.v1\u0000${kind}\u0000${identity}`)
      .digest()
      .subarray(0, 10),
  });
}

function objectPayload(source: ViewSourceRecord): Record<string, any> {
  return isObject(source.source_payload) ? source.source_payload : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: string, field: string): void {
  if (!isCanonicalTimestamp(value)) invalid(field, "canonical_utc_timestamp_required");
}

function isCanonicalTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function invalid(field: string, reason: string): never {
  throw new MigrationContractError("invalid_contract", { field, reason });
}

function exact(value: object, allowed: readonly string[], field: string): void {
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (extras.length > 0 || missing.length > 0) invalid(field, extras.length > 0 ? "unknown_fields" : "missing_fields");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
