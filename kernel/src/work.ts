import {
  NATIVE_WORK_COMMANDS,
  WORK_EVENT_TYPES,
  buildClaimRecord,
  buildEpisodeRecord,
  buildIntentRecord,
  buildLeaseRecord,
  buildLeaseTransition,
  buildWorkCorrection,
  buildWorkLifecycleTransition,
  buildWorkReceipt,
  canonicalJson,
  canonicalJsonDigest,
  generateCanonicalId,
  parseCanonicalId,
  protocolError,
} from "@seedrop/protocol";
import type {
  CanonicalId,
  JsonValue,
  ProjectTransactionDigest,
} from "@seedrop/protocol";
import {
  activeLeaseForTarget,
  reduceWorkProjection,
} from "@seedrop/project";
import type { WorkProjection } from "@seedrop/project";
import type {
  KernelCommandContext,
  KernelCommandDefinition,
  KernelCommandPlan,
  NativeWorkCommandOptions,
  NativeWorkIdFactory,
} from "./types.js";

export interface OpenWorkPayload {
  intent_id: CanonicalId<"intent">;
  episode_id: CanonicalId<"episode">;
  scope_claim_id: CanonicalId<"claim">;
  receipt_id: CanonicalId<"receipt">;
  lease_id: CanonicalId<"lease">;
  title: string;
  goal: string;
  scope_statement: string;
  target: string;
  lease_expires_at: string;
}

export interface HandoffPayload {
  recipient_principal_id: CanonicalId<"principal">;
  message: string;
}

export interface FinishWorkPayload {
  intent_id: CanonicalId<"intent">;
  episode_id: CanonicalId<"episode">;
  lease_id: CanonicalId<"lease">;
  outcome_claim_id: CanonicalId<"claim">;
  receipt_id: CanonicalId<"receipt">;
  summary: string;
  evidence_digests: readonly ProjectTransactionDigest[];
  handoff: HandoffPayload | null;
}

export interface ExpireLeasePayload {
  lease_id: CanonicalId<"lease">;
  receipt_id: CanonicalId<"receipt">;
  observed_at: string;
  reason: string;
}

export interface CorrectWorkPayload {
  intent_id: CanonicalId<"intent">;
  episode_id: CanonicalId<"episode">;
  intent_event_id: CanonicalId<"event">;
  episode_event_id: CanonicalId<"event">;
  correction_claim_id: CanonicalId<"claim">;
  receipt_id: CanonicalId<"receipt">;
  lease_id: CanonicalId<"lease">;
  target: string;
  lease_expires_at: string;
  reason: string;
}

interface NormalizedNativeOptions {
  clock: NonNullable<NativeWorkCommandOptions["clock"]>;
  ids: NativeWorkIdFactory;
}

export function createNativeWorkCommandDefinitions(
  input: NativeWorkCommandOptions = {},
): readonly KernelCommandDefinition[] {
  const options: NormalizedNativeOptions = {
    clock: input.clock ?? { now: () => new Date().toISOString() },
    ids: input.ids ?? { event: () => generateCanonicalId("event") },
  };
  return Object.freeze([
    definition(NATIVE_WORK_COMMANDS.open, (context) => planOpen(options, context), parseOpen),
    definition(NATIVE_WORK_COMMANDS.finish, (context) => planFinish(options, context), parseFinish),
    definition(NATIVE_WORK_COMMANDS.expire_lease, (context) => planExpiry(options, context), parseExpiry),
    definition(NATIVE_WORK_COMMANDS.correct, (context) => planCorrection(options, context), parseCorrection),
  ]);
}

function definition<T>(
  commandName: string,
  plan: (context: KernelCommandContext) => KernelCommandPlan,
  parse: (payload: JsonValue) => T,
): KernelCommandDefinition {
  return Object.freeze({
    command_name: commandName,
    command_version: "1.0.0",
    kind: "mutation" as const,
    validate: (context: KernelCommandContext) => { parse(context.request.payload); },
    plan,
  });
}

function planOpen(options: NormalizedNativeOptions, context: KernelCommandContext): KernelCommandPlan {
  const payload = parseOpen(context.request.payload);
  const projection = workProjection(context);
  absentRecord(projection.intents, "intent_id", payload.intent_id, "intent_exists");
  absentRecord(projection.episodes, "episode_id", payload.episode_id, "episode_exists");
  absentField(projection.claims, "claim_id", payload.scope_claim_id, "claim_exists");
  absentField(projection.receipts.map((entry) => entry.receipt), "receipt_id", payload.receipt_id, "receipt_exists");
  absentRecord(projection.leases, "lease_id", payload.lease_id, "lease_exists");
  const active = activeLeaseForTarget(projection, payload.target);
  if (active) throw protocolError("seedrop.protocol.lease_conflict", { reason: "target_already_leased", lease_id: active.record.lease_id, target: payload.target });
  const at = now(options);
  if (payload.lease_expires_at <= at) invalid("lease_expires_at", "future_timestamp_required");
  const intent = buildIntentRecord({
    intent_id: payload.intent_id, project_id: context.request.project_id, title: payload.title,
    state: "queued", created_by: context.principal.principal_id, created_at: at,
  });
  const intentTransition = buildWorkLifecycleTransition({
    lifecycle: "intent", subject_id: payload.intent_id, from: "queued", to: "active",
    reason: "episode_started", actor_principal_id: context.principal.principal_id, recorded_at: at,
  });
  const episode = buildEpisodeRecord({
    episode_id: payload.episode_id, project_id: context.request.project_id, intent_id: payload.intent_id,
    goal: payload.goal, state: "active", started_by: context.principal.principal_id, started_at: at,
  });
  const claim = buildClaimRecord({
    claim_id: payload.scope_claim_id, project_id: context.request.project_id, intent_id: payload.intent_id,
    episode_id: payload.episode_id, claim_kind: "scope", statement: payload.scope_statement,
    evidence_digests: [], corrects_claim_id: null, recorded_by: context.principal.principal_id, recorded_at: at,
  });
  const lease = buildLeaseRecord({
    lease_id: payload.lease_id, project_id: context.request.project_id, target: payload.target,
    holder_principal_id: context.principal.principal_id, intent_id: payload.intent_id,
    episode_id: payload.episode_id, state: "active", acquired_at: at, expires_at: payload.lease_expires_at,
  });
  const receipt = buildWorkReceipt({
    receipt_id: payload.receipt_id, receipt_kind: "episode_started", command_id: context.request.command_id,
    principal_id: context.principal.principal_id, project_id: context.request.project_id,
    subject_id: payload.episode_id, issued_at: at, summary: `Started Episode: ${payload.goal}`,
    evidence_digest: null,
  });
  return plan([
    event(options, WORK_EVENT_TYPES.intent_created, payload.intent_id, at, intent),
    event(options, WORK_EVENT_TYPES.intent_transitioned, payload.intent_id, at, intentTransition),
    event(options, WORK_EVENT_TYPES.episode_started, payload.episode_id, at, episode),
    event(options, WORK_EVENT_TYPES.claim_recorded, payload.scope_claim_id, at, claim),
    event(options, WORK_EVENT_TYPES.lease_acquired, payload.lease_id, at, lease),
    event(options, WORK_EVENT_TYPES.receipt_recorded, payload.receipt_id, at, receipt),
  ]);
}

function planFinish(options: NormalizedNativeOptions, context: KernelCommandContext): KernelCommandPlan {
  const payload = parseFinish(context.request.payload);
  const projection = workProjection(context);
  const intent = find(projection.intents, "intent_id", payload.intent_id, "intent_not_found");
  const episode = find(projection.episodes, "episode_id", payload.episode_id, "episode_not_found");
  const lease = find(projection.leases, "lease_id", payload.lease_id, "lease_not_found");
  absentField(projection.claims, "claim_id", payload.outcome_claim_id, "claim_exists");
  absentField(projection.receipts.map((entry) => entry.receipt), "receipt_id", payload.receipt_id, "receipt_exists");
  if (episode.record.intent_id !== intent.record.intent_id || lease.record.intent_id !== intent.record.intent_id
    || lease.record.episode_id !== episode.record.episode_id) conflict("work_identity_mismatch");
  if (intent.state !== "active" || episode.state !== "active") conflict("work_not_active");
  if (lease.state !== "active") throw protocolError("seedrop.protocol.lease_conflict", { reason: "lease_not_active", lease_id: payload.lease_id });
  if (lease.record.holder_principal_id !== context.principal.principal_id) throw protocolError("seedrop.protocol.lease_conflict", { reason: "lease_holder_mismatch" });
  const at = now(options);
  const episodeTransition = buildWorkLifecycleTransition({
    lifecycle: "episode", subject_id: payload.episode_id, from: "active", to: "reported_complete",
    reason: "episode_finished", actor_principal_id: context.principal.principal_id, recorded_at: at,
  });
  const intentTransition = buildWorkLifecycleTransition({
    lifecycle: "intent", subject_id: payload.intent_id, from: "active", to: "reported_complete",
    reason: "episode_finished", actor_principal_id: context.principal.principal_id, recorded_at: at,
  });
  const claim = buildClaimRecord({
    claim_id: payload.outcome_claim_id, project_id: context.request.project_id, intent_id: payload.intent_id,
    episode_id: payload.episode_id, claim_kind: "outcome", statement: payload.summary,
    evidence_digests: payload.evidence_digests, corrects_claim_id: null,
    recorded_by: context.principal.principal_id, recorded_at: at,
  });
  const release = buildLeaseTransition({
    lease_id: payload.lease_id, from: "active", to: "released", reason: "episode_finished",
    actor_principal_id: context.principal.principal_id, recorded_at: at,
  });
  const evidence = payload.evidence_digests.length === 0
    ? null
    : canonicalJsonDigest(payload.evidence_digests) as ProjectTransactionDigest;
  const receipt = buildWorkReceipt({
    receipt_id: payload.receipt_id, receipt_kind: "episode_finished", command_id: context.request.command_id,
    principal_id: context.principal.principal_id, project_id: context.request.project_id,
    subject_id: payload.episode_id, issued_at: at, summary: payload.summary, evidence_digest: evidence,
  });
  const effects = payload.handoff === null ? [] : [{
    effect_id: options.ids.event(),
    effect_key: `handoff:${context.request.project_id}:${payload.episode_id}:${payload.receipt_id}`,
    effect_type: "seedrop.handoff.requested",
    declared_at: at,
    required: true,
    payload: {
      recipient_principal_id: payload.handoff.recipient_principal_id,
      message: payload.handoff.message,
      intent_id: payload.intent_id,
      episode_id: payload.episode_id,
      receipt_id: payload.receipt_id,
    },
  }];
  return plan([
    event(options, WORK_EVENT_TYPES.episode_transitioned, payload.episode_id, at, episodeTransition),
    event(options, WORK_EVENT_TYPES.intent_transitioned, payload.intent_id, at, intentTransition),
    event(options, WORK_EVENT_TYPES.claim_recorded, payload.outcome_claim_id, at, claim),
    event(options, WORK_EVENT_TYPES.lease_released, payload.lease_id, at, release),
    event(options, WORK_EVENT_TYPES.receipt_recorded, payload.receipt_id, at, receipt),
  ], effects);
}

function planExpiry(options: NormalizedNativeOptions, context: KernelCommandContext): KernelCommandPlan {
  const payload = parseExpiry(context.request.payload);
  const projection = workProjection(context);
  const lease = find(projection.leases, "lease_id", payload.lease_id, "lease_not_found");
  absentField(projection.receipts.map((entry) => entry.receipt), "receipt_id", payload.receipt_id, "receipt_exists");
  if (lease.state !== "active") throw protocolError("seedrop.protocol.lease_conflict", { reason: "lease_not_active", lease_id: payload.lease_id });
  if (payload.observed_at < lease.record.expires_at) throw protocolError("seedrop.protocol.lease_conflict", { reason: "lease_not_expired", expires_at: lease.record.expires_at });
  const expiry = buildLeaseTransition({
    lease_id: payload.lease_id, from: "active", to: "expired", reason: payload.reason,
    actor_principal_id: context.principal.principal_id, recorded_at: payload.observed_at,
  });
  const receipt = buildWorkReceipt({
    receipt_id: payload.receipt_id, receipt_kind: "lease_expired", command_id: context.request.command_id,
    principal_id: context.principal.principal_id, project_id: context.request.project_id,
    subject_id: payload.lease_id, issued_at: payload.observed_at,
    summary: `Expired Lease for ${lease.record.target}: ${payload.reason}`, evidence_digest: null,
  });
  return plan([
    event(options, WORK_EVENT_TYPES.lease_expired, payload.lease_id, payload.observed_at, expiry),
    event(options, WORK_EVENT_TYPES.receipt_recorded, payload.receipt_id, payload.observed_at, receipt),
  ]);
}

function planCorrection(options: NormalizedNativeOptions, context: KernelCommandContext): KernelCommandPlan {
  const payload = parseCorrection(context.request.payload);
  const projection = workProjection(context);
  const intent = find(projection.intents, "intent_id", payload.intent_id, "intent_not_found");
  const episode = find(projection.episodes, "episode_id", payload.episode_id, "episode_not_found");
  absentField(projection.claims, "claim_id", payload.correction_claim_id, "claim_exists");
  absentField(projection.receipts.map((entry) => entry.receipt), "receipt_id", payload.receipt_id, "receipt_exists");
  absentRecord(projection.leases, "lease_id", payload.lease_id, "lease_exists");
  if (episode.record.intent_id !== intent.record.intent_id) conflict("work_identity_mismatch");
  if (intent.state_event_id !== payload.intent_event_id || episode.state_event_id !== payload.episode_event_id) conflict("correction_target_stale");
  if (intent.state !== "reported_complete" && intent.state !== "abandoned") conflict("intent_not_terminal");
  if (episode.state !== "reported_complete" && episode.state !== "failed" && episode.state !== "abandoned") conflict("episode_not_terminal");
  const active = activeLeaseForTarget(projection, payload.target);
  if (active) throw protocolError("seedrop.protocol.lease_conflict", { reason: "target_already_leased", lease_id: active.record.lease_id });
  const at = now(options);
  if (payload.lease_expires_at <= at) invalid("lease_expires_at", "future_timestamp_required");
  const intentCorrection = buildWorkCorrection({
    lifecycle: "intent", subject_id: payload.intent_id, corrects_event_id: payload.intent_event_id,
    from: intent.state, to: "active", reason: payload.reason,
    actor_principal_id: context.principal.principal_id, recorded_at: at,
  });
  const episodeCorrection = buildWorkCorrection({
    lifecycle: "episode", subject_id: payload.episode_id, corrects_event_id: payload.episode_event_id,
    from: episode.state, to: "active", reason: payload.reason,
    actor_principal_id: context.principal.principal_id, recorded_at: at,
  });
  const claim = buildClaimRecord({
    claim_id: payload.correction_claim_id, project_id: context.request.project_id,
    intent_id: payload.intent_id, episode_id: payload.episode_id, claim_kind: "correction",
    statement: payload.reason, evidence_digests: [], corrects_claim_id: null,
    recorded_by: context.principal.principal_id, recorded_at: at,
  });
  const lease = buildLeaseRecord({
    lease_id: payload.lease_id, project_id: context.request.project_id, target: payload.target,
    holder_principal_id: context.principal.principal_id, intent_id: payload.intent_id,
    episode_id: payload.episode_id, state: "active", acquired_at: at, expires_at: payload.lease_expires_at,
  });
  const receipt = buildWorkReceipt({
    receipt_id: payload.receipt_id, receipt_kind: "correction_applied", command_id: context.request.command_id,
    principal_id: context.principal.principal_id, project_id: context.request.project_id,
    subject_id: payload.episode_id, issued_at: at, summary: payload.reason, evidence_digest: context.input_digest,
  });
  return plan([
    event(options, WORK_EVENT_TYPES.intent_corrected, payload.intent_id, at, intentCorrection),
    event(options, WORK_EVENT_TYPES.episode_corrected, payload.episode_id, at, episodeCorrection),
    event(options, WORK_EVENT_TYPES.claim_recorded, payload.correction_claim_id, at, claim),
    event(options, WORK_EVENT_TYPES.lease_acquired, payload.lease_id, at, lease),
    event(options, WORK_EVENT_TYPES.receipt_recorded, payload.receipt_id, at, receipt),
  ]);
}

function workProjection(context: KernelCommandContext): WorkProjection {
  if (!context.project_projection.lag.complete) conflict("project_projection_incomplete");
  return reduceWorkProjection(context.project_scan);
}

function event(
  options: NormalizedNativeOptions,
  eventType: string,
  subjectId: CanonicalId,
  occurredAt: string,
  payload: object,
) {
  return { event_id: options.ids.event(), event_type: eventType, subject_id: subjectId, occurred_at: occurredAt, payload: payload as JsonValue };
}

function plan(events: KernelCommandPlan["events"], effects: KernelCommandPlan["effects"] = []): KernelCommandPlan {
  return Object.freeze({ events: Object.freeze(events), effects: Object.freeze(effects), repair_receipt: null });
}

function parseOpen(payload: JsonValue): OpenWorkPayload {
  const record = exact(payload, ["intent_id", "episode_id", "scope_claim_id", "receipt_id", "lease_id", "title", "goal", "scope_statement", "target", "lease_expires_at"]);
  return Object.freeze({
    intent_id: canonicalId(record.intent_id, "intent"), episode_id: canonicalId(record.episode_id, "episode"),
    scope_claim_id: canonicalId(record.scope_claim_id, "claim"), receipt_id: canonicalId(record.receipt_id, "receipt"),
    lease_id: canonicalId(record.lease_id, "lease"), title: text(record.title, "title"), goal: text(record.goal, "goal"),
    scope_statement: text(record.scope_statement, "scope_statement"), target: text(record.target, "target"),
    lease_expires_at: timestamp(record.lease_expires_at, "lease_expires_at"),
  });
}

function parseFinish(payload: JsonValue): FinishWorkPayload {
  const record = exact(payload, ["intent_id", "episode_id", "lease_id", "outcome_claim_id", "receipt_id", "summary", "evidence_digests", "handoff"]);
  const evidence = digestArray(record.evidence_digests);
  let handoff: HandoffPayload | null = null;
  if (record.handoff !== null) {
    const value = exact(record.handoff as JsonValue, ["recipient_principal_id", "message"]);
    handoff = Object.freeze({ recipient_principal_id: canonicalId(value.recipient_principal_id, "principal"), message: text(value.message, "handoff.message") });
  }
  return Object.freeze({
    intent_id: canonicalId(record.intent_id, "intent"), episode_id: canonicalId(record.episode_id, "episode"),
    lease_id: canonicalId(record.lease_id, "lease"), outcome_claim_id: canonicalId(record.outcome_claim_id, "claim"),
    receipt_id: canonicalId(record.receipt_id, "receipt"), summary: text(record.summary, "summary"),
    evidence_digests: evidence, handoff,
  });
}

function parseExpiry(payload: JsonValue): ExpireLeasePayload {
  const record = exact(payload, ["lease_id", "receipt_id", "observed_at", "reason"]);
  return Object.freeze({
    lease_id: canonicalId(record.lease_id, "lease"), receipt_id: canonicalId(record.receipt_id, "receipt"),
    observed_at: timestamp(record.observed_at, "observed_at"), reason: text(record.reason, "reason"),
  });
}

function parseCorrection(payload: JsonValue): CorrectWorkPayload {
  const record = exact(payload, ["intent_id", "episode_id", "intent_event_id", "episode_event_id", "correction_claim_id", "receipt_id", "lease_id", "target", "lease_expires_at", "reason"]);
  return Object.freeze({
    intent_id: canonicalId(record.intent_id, "intent"), episode_id: canonicalId(record.episode_id, "episode"),
    intent_event_id: canonicalId(record.intent_event_id, "event"), episode_event_id: canonicalId(record.episode_event_id, "event"),
    correction_claim_id: canonicalId(record.correction_claim_id, "claim"), receipt_id: canonicalId(record.receipt_id, "receipt"),
    lease_id: canonicalId(record.lease_id, "lease"), target: text(record.target, "target"),
    lease_expires_at: timestamp(record.lease_expires_at, "lease_expires_at"), reason: text(record.reason, "reason"),
  });
}

function exact(value: JsonValue | undefined, fields: readonly string[]): Record<string, JsonValue> {
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("payload", "object_required");
  const record = value as Record<string, JsonValue>;
  const keys = Object.keys(record);
  const unknown = keys.filter((key) => !fields.includes(key));
  const missing = fields.filter((key) => !keys.includes(key));
  if (unknown.length > 0 || missing.length > 0) invalid("payload", "exact_shape_required", { unknown: unknown.sort().join(","), missing: missing.sort().join(",") });
  return record;
}

function canonicalId<K extends "intent" | "episode" | "claim" | "receipt" | "lease" | "event" | "principal">(value: JsonValue | undefined, kind: K): CanonicalId<K> {
  if (typeof value !== "string") invalid(kind, "canonical_id_required");
  return parseCanonicalId(value, kind).value;
}

function text(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_string_required");
  return value;
}

function timestamp(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field, "canonical_utc_timestamp_required");
  return value;
}

function digestArray(value: JsonValue | undefined): readonly ProjectTransactionDigest[] {
  if (!Array.isArray(value)) invalid("evidence_digests", "array_required");
  const result = value.map((item) => {
    if (typeof item !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item)) invalid("evidence_digests", "sha256_required");
    return item as ProjectTransactionDigest;
  }).sort();
  if (new Set(result).size !== result.length) invalid("evidence_digests", "duplicate");
  return Object.freeze(result);
}

function find<T extends { record: Record<K, string> }, K extends string>(items: readonly T[], key: K, id: string, reason: string): T {
  const found = items.find((item) => item.record[key] === id);
  if (!found) conflict(reason, { id });
  return found;
}

function absentField<T, K extends keyof T>(items: readonly T[], key: K, id: string, reason: string): void {
  if (items.some((item) => item[key] === id)) conflict(reason, { id });
}

function absentRecord<T extends { record: Record<K, string> }, K extends string>(items: readonly T[], key: K, id: string, reason: string): void {
  if (items.some((item) => item.record[key] === id)) conflict(reason, { id });
}

function now(options: NormalizedNativeOptions): string {
  return timestamp(options.clock.now() as JsonValue, "clock.now");
}

function invalid(field: string, reason: string, extra: Record<string, JsonValue> = {}): never {
  throw protocolError("seedrop.protocol.command_request_invalid", { field, reason, ...extra });
}

function conflict(reason: string, extra: Record<string, JsonValue> = {}): never {
  throw protocolError("seedrop.protocol.work_state_conflict", { reason, ...extra });
}
