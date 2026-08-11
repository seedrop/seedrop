import { canonicalJson, canonicalJsonDigest } from "./canonical-json.js";
import type { JsonValue } from "./canonical-json.js";
import { protocolError } from "./errors.js";
import { parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";
import type { CommandAuditError, CommandRecoveryPlan } from "./commands.js";
import type { ProjectTransactionDigest } from "./project-transactions.js";

export const OUTBOX_EFFECT_VERSION = "1.0.0" as const;
export const OUTBOX_DELIVERY_VERSION = "1.0.0" as const;
export const COMMAND_COMMIT_RECEIPT_VERSION = "1.0.0" as const;
export const COMMAND_EXECUTION_EVENT_TYPES = Object.freeze({
  accepted: "seedrop.command.accepted",
  executing: "seedrop.command.executing",
  committed: "seedrop.command.canonical_committed",
  outbox_declared: "seedrop.outbox.effect_declared",
  repair_recorded: "seedrop.repair.receipt_recorded",
} as const);

export const OUTBOX_DELIVERY_STATES = Object.freeze([
  "delivered",
  "dead_letter",
] as const);
export type OutboxDeliveryState = (typeof OUTBOX_DELIVERY_STATES)[number];

export const COMMAND_COMMIT_OUTCOMES = Object.freeze([
  "completed",
  "effects_pending",
  "needs_repair",
] as const);
export type CommandCommitOutcome = (typeof COMMAND_COMMIT_OUTCOMES)[number];

export interface OutboxEffect {
  effect_version: typeof OUTBOX_EFFECT_VERSION;
  effect_id: CanonicalId<"event">;
  effect_key: string;
  command_id: CanonicalId<"command">;
  project_id: CanonicalId<"project">;
  effect_type: string;
  declared_at: string;
  required: boolean;
  payload_digest: ProjectTransactionDigest;
  payload: JsonValue;
}

export interface BuildOutboxEffectInput {
  effect_version?: typeof OUTBOX_EFFECT_VERSION;
  effect_id: CanonicalId<"event">;
  effect_key: string;
  command_id: CanonicalId<"command">;
  project_id: CanonicalId<"project">;
  effect_type: string;
  declared_at: string;
  required: boolean;
  payload: JsonValue;
}

export interface OutboxDeliveryReceipt {
  delivery_version: typeof OUTBOX_DELIVERY_VERSION;
  receipt_id: CanonicalId<"receipt">;
  effect_id: CanonicalId<"event">;
  effect_key: string;
  command_id: CanonicalId<"command">;
  project_id: CanonicalId<"project">;
  state: OutboxDeliveryState;
  attempt: number;
  recorded_at: string;
  evidence_digest: ProjectTransactionDigest | null;
  error: CommandAuditError | null;
}

export interface BuildOutboxDeliveryReceiptInput extends Omit<OutboxDeliveryReceipt, "delivery_version"> {
  delivery_version?: typeof OUTBOX_DELIVERY_VERSION;
}

export interface CommandCommitReceipt {
  receipt_version: typeof COMMAND_COMMIT_RECEIPT_VERSION;
  receipt_id: CanonicalId<"receipt">;
  command_id: CanonicalId<"command">;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  command_name: string;
  idempotency_key: string;
  input_digest: ProjectTransactionDigest;
  transaction_digest: ProjectTransactionDigest;
  projection_digest: ProjectTransactionDigest;
  outcome: CommandCommitOutcome;
  outbox_effect_count: number;
  outbox_delivered_count: number;
  recorded_at: string;
  recovery: CommandRecoveryPlan | null;
  error: CommandAuditError | null;
}

export interface BuildCommandCommitReceiptInput extends Omit<CommandCommitReceipt, "receipt_version"> {
  receipt_version?: typeof COMMAND_COMMIT_RECEIPT_VERSION;
}

export function buildOutboxEffect(input: BuildOutboxEffectInput): OutboxEffect {
  canonicalJson(input);
  assertExactKeys(input, [
    "effect_version", "effect_id", "effect_key", "command_id", "project_id",
    "effect_type", "declared_at", "required", "payload",
  ], "outbox_effect", outboxInvalid);
  const effectVersion = input.effect_version ?? OUTBOX_EFFECT_VERSION;
  if (effectVersion !== OUTBOX_EFFECT_VERSION) outboxInvalid("effect_version", "unsupported");
  parseCanonicalId(input.effect_id, "event");
  parseCanonicalId(input.command_id, "command");
  parseCanonicalId(input.project_id, "project");
  assertNonEmpty(input.effect_key, "effect_key", outboxInvalid);
  assertNamespaced(input.effect_type, "effect_type", outboxInvalid);
  assertTimestamp(input.declared_at, "declared_at", outboxInvalid);
  if (typeof input.required !== "boolean") outboxInvalid("required", "boolean_required");
  canonicalJson(input.payload);
  return deepFreeze({
    effect_version: effectVersion,
    effect_id: input.effect_id,
    effect_key: input.effect_key,
    command_id: input.command_id,
    project_id: input.project_id,
    effect_type: input.effect_type,
    declared_at: input.declared_at,
    required: input.required,
    payload_digest: canonicalJsonDigest(input.payload) as ProjectTransactionDigest,
    payload: input.payload,
  });
}

export function assertOutboxEffect(effect: OutboxEffect): void {
  canonicalJson(effect);
  assertExactKeys(effect, [
    "effect_version", "effect_id", "effect_key", "command_id", "project_id",
    "effect_type", "declared_at", "required", "payload_digest", "payload",
  ], "outbox_effect", outboxInvalid);
  const rebuilt = buildOutboxEffect({
    effect_version: effect.effect_version,
    effect_id: effect.effect_id,
    effect_key: effect.effect_key,
    command_id: effect.command_id,
    project_id: effect.project_id,
    effect_type: effect.effect_type,
    declared_at: effect.declared_at,
    required: effect.required,
    payload: effect.payload,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(effect)) outboxInvalid("payload_digest", "mismatch");
}

export function buildOutboxDeliveryReceipt(input: BuildOutboxDeliveryReceiptInput): OutboxDeliveryReceipt {
  canonicalJson(input);
  assertExactKeys(input, [
    "delivery_version", "receipt_id", "effect_id", "effect_key", "command_id", "project_id",
    "state", "attempt", "recorded_at", "evidence_digest", "error",
  ], "outbox_delivery", deliveryInvalid);
  const deliveryVersion = input.delivery_version ?? OUTBOX_DELIVERY_VERSION;
  if (deliveryVersion !== OUTBOX_DELIVERY_VERSION) deliveryInvalid("delivery_version", "unsupported");
  parseCanonicalId(input.receipt_id, "receipt");
  parseCanonicalId(input.effect_id, "event");
  parseCanonicalId(input.command_id, "command");
  parseCanonicalId(input.project_id, "project");
  assertNonEmpty(input.effect_key, "effect_key", deliveryInvalid);
  if (!(OUTBOX_DELIVERY_STATES as readonly unknown[]).includes(input.state)) deliveryInvalid("state", "unknown");
  assertPositiveInteger(input.attempt, "attempt", deliveryInvalid);
  assertTimestamp(input.recorded_at, "recorded_at", deliveryInvalid);
  if (input.evidence_digest !== null) assertSha256(input.evidence_digest, "evidence_digest", deliveryInvalid);
  const error = input.error === null ? null : normalizeError(input.error, deliveryInvalid);
  if (input.state === "delivered" && (input.evidence_digest === null || error !== null)) {
    deliveryInvalid("state", "delivered_requires_evidence_without_error");
  }
  if (input.state === "dead_letter" && error === null) deliveryInvalid("error", "required_for_dead_letter");
  return deepFreeze({ ...input, delivery_version: deliveryVersion, error });
}

export function assertOutboxDeliveryReceipt(receipt: OutboxDeliveryReceipt): void {
  const rebuilt = buildOutboxDeliveryReceipt(receipt);
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) deliveryInvalid("receipt", "noncanonical_shape");
}

export function buildCommandCommitReceipt(input: BuildCommandCommitReceiptInput): CommandCommitReceipt {
  canonicalJson(input);
  assertExactKeys(input, [
    "receipt_version", "receipt_id", "command_id", "principal_id", "project_id", "command_name",
    "idempotency_key", "input_digest", "transaction_digest", "projection_digest", "outcome",
    "outbox_effect_count", "outbox_delivered_count", "recorded_at", "recovery", "error",
  ], "command_commit_receipt", commitReceiptInvalid);
  const receiptVersion = input.receipt_version ?? COMMAND_COMMIT_RECEIPT_VERSION;
  if (receiptVersion !== COMMAND_COMMIT_RECEIPT_VERSION) commitReceiptInvalid("receipt_version", "unsupported");
  parseCanonicalId(input.receipt_id, "receipt");
  parseCanonicalId(input.command_id, "command");
  parseCanonicalId(input.principal_id, "principal");
  parseCanonicalId(input.project_id, "project");
  assertNonEmpty(input.command_name, "command_name", commitReceiptInvalid);
  assertNonEmpty(input.idempotency_key, "idempotency_key", commitReceiptInvalid);
  assertSha256(input.input_digest, "input_digest", commitReceiptInvalid);
  assertSha256(input.transaction_digest, "transaction_digest", commitReceiptInvalid);
  assertSha256(input.projection_digest, "projection_digest", commitReceiptInvalid);
  if (!(COMMAND_COMMIT_OUTCOMES as readonly unknown[]).includes(input.outcome)) commitReceiptInvalid("outcome", "unknown");
  assertNonNegativeInteger(input.outbox_effect_count, "outbox_effect_count", commitReceiptInvalid);
  assertNonNegativeInteger(input.outbox_delivered_count, "outbox_delivered_count", commitReceiptInvalid);
  if (input.outbox_delivered_count > input.outbox_effect_count) commitReceiptInvalid("outbox_delivered_count", "exceeds_total");
  assertTimestamp(input.recorded_at, "recorded_at", commitReceiptInvalid);
  const recovery = input.recovery === null ? null : normalizeRecovery(input.recovery, commitReceiptInvalid);
  const error = input.error === null ? null : normalizeError(input.error, commitReceiptInvalid);
  if (input.outcome === "completed") {
    if (input.outbox_delivered_count !== input.outbox_effect_count || recovery !== null || error !== null) {
      commitReceiptInvalid("outcome", "completed_summary_mismatch");
    }
  } else if (recovery === null) {
    commitReceiptInvalid("recovery", "required_for_nonterminal_outcome");
  }
  if (input.outcome === "effects_pending" && error !== null) commitReceiptInvalid("error", "not_permitted");
  if (input.outcome === "needs_repair" && error === null) commitReceiptInvalid("error", "required");
  return deepFreeze({ ...input, receipt_version: receiptVersion, recovery, error });
}

export function assertCommandCommitReceipt(receipt: CommandCommitReceipt): void {
  const rebuilt = buildCommandCommitReceipt(receipt);
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) commitReceiptInvalid("receipt", "noncanonical_shape");
}

function normalizeError(
  error: CommandAuditError,
  invalid: Invalid,
): CommandAuditError {
  assertExactKeys(error, ["code", "message", "retryable", "evidence_digest"], "error", invalid);
  assertNonEmpty(error.code, "error.code", invalid);
  assertNonEmpty(error.message, "error.message", invalid);
  if (typeof error.retryable !== "boolean") invalid("error.retryable", "boolean_required");
  if (error.evidence_digest !== null) assertSha256(error.evidence_digest, "error.evidence_digest", invalid);
  return Object.freeze({ ...error });
}

function normalizeRecovery(plan: CommandRecoveryPlan, invalid: Invalid): CommandRecoveryPlan {
  assertExactKeys(plan, ["owner_principal_id", "action", "recover_by", "attempt_limit"], "recovery", invalid);
  parseCanonicalId(plan.owner_principal_id, "principal");
  assertNonEmpty(plan.action, "recovery.action", invalid);
  assertTimestamp(plan.recover_by, "recovery.recover_by", invalid);
  assertPositiveInteger(plan.attempt_limit, "recovery.attempt_limit", invalid);
  return Object.freeze({ ...plan });
}

type Invalid = (field: string, reason: string) => never;

function assertExactKeys(value: unknown, allowed: readonly string[], field: string, invalid: Invalid): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "object_required");
  const extras = Object.keys(value as object).filter((key) => !allowed.includes(key));
  if (extras.length > 0) invalid(field, `unknown_fields:${extras.sort().join(",")}`);
}

function assertNamespaced(value: unknown, field: string, invalid: Invalid): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)+$/.test(value)) invalid(field, "namespaced_name_required");
}

function assertTimestamp(value: unknown, field: string, invalid: Invalid): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid(field, "canonical_utc_timestamp_required");
  }
}

function assertSha256(value: unknown, field: string, invalid: Invalid): asserts value is ProjectTransactionDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function assertNonEmpty(value: unknown, field: string, invalid: Invalid): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_string_required");
}

function assertNonNegativeInteger(value: unknown, field: string, invalid: Invalid): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field, "nonnegative_integer_required");
}

function assertPositiveInteger(value: unknown, field: string, invalid: Invalid): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(field, "positive_integer_required");
}

function outboxInvalid(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.outbox_effect_invalid", { field, reason });
}

function deliveryInvalid(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.outbox_delivery_invalid", { field, reason });
}

function commitReceiptInvalid(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.command_commit_receipt_invalid", { field, reason });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
