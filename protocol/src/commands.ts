import { canonicalJson, canonicalJsonDigest } from "./canonical-json.js";
import { protocolError } from "./errors.js";
import { parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";
import { assertSupportedVersion, parseProtocolVersion } from "./versions.js";
import type { ProtocolVersion } from "./versions.js";

export const COMMAND_AUDIT_VERSION = "1.0.0" as const;
export const SWEEP_CANDIDATE_VERSION = "1.0.0" as const;

export const COMMAND_PHASES = Object.freeze([
  "accepted",
  "executing",
  "effects_pending",
  "recovery_pending",
  "completed",
  "rejected",
  "failed",
  "compensated",
] as const);
export type CommandPhase = (typeof COMMAND_PHASES)[number];

export const TERMINAL_COMMAND_PHASES = Object.freeze([
  "completed",
  "rejected",
  "failed",
  "compensated",
] as const satisfies readonly CommandPhase[]);
export type TerminalCommandPhase = (typeof TERMINAL_COMMAND_PHASES)[number];
export type NonterminalCommandPhase = Exclude<CommandPhase, TerminalCommandPhase>;

export interface CommandRecoveryPlan {
  owner_principal_id: CanonicalId<"principal">;
  action: string;
  recover_by: string;
  attempt_limit: number;
}

export interface CommandAuditError {
  code: string;
  message: string;
  retryable: boolean;
  evidence_digest: string | null;
}

export interface CommandAuditEntry {
  event_id: CanonicalId<"event">;
  phase: CommandPhase;
  recorded_at: string;
  expected_state_version: string;
  result_state_version: string | null;
  result_digest: string | null;
  attempt: number;
  error: CommandAuditError | null;
  recovery: CommandRecoveryPlan | null;
}

export interface CommandAuditTrail {
  audit_version: typeof COMMAND_AUDIT_VERSION;
  command_id: CanonicalId<"command">;
  command_version: ProtocolVersion;
  command_name: string;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  idempotency_key: string;
  input_digest: string;
  accepted_at: string;
  entries: readonly CommandAuditEntry[];
}

export interface BuildCommandAuditTrailInput {
  command_id: CanonicalId<"command">;
  command_version: ProtocolVersion;
  command_name: string;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  idempotency_key: string;
  input_digest: string;
  accepted_at: string;
  entries: readonly CommandAuditEntry[];
}

export interface CommandSweepPolicy {
  policy_id: string;
  policy_version: ProtocolVersion;
  maximum_command_age_ms: number;
  phase_maximum_idle_ms: Readonly<Record<NonterminalCommandPhase, number>>;
}

export type CommandInvariantCode =
  | "command_age_exceeded"
  | "phase_idle_exceeded"
  | "recovery_deadline_exceeded";

export interface CommandInvariantViolation {
  code: CommandInvariantCode;
  observed_ms: number;
  allowed_ms: number;
}

export interface CommandInvariantReport {
  command_id: CanonicalId<"command">;
  phase: CommandPhase;
  terminal: boolean;
  recoverable: boolean;
  age_ms: number;
  idle_ms: number;
  recovery_owner_principal_id: CanonicalId<"principal"> | null;
  violations: readonly CommandInvariantViolation[];
}

export interface SweepCandidateEvent {
  sweep_candidate_version: typeof SWEEP_CANDIDATE_VERSION;
  command_id: CanonicalId<"command">;
  project_id: CanonicalId<"project">;
  observed_phase: NonterminalCommandPhase;
  observed_at: string;
  age_ms: number;
  idle_ms: number;
  recovery_owner_principal_id: CanonicalId<"principal">;
  reason_codes: readonly CommandInvariantCode[];
  policy_id: string;
  policy_version: ProtocolVersion;
  proposed_event: {
    event_type: "command.sweep_candidate";
    subject_command_id: CanonicalId<"command">;
    confidence: "inferred";
    cause: string;
  };
}

const TRANSITIONS = Object.freeze({
  accepted: ["executing", "effects_pending", "completed", "rejected", "failed"],
  executing: ["effects_pending", "recovery_pending", "completed", "failed"],
  effects_pending: ["executing", "recovery_pending", "completed", "failed"],
  recovery_pending: ["executing", "effects_pending", "completed", "failed", "compensated"],
  completed: [],
  rejected: [],
  failed: [],
  compensated: [],
} as const satisfies Readonly<Record<CommandPhase, readonly CommandPhase[]>>);

const ERROR_REQUIRED = new Set<CommandPhase>(["recovery_pending", "rejected", "failed"]);
const RESULT_REQUIRED = new Set<CommandPhase>(["completed", "compensated"]);

export function buildCommandAuditTrail(input: BuildCommandAuditTrailInput): CommandAuditTrail {
  canonicalJson(input);
  assertExactKeys(input, [
    "command_id", "command_version", "command_name", "principal_id", "project_id",
    "idempotency_key", "input_digest", "accepted_at", "entries",
  ], "command_audit");
  parseCanonicalId(input.command_id, "command");
  parseCanonicalId(input.principal_id, "principal");
  parseCanonicalId(input.project_id, "project");
  const commandVersion = assertSupportedVersion("command", input.command_version);
  assertNonEmpty(input.command_name, "command_name");
  assertNonEmpty(input.idempotency_key, "idempotency_key");
  assertSha256(input.input_digest, "input_digest");
  assertTimestamp(input.accepted_at, "accepted_at");
  assertArray(input.entries, "entries");
  if (input.entries.length === 0) invalid("entries", "minimum");

  const entries = input.entries.map(normalizeEntry);
  assertUnique(entries.map((entry) => entry.event_id), "entry.event_id");
  if (entries[0]?.phase !== "accepted") invalid("entries[0].phase", "must_be_accepted");
  if (entries[0]?.recorded_at !== input.accepted_at) invalid("accepted_at", "first_entry_mismatch");
  if (entries[0]?.attempt !== 0) invalid("entries[0].attempt", "accepted_attempt_zero");

  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if (Date.parse(current.recorded_at) <= Date.parse(previous.recorded_at)) {
      invalid(`entries[${index}].recorded_at`, "not_strictly_increasing");
    }
    const allowedTransitions: readonly CommandPhase[] = TRANSITIONS[previous.phase];
    if (!allowedTransitions.includes(current.phase)) {
      throw protocolError("seedrop.protocol.command_transition_invalid", {
        command_id: input.command_id,
        from: previous.phase,
        to: current.phase,
      });
    }
    const expected = previous.result_state_version ?? previous.expected_state_version;
    if (current.expected_state_version !== expected) {
      invalid(`entries[${index}].expected_state_version`, "version_chain_gap");
    }
    if (current.attempt < previous.attempt) invalid(`entries[${index}].attempt`, "attempt_regressed");
  }

  return deepFreeze({
    audit_version: COMMAND_AUDIT_VERSION,
    command_id: input.command_id,
    command_version: commandVersion,
    command_name: input.command_name,
    principal_id: input.principal_id,
    project_id: input.project_id,
    idempotency_key: input.idempotency_key,
    input_digest: input.input_digest,
    accepted_at: input.accepted_at,
    entries,
  });
}

export function assertCommandAuditTrail(trail: CommandAuditTrail): void {
  canonicalJson(trail);
  if (trail.audit_version !== COMMAND_AUDIT_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "command_audit",
      found: trail.audit_version,
    });
  }
  const rebuilt = buildCommandAuditTrail({
    command_id: trail.command_id,
    command_version: trail.command_version,
    command_name: trail.command_name,
    principal_id: trail.principal_id,
    project_id: trail.project_id,
    idempotency_key: trail.idempotency_key,
    input_digest: trail.input_digest,
    accepted_at: trail.accepted_at,
    entries: trail.entries,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(trail)) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", {
      expected_digest: canonicalJsonDigest(rebuilt),
      received_digest: canonicalJsonDigest(trail),
    });
  }
}

export function evaluateCommandInvariants(
  trails: readonly CommandAuditTrail[],
  policyInput: CommandSweepPolicy,
  observedAt: string,
): readonly CommandInvariantReport[] {
  canonicalJson(policyInput);
  assertArray(trails, "trails");
  assertTimestamp(observedAt, "observed_at");
  const policy = normalizeSweepPolicy(policyInput);
  const normalized = trails.map((trail) => {
    assertCommandAuditTrail(trail);
    return trail;
  }).sort(byCommandId);
  assertUnique(normalized.map((trail) => trail.command_id), "command_id");
  assertUnique(normalized.map((trail) => [
    trail.project_id, trail.principal_id, trail.command_name, trail.idempotency_key,
  ].join("\u0000")), "idempotency_scope");

  const observedMs = Date.parse(observedAt);
  return deepFreeze(normalized.map((trail): CommandInvariantReport => {
    const latest = trail.entries.at(-1)!;
    if (Date.parse(latest.recorded_at) > observedMs) invalid("observed_at", "before_latest_entry");
    const terminal = isTerminalCommandPhase(latest.phase);
    const ageMs = observedMs - Date.parse(trail.accepted_at);
    const idleMs = observedMs - Date.parse(latest.recorded_at);
    const violations: CommandInvariantViolation[] = [];
    if (!isTerminalCommandPhase(latest.phase)) {
      const maximumIdle = policy.phase_maximum_idle_ms[latest.phase];
      if (idleMs > maximumIdle) violations.push({
        code: "phase_idle_exceeded", observed_ms: idleMs, allowed_ms: maximumIdle,
      });
      if (ageMs > policy.maximum_command_age_ms) violations.push({
        code: "command_age_exceeded", observed_ms: ageMs, allowed_ms: policy.maximum_command_age_ms,
      });
      const deadlineMs = Date.parse(latest.recovery!.recover_by);
      if (observedMs > deadlineMs) violations.push({
        code: "recovery_deadline_exceeded",
        observed_ms: observedMs - Date.parse(latest.recorded_at),
        allowed_ms: deadlineMs - Date.parse(latest.recorded_at),
      });
    }
    violations.sort((left, right) => left.code.localeCompare(right.code));
    return {
      command_id: trail.command_id,
      phase: latest.phase,
      terminal,
      recoverable: !terminal,
      age_ms: ageMs,
      idle_ms: idleMs,
      recovery_owner_principal_id: latest.recovery?.owner_principal_id ?? null,
      violations,
    };
  }));
}

export function findCommandSweepCandidates(
  trails: readonly CommandAuditTrail[],
  policyInput: CommandSweepPolicy,
  observedAt: string,
): readonly SweepCandidateEvent[] {
  const policy = normalizeSweepPolicy(policyInput);
  const reports = evaluateCommandInvariants(trails, policy, observedAt);
  const byId = new Map(trails.map((trail) => [trail.command_id, trail]));
  return deepFreeze(reports.flatMap((report): SweepCandidateEvent[] => {
    if (report.terminal || report.violations.length === 0) return [];
    const trail = byId.get(report.command_id)!;
    const phase = report.phase as NonterminalCommandPhase;
    const codes = report.violations.map((violation) => violation.code).sort();
    return [{
      sweep_candidate_version: SWEEP_CANDIDATE_VERSION,
      command_id: report.command_id,
      project_id: trail.project_id,
      observed_phase: phase,
      observed_at: observedAt,
      age_ms: report.age_ms,
      idle_ms: report.idle_ms,
      recovery_owner_principal_id: report.recovery_owner_principal_id!,
      reason_codes: codes,
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      proposed_event: {
        event_type: "command.sweep_candidate",
        subject_command_id: report.command_id,
        confidence: "inferred",
        cause: `Command ${report.command_id} in ${phase} violates ${codes.join(", ")}.`,
      },
    }];
  }));
}

export function isTerminalCommandPhase(phase: CommandPhase): phase is TerminalCommandPhase {
  return (TERMINAL_COMMAND_PHASES as readonly CommandPhase[]).includes(phase);
}

function normalizeEntry(entry: CommandAuditEntry, index: number): CommandAuditEntry {
  assertExactKeys(entry, [
    "event_id", "phase", "recorded_at", "expected_state_version", "result_state_version",
    "result_digest", "attempt", "error", "recovery",
  ], `entries[${index}]`);
  parseCanonicalId(entry.event_id, "event");
  if (!(COMMAND_PHASES as readonly unknown[]).includes(entry.phase)) invalid(`entries[${index}].phase`, "unknown");
  assertTimestamp(entry.recorded_at, `entries[${index}].recorded_at`);
  assertNonEmpty(entry.expected_state_version, `entries[${index}].expected_state_version`);
  if (entry.result_state_version !== null) assertNonEmpty(entry.result_state_version, `entries[${index}].result_state_version`);
  if (entry.result_digest !== null) assertSha256(entry.result_digest, `entries[${index}].result_digest`);
  assertNonNegativeInteger(entry.attempt, `entries[${index}].attempt`);

  const terminal = isTerminalCommandPhase(entry.phase);
  if ((entry.result_state_version === null) !== (entry.result_digest === null)) {
    invalid(`entries[${index}].result`, "version_digest_pair_required");
  }
  if (RESULT_REQUIRED.has(entry.phase) && (!entry.result_state_version || !entry.result_digest)) {
    invalid(`entries[${index}].result`, "required");
  }
  const error = entry.error === null ? null : normalizeAuditError(entry.error, index);
  if (ERROR_REQUIRED.has(entry.phase) !== (error !== null)) {
    invalid(`entries[${index}].error`, ERROR_REQUIRED.has(entry.phase) ? "required" : "not_permitted");
  }
  const recovery = entry.recovery === null ? null : normalizeRecovery(entry.recovery, entry, index);
  if (terminal === (recovery !== null)) {
    throw protocolError("seedrop.protocol.command_unrecoverable", {
      phase: entry.phase,
      reason: terminal ? "terminal_has_recovery" : "nonterminal_missing_recovery",
    });
  }
  return deepFreeze({ ...entry, error, recovery });
}

function normalizeAuditError(error: CommandAuditError, index: number): CommandAuditError {
  assertExactKeys(error, ["code", "message", "retryable", "evidence_digest"], `entries[${index}].error`);
  assertNonEmpty(error.code, `entries[${index}].error.code`);
  assertNonEmpty(error.message, `entries[${index}].error.message`);
  assertBoolean(error.retryable, `entries[${index}].error.retryable`);
  if (error.evidence_digest !== null) assertSha256(error.evidence_digest, `entries[${index}].error.evidence_digest`);
  return Object.freeze({ ...error });
}

function normalizeRecovery(plan: CommandRecoveryPlan, entry: CommandAuditEntry, index: number): CommandRecoveryPlan {
  assertExactKeys(plan, ["owner_principal_id", "action", "recover_by", "attempt_limit"], `entries[${index}].recovery`);
  parseCanonicalId(plan.owner_principal_id, "principal");
  assertNonEmpty(plan.action, `entries[${index}].recovery.action`);
  assertTimestamp(plan.recover_by, `entries[${index}].recovery.recover_by`);
  assertPositiveInteger(plan.attempt_limit, `entries[${index}].recovery.attempt_limit`);
  if (Date.parse(plan.recover_by) < Date.parse(entry.recorded_at)) {
    invalid(`entries[${index}].recovery.recover_by`, "before_entry");
  }
  if (entry.attempt >= plan.attempt_limit) {
    throw protocolError("seedrop.protocol.command_unrecoverable", {
      phase: entry.phase,
      reason: "attempt_budget_exhausted",
    });
  }
  return Object.freeze({ ...plan });
}

function normalizeSweepPolicy(policy: CommandSweepPolicy): CommandSweepPolicy {
  assertExactKeys(policy, ["policy_id", "policy_version", "maximum_command_age_ms", "phase_maximum_idle_ms"], "sweep_policy");
  assertNonEmpty(policy.policy_id, "sweep_policy.policy_id");
  const policyVersion = parseProtocolVersion(policy.policy_version);
  assertPositiveInteger(policy.maximum_command_age_ms, "sweep_policy.maximum_command_age_ms");
  assertExactKeys(policy.phase_maximum_idle_ms, [
    "accepted", "executing", "effects_pending", "recovery_pending",
  ], "sweep_policy.phase_maximum_idle_ms");
  const limits = { ...policy.phase_maximum_idle_ms };
  for (const phase of ["accepted", "executing", "effects_pending", "recovery_pending"] as const) {
    assertPositiveInteger(limits[phase], `sweep_policy.phase_maximum_idle_ms.${phase}`);
  }
  return deepFreeze({
    policy_id: policy.policy_id,
    policy_version: policyVersion,
    maximum_command_age_ms: policy.maximum_command_age_ms,
    phase_maximum_idle_ms: limits,
  });
}

function byCommandId(left: CommandAuditTrail, right: CommandAuditTrail): number {
  return left.command_id.localeCompare(right.command_id);
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

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") invalid(field, "boolean_required");
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field, "nonnegative_integer_required");
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(field, "positive_integer_required");
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(field, "duplicate");
}

function invalid(field: string, reason: string, extra: Record<string, string> = {}): never {
  throw protocolError("seedrop.protocol.command_audit_invalid", { field, reason, ...extra });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
