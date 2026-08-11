import { canonicalJson } from "./canonical-json.js";
import type { JsonValue } from "./canonical-json.js";
import { protocolError } from "./errors.js";
import { parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";
import type { ProjectEventEnvelope, ProjectTransactionDigest } from "./project-transactions.js";
import type { LifecycleState } from "./state-model.js";
import { EPISODE_LIFECYCLE, INTENT_LIFECYCLE, LEASE_LIFECYCLE } from "./lifecycles.js";

export const WORK_RECORD_VERSION = "1.0.0" as const;
export const WORK_RECEIPT_VERSION = "1.0.0" as const;
export const WORK_TRANSITION_VERSION = "1.0.0" as const;
export const WORK_CORRECTION_VERSION = "1.0.0" as const;

export const NATIVE_WORK_COMMANDS = Object.freeze({
  open: "seedrop.work.open",
  finish: "seedrop.work.finish",
  expire_lease: "seedrop.lease.expire",
  correct: "seedrop.work.correct",
} as const);

export const WORK_EVENT_TYPES = Object.freeze({
  intent_created: "seedrop.intent.created",
  intent_transitioned: "seedrop.intent.transitioned",
  intent_corrected: "seedrop.intent.corrected",
  episode_started: "seedrop.episode.started",
  episode_transitioned: "seedrop.episode.transitioned",
  episode_corrected: "seedrop.episode.corrected",
  claim_recorded: "seedrop.claim.recorded",
  receipt_recorded: "seedrop.receipt.recorded",
  lease_acquired: "seedrop.lease.acquired",
  lease_released: "seedrop.lease.released",
  lease_expired: "seedrop.lease.expired",
  lease_revoked: "seedrop.lease.revoked",
} as const);
const LEASE_TRANSITION_EVENT_TYPES: readonly string[] = Object.freeze([
  WORK_EVENT_TYPES.lease_released,
  WORK_EVENT_TYPES.lease_expired,
  WORK_EVENT_TYPES.lease_revoked,
]);

export const CLAIM_KINDS = Object.freeze(["scope", "outcome", "correction"] as const);
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const WORK_RECEIPT_KINDS = Object.freeze([
  "episode_started", "episode_finished", "lease_expired", "correction_applied",
] as const);
export type WorkReceiptKind = (typeof WORK_RECEIPT_KINDS)[number];

export interface IntentRecord {
  intent_version: typeof WORK_RECORD_VERSION;
  intent_id: CanonicalId<"intent">;
  project_id: CanonicalId<"project">;
  title: string;
  state: "queued";
  created_by: CanonicalId<"principal">;
  created_at: string;
}

export interface EpisodeRecord {
  episode_version: typeof WORK_RECORD_VERSION;
  episode_id: CanonicalId<"episode">;
  project_id: CanonicalId<"project">;
  intent_id: CanonicalId<"intent">;
  goal: string;
  state: "active";
  started_by: CanonicalId<"principal">;
  started_at: string;
}

export interface ClaimRecord {
  claim_version: typeof WORK_RECORD_VERSION;
  claim_id: CanonicalId<"claim">;
  project_id: CanonicalId<"project">;
  intent_id: CanonicalId<"intent">;
  episode_id: CanonicalId<"episode"> | null;
  claim_kind: ClaimKind;
  statement: string;
  evidence_digests: readonly ProjectTransactionDigest[];
  corrects_claim_id: CanonicalId<"claim"> | null;
  recorded_by: CanonicalId<"principal">;
  recorded_at: string;
}

export interface WorkReceipt {
  receipt_version: typeof WORK_RECEIPT_VERSION;
  receipt_id: CanonicalId<"receipt">;
  receipt_kind: WorkReceiptKind;
  command_id: CanonicalId<"command">;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  subject_id: CanonicalId;
  issued_at: string;
  summary: string;
  evidence_digest: ProjectTransactionDigest | null;
}

export interface LeaseRecord {
  lease_version: typeof WORK_RECORD_VERSION;
  lease_id: CanonicalId<"lease">;
  project_id: CanonicalId<"project">;
  target: string;
  holder_principal_id: CanonicalId<"principal">;
  intent_id: CanonicalId<"intent">;
  episode_id: CanonicalId<"episode">;
  state: "active";
  acquired_at: string;
  expires_at: string;
}

export interface WorkLifecycleTransition {
  transition_version: typeof WORK_TRANSITION_VERSION;
  lifecycle: "intent" | "episode";
  subject_id: CanonicalId<"intent"> | CanonicalId<"episode">;
  from: LifecycleState<"intent"> | LifecycleState<"episode">;
  to: LifecycleState<"intent"> | LifecycleState<"episode">;
  reason: string;
  actor_principal_id: CanonicalId<"principal">;
  recorded_at: string;
}

export interface LeaseTransition {
  transition_version: typeof WORK_TRANSITION_VERSION;
  lease_id: CanonicalId<"lease">;
  from: "active";
  to: "released" | "expired" | "revoked";
  reason: string;
  actor_principal_id: CanonicalId<"principal">;
  recorded_at: string;
}

export interface WorkCorrection {
  correction_version: typeof WORK_CORRECTION_VERSION;
  lifecycle: "intent" | "episode";
  subject_id: CanonicalId<"intent"> | CanonicalId<"episode">;
  corrects_event_id: CanonicalId<"event">;
  from: "reported_complete" | "abandoned" | "failed";
  to: "active";
  reason: string;
  actor_principal_id: CanonicalId<"principal">;
  recorded_at: string;
}

export type WorkDomainRecord =
  | IntentRecord | EpisodeRecord | ClaimRecord | WorkReceipt | LeaseRecord
  | WorkLifecycleTransition | LeaseTransition | WorkCorrection;

export function buildIntentRecord(input: Omit<IntentRecord, "intent_version"> & { intent_version?: typeof WORK_RECORD_VERSION }): IntentRecord {
  exact(input, ["intent_version", "intent_id", "project_id", "title", "state", "created_by", "created_at"]);
  version(input.intent_version, WORK_RECORD_VERSION, "intent_version");
  parseCanonicalId(input.intent_id, "intent");
  parseCanonicalId(input.project_id, "project");
  parseCanonicalId(input.created_by, "principal");
  nonempty(input.title, "title");
  if (input.state !== "queued") invalid("state", "initial_queued_required");
  timestamp(input.created_at, "created_at");
  return frozen({ ...input, intent_version: WORK_RECORD_VERSION });
}

export function buildEpisodeRecord(input: Omit<EpisodeRecord, "episode_version"> & { episode_version?: typeof WORK_RECORD_VERSION }): EpisodeRecord {
  exact(input, ["episode_version", "episode_id", "project_id", "intent_id", "goal", "state", "started_by", "started_at"]);
  version(input.episode_version, WORK_RECORD_VERSION, "episode_version");
  parseCanonicalId(input.episode_id, "episode");
  parseCanonicalId(input.project_id, "project");
  parseCanonicalId(input.intent_id, "intent");
  parseCanonicalId(input.started_by, "principal");
  nonempty(input.goal, "goal");
  if (input.state !== "active") invalid("state", "initial_active_required");
  timestamp(input.started_at, "started_at");
  return frozen({ ...input, episode_version: WORK_RECORD_VERSION });
}

export function buildClaimRecord(input: Omit<ClaimRecord, "claim_version"> & { claim_version?: typeof WORK_RECORD_VERSION }): ClaimRecord {
  exact(input, ["claim_version", "claim_id", "project_id", "intent_id", "episode_id", "claim_kind", "statement", "evidence_digests", "corrects_claim_id", "recorded_by", "recorded_at"]);
  version(input.claim_version, WORK_RECORD_VERSION, "claim_version");
  parseCanonicalId(input.claim_id, "claim");
  parseCanonicalId(input.project_id, "project");
  parseCanonicalId(input.intent_id, "intent");
  if (input.episode_id !== null) parseCanonicalId(input.episode_id, "episode");
  if (input.corrects_claim_id !== null) parseCanonicalId(input.corrects_claim_id, "claim");
  parseCanonicalId(input.recorded_by, "principal");
  if (!(CLAIM_KINDS as readonly unknown[]).includes(input.claim_kind)) invalid("claim_kind", "unknown");
  nonempty(input.statement, "statement");
  const evidence = digests(input.evidence_digests, "evidence_digests");
  timestamp(input.recorded_at, "recorded_at");
  return frozen({ ...input, claim_version: WORK_RECORD_VERSION, evidence_digests: evidence });
}

export function buildWorkReceipt(input: Omit<WorkReceipt, "receipt_version"> & { receipt_version?: typeof WORK_RECEIPT_VERSION }): WorkReceipt {
  exact(input, ["receipt_version", "receipt_id", "receipt_kind", "command_id", "principal_id", "project_id", "subject_id", "issued_at", "summary", "evidence_digest"]);
  version(input.receipt_version, WORK_RECEIPT_VERSION, "receipt_version");
  parseCanonicalId(input.receipt_id, "receipt");
  parseCanonicalId(input.command_id, "command");
  parseCanonicalId(input.principal_id, "principal");
  parseCanonicalId(input.project_id, "project");
  parseCanonicalId(input.subject_id);
  if (!(WORK_RECEIPT_KINDS as readonly unknown[]).includes(input.receipt_kind)) invalid("receipt_kind", "unknown");
  timestamp(input.issued_at, "issued_at");
  nonempty(input.summary, "summary");
  if (input.evidence_digest !== null) digest(input.evidence_digest, "evidence_digest");
  return frozen({ ...input, receipt_version: WORK_RECEIPT_VERSION });
}

export function buildLeaseRecord(input: Omit<LeaseRecord, "lease_version"> & { lease_version?: typeof WORK_RECORD_VERSION }): LeaseRecord {
  exact(input, ["lease_version", "lease_id", "project_id", "target", "holder_principal_id", "intent_id", "episode_id", "state", "acquired_at", "expires_at"]);
  version(input.lease_version, WORK_RECORD_VERSION, "lease_version");
  parseCanonicalId(input.lease_id, "lease");
  parseCanonicalId(input.project_id, "project");
  parseCanonicalId(input.holder_principal_id, "principal");
  parseCanonicalId(input.intent_id, "intent");
  parseCanonicalId(input.episode_id, "episode");
  nonempty(input.target, "target");
  if (input.state !== "active") invalid("state", "initial_active_required");
  timestamp(input.acquired_at, "acquired_at");
  timestamp(input.expires_at, "expires_at");
  if (input.expires_at <= input.acquired_at) invalid("expires_at", "must_follow_acquired_at");
  return frozen({ ...input, lease_version: WORK_RECORD_VERSION });
}

export function buildWorkLifecycleTransition(input: Omit<WorkLifecycleTransition, "transition_version"> & { transition_version?: typeof WORK_TRANSITION_VERSION }): WorkLifecycleTransition {
  exact(input, ["transition_version", "lifecycle", "subject_id", "from", "to", "reason", "actor_principal_id", "recorded_at"]);
  version(input.transition_version, WORK_TRANSITION_VERSION, "transition_version");
  if (input.lifecycle !== "intent" && input.lifecycle !== "episode") invalid("lifecycle", "unknown");
  parseCanonicalId(input.subject_id, input.lifecycle);
  assertWorkTransition(input.lifecycle, input.from, input.to);
  nonempty(input.reason, "reason");
  parseCanonicalId(input.actor_principal_id, "principal");
  timestamp(input.recorded_at, "recorded_at");
  return frozen({ ...input, transition_version: WORK_TRANSITION_VERSION });
}

export function buildLeaseTransition(input: Omit<LeaseTransition, "transition_version"> & { transition_version?: typeof WORK_TRANSITION_VERSION }): LeaseTransition {
  exact(input, ["transition_version", "lease_id", "from", "to", "reason", "actor_principal_id", "recorded_at"]);
  version(input.transition_version, WORK_TRANSITION_VERSION, "transition_version");
  parseCanonicalId(input.lease_id, "lease");
  assertWorkTransition("lease", input.from, input.to);
  nonempty(input.reason, "reason");
  parseCanonicalId(input.actor_principal_id, "principal");
  timestamp(input.recorded_at, "recorded_at");
  return frozen({ ...input, transition_version: WORK_TRANSITION_VERSION });
}

export function buildWorkCorrection(input: Omit<WorkCorrection, "correction_version"> & { correction_version?: typeof WORK_CORRECTION_VERSION }): WorkCorrection {
  exact(input, ["correction_version", "lifecycle", "subject_id", "corrects_event_id", "from", "to", "reason", "actor_principal_id", "recorded_at"]);
  version(input.correction_version, WORK_CORRECTION_VERSION, "correction_version");
  if (input.lifecycle !== "intent" && input.lifecycle !== "episode") invalid("lifecycle", "unknown");
  parseCanonicalId(input.subject_id, input.lifecycle);
  parseCanonicalId(input.corrects_event_id, "event");
  if (!isWorkState(input.lifecycle, input.from) || input.to !== "active") invalid("state", "terminal_to_active_required");
  const terminal = input.lifecycle === "intent" ? ["reported_complete", "abandoned"] : ["reported_complete", "failed", "abandoned"];
  if (!terminal.includes(input.from)) invalid("from", "terminal_state_required");
  nonempty(input.reason, "reason");
  parseCanonicalId(input.actor_principal_id, "principal");
  timestamp(input.recorded_at, "recorded_at");
  return frozen({ ...input, correction_version: WORK_CORRECTION_VERSION });
}

export function assertIntentRecord(record: IntentRecord): void { canonical(record, buildIntentRecord(record), "intent"); }
export function assertEpisodeRecord(record: EpisodeRecord): void { canonical(record, buildEpisodeRecord(record), "episode"); }
export function assertClaimRecord(record: ClaimRecord): void { canonical(record, buildClaimRecord(record), "claim"); }
export function assertWorkReceipt(receipt: WorkReceipt): void { canonical(receipt, buildWorkReceipt(receipt), "receipt"); }
export function assertLeaseRecord(record: LeaseRecord): void { canonical(record, buildLeaseRecord(record), "lease"); }
export function assertWorkLifecycleTransition(record: WorkLifecycleTransition): void {
  canonical(record, buildWorkLifecycleTransition(record), "transition");
}
export function assertLeaseTransition(record: LeaseTransition): void { canonical(record, buildLeaseTransition(record), "lease_transition"); }
export function assertWorkCorrection(record: WorkCorrection): void { canonical(record, buildWorkCorrection(record), "correction"); }

export function assertWorkDomainEvent(event: ProjectEventEnvelope): WorkDomainRecord | null {
  const type = event.event_type;
  let record: WorkDomainRecord | null = null;
  if (type === WORK_EVENT_TYPES.intent_created) record = buildIntentRecord(event.payload as unknown as IntentRecord);
  else if (type === WORK_EVENT_TYPES.episode_started) record = buildEpisodeRecord(event.payload as unknown as EpisodeRecord);
  else if (type === WORK_EVENT_TYPES.claim_recorded) record = buildClaimRecord(event.payload as unknown as ClaimRecord);
  else if (type === WORK_EVENT_TYPES.receipt_recorded) record = buildWorkReceipt(event.payload as unknown as WorkReceipt);
  else if (type === WORK_EVENT_TYPES.lease_acquired) record = buildLeaseRecord(event.payload as unknown as LeaseRecord);
  else if (type === WORK_EVENT_TYPES.intent_transitioned || type === WORK_EVENT_TYPES.episode_transitioned) {
    record = buildWorkLifecycleTransition(event.payload as unknown as WorkLifecycleTransition);
  } else if (type === WORK_EVENT_TYPES.intent_corrected || type === WORK_EVENT_TYPES.episode_corrected) {
    record = buildWorkCorrection(event.payload as unknown as WorkCorrection);
  } else if (LEASE_TRANSITION_EVENT_TYPES.includes(type)) {
    record = buildLeaseTransition(event.payload as unknown as LeaseTransition);
  }
  if (record === null) return null;
  const identity = recordIdentity(record);
  const at = recordTimestamp(record);
  if (event.subject_id !== identity || event.occurred_at !== at) invalid("event", "envelope_mismatch");
  if (type.startsWith("seedrop.intent.") && "lifecycle" in record && record.lifecycle !== "intent") invalid("event", "intent_lifecycle_required");
  if (type.startsWith("seedrop.episode.") && "lifecycle" in record && record.lifecycle !== "episode") invalid("event", "episode_lifecycle_required");
  if (type === WORK_EVENT_TYPES.lease_released && "to" in record && record.to !== "released") invalid("event", "released_state_required");
  if (type === WORK_EVENT_TYPES.lease_expired && "to" in record && record.to !== "expired") invalid("event", "expired_state_required");
  if (type === WORK_EVENT_TYPES.lease_revoked && "to" in record && record.to !== "revoked") invalid("event", "revoked_state_required");
  return record;
}

function recordIdentity(record: WorkDomainRecord): CanonicalId {
  if ("episode_id" in record && !('claim_id' in record) && !('lease_id' in record)) return record.episode_id;
  if ("intent_id" in record && !('claim_id' in record) && !('lease_id' in record)) return record.intent_id;
  if ("claim_id" in record) return record.claim_id;
  if ("receipt_id" in record) return record.receipt_id;
  if ("lease_id" in record) return record.lease_id;
  return record.subject_id;
}

function recordTimestamp(record: WorkDomainRecord): string {
  if ("created_at" in record) return record.created_at;
  if ("started_at" in record) return record.started_at;
  if ("recorded_at" in record) return record.recorded_at;
  if ("issued_at" in record) return record.issued_at;
  return record.acquired_at;
}

function assertWorkTransition(lifecycle: "intent" | "episode" | "lease", from: string, to: string): void {
  const model = lifecycle === "intent" ? INTENT_LIFECYCLE : lifecycle === "episode" ? EPISODE_LIFECYCLE : LEASE_LIFECYCLE;
  if (!(model.states as readonly string[]).includes(from)) {
    throw protocolError("seedrop.protocol.lifecycle_state_unknown", { lifecycle, state: from });
  }
  if (!(model.states as readonly string[]).includes(to)) {
    throw protocolError("seedrop.protocol.lifecycle_state_unknown", { lifecycle, state: to });
  }
  const transitions = model.transitions as Readonly<Record<string, readonly string[]>>;
  if (!(transitions[from] ?? []).includes(to)) {
    throw protocolError("seedrop.protocol.lifecycle_transition_invalid", { lifecycle, from, to });
  }
}

function isWorkState(lifecycle: "intent" | "episode", state: string): boolean {
  const model = lifecycle === "intent" ? INTENT_LIFECYCLE : EPISODE_LIFECYCLE;
  return (model.states as readonly string[]).includes(state);
}

function exact(value: unknown, allowed: readonly string[]): void {
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("record", "object_required");
  const keys = Object.keys(value as object);
  const unknown = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => key !== allowed[0] && !keys.includes(key));
  if (unknown.length > 0 || missing.length > 0) invalid("record", "exact_shape_required", { unknown: unknown.sort().join(","), missing: missing.sort().join(",") });
}

function canonical(input: unknown, rebuilt: unknown, field: string): void {
  if (canonicalJson(input) !== canonicalJson(rebuilt)) invalid(field, "noncanonical_shape");
}

function version(value: unknown, expected: string, field: string): void {
  if (value !== undefined && value !== expected) invalid(field, "unsupported");
}

function nonempty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_string_required");
}

function timestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field, "canonical_utc_timestamp_required");
}

function digest(value: unknown, field: string): asserts value is ProjectTransactionDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function digests(value: unknown, field: string): readonly ProjectTransactionDigest[] {
  if (!Array.isArray(value)) invalid(field, "array_required");
  for (const item of value) digest(item, field);
  const normalized = [...value].sort() as ProjectTransactionDigest[];
  if (new Set(normalized).size !== normalized.length) invalid(field, "duplicate");
  return Object.freeze(normalized);
}

function invalid(field: string, reason: string, extra: Record<string, JsonValue> = {}): never {
  throw protocolError("seedrop.protocol.work_record_invalid", { field, reason, ...extra });
}

function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) frozen(nested);
  }
  return value;
}
