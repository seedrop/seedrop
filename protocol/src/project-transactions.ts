import { canonicalJson, canonicalJsonBytes, canonicalJsonDigest } from "./canonical-json.js";
import { protocolError } from "./errors.js";
import { parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";
import { assertSupportedVersion } from "./versions.js";
import type { JsonValue } from "./canonical-json.js";
import type { ProtocolVersion } from "./versions.js";

export const PROJECT_EVENT_VERSION = "1.0.0" as const;
export const PROJECT_TRANSACTION_VERSION = "1.0.0" as const;

export type ProjectTransactionDigest = `sha256:${string}`;

export interface ProjectEventEnvelope {
  event_version: typeof PROJECT_EVENT_VERSION;
  event_id: CanonicalId<"event">;
  event_type: string;
  subject_id: CanonicalId;
  occurred_at: string;
  payload: JsonValue;
}

export interface BuildProjectEventInput {
  event_version?: typeof PROJECT_EVENT_VERSION;
  event_id: CanonicalId<"event">;
  event_type: string;
  subject_id: CanonicalId;
  occurred_at: string;
  payload: JsonValue;
}

export interface ProjectTransaction {
  transaction_version: typeof PROJECT_TRANSACTION_VERSION;
  command_id: CanonicalId<"command">;
  command_version: ProtocolVersion;
  command_name: string;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  idempotency_key: string;
  input_digest: ProjectTransactionDigest;
  previous_transaction_digest: ProjectTransactionDigest | null;
  recorded_at: string;
  events: readonly ProjectEventEnvelope[];
}

export interface BuildProjectTransactionInput {
  transaction_version?: typeof PROJECT_TRANSACTION_VERSION;
  command_id: CanonicalId<"command">;
  command_version: ProtocolVersion;
  command_name: string;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  idempotency_key: string;
  input_digest: ProjectTransactionDigest;
  previous_transaction_digest: ProjectTransactionDigest | null;
  recorded_at: string;
  events: readonly (ProjectEventEnvelope | BuildProjectEventInput)[];
}

export function buildProjectEvent(input: BuildProjectEventInput): ProjectEventEnvelope {
  canonicalJson(input);
  assertExactKeys(input, [
    "event_version", "event_id", "event_type", "subject_id", "occurred_at", "payload",
  ], "event", eventInvalid);
  const eventVersion = input.event_version ?? PROJECT_EVENT_VERSION;
  if (eventVersion !== PROJECT_EVENT_VERSION) eventInvalid("event_version", "unsupported", { found: eventVersion });
  parseCanonicalId(input.event_id, "event");
  parseCanonicalId(input.subject_id);
  assertEventType(input.event_type);
  assertCanonicalTimestamp(input.occurred_at, "occurred_at", eventInvalid);
  canonicalJson(input.payload);
  return deepFreeze({
    event_version: eventVersion,
    event_id: input.event_id,
    event_type: input.event_type,
    subject_id: input.subject_id,
    occurred_at: input.occurred_at,
    payload: input.payload,
  });
}

export function assertProjectEvent(event: ProjectEventEnvelope): void {
  const rebuilt = buildProjectEvent(event);
  if (canonicalJson(rebuilt) !== canonicalJson(event)) eventInvalid("event", "noncanonical_shape");
}

export function buildProjectTransaction(input: BuildProjectTransactionInput): ProjectTransaction {
  canonicalJson(input);
  assertExactKeys(input, [
    "transaction_version", "command_id", "command_version", "command_name", "principal_id",
    "project_id", "idempotency_key", "input_digest", "previous_transaction_digest", "recorded_at", "events",
  ], "transaction", transactionInvalid);
  const transactionVersion = input.transaction_version ?? PROJECT_TRANSACTION_VERSION;
  if (transactionVersion !== PROJECT_TRANSACTION_VERSION) {
    transactionInvalid("transaction_version", "unsupported", { found: transactionVersion });
  }
  parseCanonicalId(input.command_id, "command");
  parseCanonicalId(input.principal_id, "principal");
  parseCanonicalId(input.project_id, "project");
  const commandVersion = assertSupportedVersion("command", input.command_version);
  assertNonEmpty(input.command_name, "command_name", transactionInvalid);
  assertNonEmpty(input.idempotency_key, "idempotency_key", transactionInvalid);
  assertSha256(input.input_digest, "input_digest", transactionInvalid);
  if (input.previous_transaction_digest !== null) {
    assertSha256(input.previous_transaction_digest, "previous_transaction_digest", transactionInvalid);
  }
  assertCanonicalTimestamp(input.recorded_at, "recorded_at", transactionInvalid);
  if (!Array.isArray(input.events) || input.events.length === 0) transactionInvalid("events", "nonempty_array_required");
  const events = input.events.map((event) => buildProjectEvent(event));
  assertUnique(events.map((event) => event.event_id), "events.event_id", transactionInvalid);
  for (const event of events) {
    if (event.occurred_at > input.recorded_at) {
      transactionInvalid("events.occurred_at", "after_transaction_recorded_at", { event_id: event.event_id });
    }
  }
  return deepFreeze({
    transaction_version: transactionVersion,
    command_id: input.command_id,
    command_version: commandVersion,
    command_name: input.command_name,
    principal_id: input.principal_id,
    project_id: input.project_id,
    idempotency_key: input.idempotency_key,
    input_digest: input.input_digest,
    previous_transaction_digest: input.previous_transaction_digest,
    recorded_at: input.recorded_at,
    events,
  });
}

export function assertProjectTransaction(transaction: ProjectTransaction): void {
  const rebuilt = buildProjectTransaction(transaction);
  if (canonicalJson(rebuilt) !== canonicalJson(transaction)) {
    transactionInvalid("transaction", "noncanonical_shape");
  }
}

export function projectTransactionBytes(transaction: ProjectTransaction): Uint8Array {
  assertProjectTransaction(transaction);
  return canonicalJsonBytes(transaction);
}

export function projectTransactionDigest(transaction: ProjectTransaction): ProjectTransactionDigest {
  assertProjectTransaction(transaction);
  return canonicalJsonDigest(transaction) as ProjectTransactionDigest;
}

function assertEventType(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)+$/.test(value)) {
    eventInvalid("event_type", "registered_name_required");
  }
}

function assertCanonicalTimestamp(
  value: unknown,
  field: string,
  invalid: (field: string, reason: string, extra?: Record<string, string>) => never,
): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid(field, "canonical_utc_timestamp_required");
  }
}

function assertSha256(
  value: unknown,
  field: string,
  invalid: (field: string, reason: string, extra?: Record<string, string>) => never,
): asserts value is ProjectTransactionDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function assertNonEmpty(
  value: unknown,
  field: string,
  invalid: (field: string, reason: string, extra?: Record<string, string>) => never,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_string_required");
}

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  field: string,
  invalid: (field: string, reason: string, extra?: Record<string, string>) => never,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "object_required");
  const keys = Object.keys(value as object);
  const extras = keys.filter((key) => !allowed.includes(key));
  if (extras.length > 0) invalid(field, "unknown_fields", { unknown_fields: extras.sort().join(",") });
}

function assertUnique(
  values: readonly string[],
  field: string,
  invalid: (field: string, reason: string, extra?: Record<string, string>) => never,
): void {
  if (new Set(values).size !== values.length) invalid(field, "duplicate");
}

function eventInvalid(field: string, reason: string, extra: Record<string, string> = {}): never {
  throw protocolError("seedrop.protocol.project_event_invalid", { field, reason, ...extra });
}

function transactionInvalid(field: string, reason: string, extra: Record<string, string> = {}): never {
  throw protocolError("seedrop.protocol.project_transaction_invalid", { field, reason, ...extra });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
