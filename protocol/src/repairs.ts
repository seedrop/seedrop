import { canonicalJson, canonicalJsonDigest } from "./canonical-json.js";
import { protocolError } from "./errors.js";
import { parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";

export const REPAIR_RECEIPT_VERSION = "1.0.0" as const;

export type RepairEvidenceRecordId =
  | CanonicalId<"claim">
  | CanonicalId<"receipt">
  | CanonicalId<"event">;

export interface RepairEvidenceRef {
  record_id: RepairEvidenceRecordId;
  role: string;
  digest: string;
  observed_at: string;
}

export interface RepairStateRef {
  state_version: string;
  digest: string;
}

export interface RepairCommandRef {
  name: string;
  input_digest: string;
}

export type RepairOutcome = "applied" | "no_change" | "failed" | "rolled_back";

export interface RepairFailure {
  code: string;
  message: string;
  evidence_digest: string | null;
}

export interface RepairRollback {
  mode: "command" | "snapshot" | "manual" | "unavailable";
  instruction: string | null;
  artifact_digest: string | null;
  unavailable_reason: string | null;
}

export interface RepairJournalLink {
  sequence: number;
  previous_receipt_digest: string | null;
}

export interface RepairReceipt {
  receipt_version: typeof REPAIR_RECEIPT_VERSION;
  receipt_id: CanonicalId<"receipt">;
  repair_command_id: CanonicalId<"command">;
  project_id: CanonicalId<"project">;
  actor_principal_id: CanonicalId<"principal">;
  recovery_owner_principal_id: CanonicalId<"principal">;
  issued_at: string;
  target: {
    kind: string;
    referent: string;
  };
  command: RepairCommandRef;
  evidence: readonly RepairEvidenceRef[];
  before: RepairStateRef;
  after: RepairStateRef;
  outcome: RepairOutcome;
  failure: RepairFailure | null;
  rollback: RepairRollback;
  journal: RepairJournalLink;
}

export interface BuildRepairReceiptInput extends Omit<RepairReceipt, "receipt_version"> {}

export interface RepairReceiptQuery {
  project_id?: CanonicalId<"project">;
  repair_command_id?: CanonicalId<"command">;
  actor_principal_id?: CanonicalId<"principal">;
  recovery_owner_principal_id?: CanonicalId<"principal">;
  target_kind?: string;
  target_referent?: string;
  outcome?: RepairOutcome;
}

export function buildRepairReceipt(input: BuildRepairReceiptInput): RepairReceipt {
  canonicalJson(input);
  assertExactKeys(input, [
    "receipt_id", "repair_command_id", "project_id", "actor_principal_id",
    "recovery_owner_principal_id", "issued_at", "target", "command", "evidence",
    "before", "after", "outcome", "failure", "rollback", "journal",
  ], "repair_receipt");
  parseCanonicalId(input.receipt_id, "receipt");
  parseCanonicalId(input.repair_command_id, "command");
  parseCanonicalId(input.project_id, "project");
  parseCanonicalId(input.actor_principal_id, "principal");
  parseCanonicalId(input.recovery_owner_principal_id, "principal");
  assertTimestamp(input.issued_at, "issued_at");

  const target = normalizeTarget(input.target);
  const command = normalizeCommand(input.command);
  assertArray(input.evidence, "evidence");
  if (input.evidence.length === 0) invalid("evidence", "minimum");
  const evidence = input.evidence.map(normalizeEvidence).sort((left, right) => left.record_id.localeCompare(right.record_id));
  assertUnique(evidence.map((item) => item.record_id), "evidence.record_id");
  if (evidence.some((item) => item.record_id === input.receipt_id)) invalid("evidence.record_id", "self_reference");
  for (const item of evidence) {
    if (Date.parse(item.observed_at) > Date.parse(input.issued_at)) invalid("evidence.observed_at", "after_issued_at");
  }
  const before = normalizeState(input.before, "before");
  const after = normalizeState(input.after, "after");
  if (!(input.outcome === "applied" || input.outcome === "no_change" || input.outcome === "failed" || input.outcome === "rolled_back")) {
    invalid("outcome", "unknown");
  }
  const failure = input.failure === null ? null : normalizeFailure(input.failure);
  if ((input.outcome === "failed") !== (failure !== null)) {
    invalid("failure", input.outcome === "failed" ? "required" : "not_permitted");
  }
  const equalStates = canonicalJson(before) === canonicalJson(after);
  if (input.outcome === "applied" && equalStates) invalid("after", "applied_without_change");
  if (input.outcome === "no_change" && !equalStates) {
    invalid("after", "nonmutation_outcome_changed_state");
  }
  const rollback = normalizeRollback(input.rollback);
  const journal = normalizeJournal(input.journal);

  return deepFreeze({
    receipt_version: REPAIR_RECEIPT_VERSION,
    receipt_id: input.receipt_id,
    repair_command_id: input.repair_command_id,
    project_id: input.project_id,
    actor_principal_id: input.actor_principal_id,
    recovery_owner_principal_id: input.recovery_owner_principal_id,
    issued_at: input.issued_at,
    target,
    command,
    evidence,
    before,
    after,
    outcome: input.outcome,
    failure,
    rollback,
    journal,
  });
}

export function assertRepairReceipt(receipt: RepairReceipt): void {
  canonicalJson(receipt);
  if (receipt.receipt_version !== REPAIR_RECEIPT_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "repair_receipt",
      found: receipt.receipt_version,
    });
  }
  const rebuilt = buildRepairReceipt({
    receipt_id: receipt.receipt_id,
    repair_command_id: receipt.repair_command_id,
    project_id: receipt.project_id,
    actor_principal_id: receipt.actor_principal_id,
    recovery_owner_principal_id: receipt.recovery_owner_principal_id,
    issued_at: receipt.issued_at,
    target: receipt.target,
    command: receipt.command,
    evidence: receipt.evidence,
    before: receipt.before,
    after: receipt.after,
    outcome: receipt.outcome,
    failure: receipt.failure,
    rollback: receipt.rollback,
    journal: receipt.journal,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) {
    throw protocolError("seedrop.protocol.repair_receipt_invalid", {
      reason: "inconsistent",
      expected_digest: canonicalJsonDigest(rebuilt),
      received_digest: canonicalJsonDigest(receipt),
    });
  }
}

export function assertRepairJournal(receipts: readonly RepairReceipt[]): void {
  assertArray(receipts, "repair_journal");
  canonicalJson(receipts);
  const ordered = [...receipts].sort((left, right) => left.journal.sequence - right.journal.sequence);
  const duplicate = ordered.find((receipt, index) => ordered.findIndex((item) => item.receipt_id === receipt.receipt_id) !== index);
  if (duplicate) journalInvalid("duplicate_receipt_id", duplicate.receipt_id);
  for (const receipt of ordered) assertRepairReceipt(receipt);
  const projectIds = new Set(ordered.map((receipt) => receipt.project_id));
  if (projectIds.size > 1) journalInvalid("mixed_project_journal", ordered[0]!.receipt_id);
  for (let index = 0; index < ordered.length; index += 1) {
    const receipt = ordered[index]!;
    const expectedSequence = index + 1;
    if (receipt.journal.sequence !== expectedSequence) journalInvalid("sequence_gap", receipt.receipt_id);
    const expectedPrevious = index === 0 ? null : canonicalJsonDigest(ordered[index - 1]!);
    if (receipt.journal.previous_receipt_digest !== expectedPrevious) {
      journalInvalid("previous_digest_mismatch", receipt.receipt_id);
    }
    if (index > 0 && Date.parse(receipt.issued_at) <= Date.parse(ordered[index - 1]!.issued_at)) {
      journalInvalid("issued_at_not_strictly_increasing", receipt.receipt_id);
    }
  }
}

export function queryRepairReceipts(
  receipts: readonly RepairReceipt[],
  query: RepairReceiptQuery = {},
): readonly RepairReceipt[] {
  canonicalJson(query);
  assertExactKeys(query, [
    "project_id", "repair_command_id", "actor_principal_id", "recovery_owner_principal_id",
    "target_kind", "target_referent", "outcome",
  ], "repair_query");
  if (query.project_id !== undefined) parseCanonicalId(query.project_id, "project");
  if (query.repair_command_id !== undefined) parseCanonicalId(query.repair_command_id, "command");
  if (query.actor_principal_id !== undefined) parseCanonicalId(query.actor_principal_id, "principal");
  if (query.recovery_owner_principal_id !== undefined) parseCanonicalId(query.recovery_owner_principal_id, "principal");
  if (query.target_kind !== undefined) assertNonEmpty(query.target_kind, "repair_query.target_kind");
  if (query.target_referent !== undefined) assertNonEmpty(query.target_referent, "repair_query.target_referent");
  if (query.outcome !== undefined && !(query.outcome === "applied" || query.outcome === "no_change" || query.outcome === "failed" || query.outcome === "rolled_back")) {
    invalid("repair_query.outcome", "unknown");
  }
  assertRepairJournal(receipts);
  return Object.freeze([...receipts]
    .sort((left, right) => left.journal.sequence - right.journal.sequence)
    .filter((receipt) =>
      (query.project_id === undefined || receipt.project_id === query.project_id)
      && (query.repair_command_id === undefined || receipt.repair_command_id === query.repair_command_id)
      && (query.actor_principal_id === undefined || receipt.actor_principal_id === query.actor_principal_id)
      && (query.recovery_owner_principal_id === undefined || receipt.recovery_owner_principal_id === query.recovery_owner_principal_id)
      && (query.target_kind === undefined || receipt.target.kind === query.target_kind)
      && (query.target_referent === undefined || receipt.target.referent === query.target_referent)
      && (query.outcome === undefined || receipt.outcome === query.outcome)));
}

function normalizeTarget(target: RepairReceipt["target"]): RepairReceipt["target"] {
  assertExactKeys(target, ["kind", "referent"], "target");
  assertNonEmpty(target.kind, "target.kind");
  assertNonEmpty(target.referent, "target.referent");
  return Object.freeze({ ...target });
}

function normalizeCommand(command: RepairCommandRef): RepairCommandRef {
  assertExactKeys(command, ["name", "input_digest"], "command");
  assertNonEmpty(command.name, "command.name");
  assertSha256(command.input_digest, "command.input_digest");
  return Object.freeze({ ...command });
}

function normalizeEvidence(item: RepairEvidenceRef, index: number): RepairEvidenceRef {
  assertExactKeys(item, ["record_id", "role", "digest", "observed_at"], `evidence[${index}]`);
  assertEvidenceId(item.record_id);
  assertNonEmpty(item.role, `evidence[${index}].role`);
  assertSha256(item.digest, `evidence[${index}].digest`);
  assertTimestamp(item.observed_at, `evidence[${index}].observed_at`);
  return Object.freeze({ ...item });
}

function normalizeState(state: RepairStateRef, field: string): RepairStateRef {
  assertExactKeys(state, ["state_version", "digest"], field);
  assertNonEmpty(state.state_version, `${field}.state_version`);
  assertSha256(state.digest, `${field}.digest`);
  return Object.freeze({ ...state });
}

function normalizeFailure(failure: RepairFailure): RepairFailure {
  assertExactKeys(failure, ["code", "message", "evidence_digest"], "failure");
  assertNonEmpty(failure.code, "failure.code");
  assertNonEmpty(failure.message, "failure.message");
  if (failure.evidence_digest !== null) assertSha256(failure.evidence_digest, "failure.evidence_digest");
  return Object.freeze({ ...failure });
}

function normalizeRollback(rollback: RepairRollback): RepairRollback {
  assertExactKeys(rollback, ["mode", "instruction", "artifact_digest", "unavailable_reason"], "rollback");
  if (!(rollback.mode === "command" || rollback.mode === "snapshot" || rollback.mode === "manual" || rollback.mode === "unavailable")) {
    invalid("rollback.mode", "unknown");
  }
  if (rollback.mode === "unavailable") {
    if (rollback.instruction !== null || rollback.artifact_digest !== null) invalid("rollback", "unavailable_has_action");
    if (rollback.unavailable_reason === null) invalid("rollback.unavailable_reason", "required");
    assertNonEmpty(rollback.unavailable_reason, "rollback.unavailable_reason");
  } else {
    if (rollback.instruction === null) invalid("rollback.instruction", "required");
    assertNonEmpty(rollback.instruction, "rollback.instruction");
    if (rollback.unavailable_reason !== null) invalid("rollback.unavailable_reason", "not_permitted");
    if (rollback.mode === "snapshot" && rollback.artifact_digest === null) invalid("rollback.artifact_digest", "required");
    if (rollback.artifact_digest !== null) assertSha256(rollback.artifact_digest, "rollback.artifact_digest");
  }
  return Object.freeze({ ...rollback });
}

function normalizeJournal(journal: RepairJournalLink): RepairJournalLink {
  assertExactKeys(journal, ["sequence", "previous_receipt_digest"], "journal");
  assertPositiveInteger(journal.sequence, "journal.sequence");
  if (journal.previous_receipt_digest !== null) assertSha256(journal.previous_receipt_digest, "journal.previous_receipt_digest");
  return Object.freeze({ ...journal });
}

function assertEvidenceId(value: RepairEvidenceRecordId): void {
  for (const kind of ["claim", "receipt", "event"] as const) {
    try {
      parseCanonicalId(value, kind);
      return;
    } catch {
      // Try the next evidence record kind.
    }
  }
  invalid("evidence.record_id", "wrong_kind");
}

function assertExactKeys(value: unknown, allowed: readonly string[], field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "object_required");
  const extras = Object.keys(value as object).filter((key) => !allowed.includes(key));
  if (extras.length > 0) invalid(field, "unknown_fields", { unknown_fields: extras.sort().join(",") });
}

function assertArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) invalid(field, "array_required");
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid(field, "timestamp_required");
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_string_required");
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(field, "positive_integer_required");
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(field, "duplicate");
}

function invalid(field: string, reason: string, extra: Record<string, string> = {}): never {
  throw protocolError("seedrop.protocol.repair_receipt_invalid", { field, reason, ...extra });
}

function journalInvalid(reason: string, receiptId: CanonicalId<"receipt">): never {
  throw protocolError("seedrop.protocol.repair_journal_invalid", { reason, receipt_id: receiptId });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
