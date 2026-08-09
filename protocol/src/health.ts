import { canonicalJson, canonicalJsonDigest } from "./canonical-json.js";
import type { JsonValue } from "./canonical-json.js";
import type { NonterminalCommandPhase } from "./commands.js";
import { protocolError } from "./errors.js";
import { parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";
import { compareProtocolVersions, parseProtocolVersion } from "./versions.js";
import type { ProtocolVersion } from "./versions.js";

export const HEALTH_ENVELOPE_VERSION = "1.0.0" as const;
export const SUBSTRATE_STATES = Object.freeze([
  "healthy",
  "degraded",
  "corrupt",
  "migrating",
  "unreachable",
] as const);
export type SubstrateState = (typeof SUBSTRATE_STATES)[number];

export type HealthSourceStatus = "available" | "corrupt" | "migrating" | "unreachable";
export type GoverningRecordId =
  | CanonicalId<"claim">
  | CanonicalId<"receipt">
  | CanonicalId<"event">;

export interface HealthPolicyRef {
  policy_id: string;
  policy_version: ProtocolVersion;
  required_projection_version: ProtocolVersion;
  required_source_ids: readonly string[];
}

export interface HealthSource {
  source_id: string;
  kind: string;
  status: HealthSourceStatus;
  high_watermark: string | null;
  content_digest: string | null;
  observed_at: string;
  fresh_until?: string;
  governing_record_id: GoverningRecordId | null;
  message?: string;
}

export interface QuarantineRecord {
  source_id: string;
  kind: string;
  referent: string;
  code: string;
  severity: "warning" | "error";
  repair?: string;
}

export interface StaleProjection {
  projection: string;
  source_id: string;
  projection_watermark: string | null;
  source_high_watermark: string;
  observed_at: string;
  reason: string;
}

export interface PendingCommandHealth {
  command_id: CanonicalId<"command">;
  phase: NonterminalCommandPhase;
  recoverable: boolean;
  observed_at: string;
  recovery_owner?: CanonicalId<"principal">;
}

export interface HealthBudget {
  requested_bytes: number;
  actual_bytes: number;
  complete: boolean;
  candidate_count: number;
  indexed_count: number;
  scanned_count: number;
  omitted_categories: readonly string[];
}

export interface DisagreementClaim {
  source_id: string;
  value: JsonValue;
  observed_at: string;
  source_high_watermark: string;
  source_content_digest: string;
  governing_record_id: GoverningRecordId;
}

export interface GoverningPolicyTrace {
  status: "governed" | "unresolved";
  policy_id: string;
  policy_version: ProtocolVersion;
  rule_id: string;
  selected_claim_index: number | null;
  decision_record_id: GoverningRecordId | null;
  explanation: string;
}

export interface HealthDisagreement {
  field: string;
  claims: readonly DisagreementClaim[];
  resolution: GoverningPolicyTrace;
}

export type HealthReasonCode =
  | "required_source_missing"
  | "required_source_corrupt"
  | "required_source_migrating"
  | "required_source_unreachable"
  | "optional_source_unavailable"
  | "source_stale"
  | "quarantine_present"
  | "projection_stale"
  | "projection_version_incompatible"
  | "pending_command"
  | "pending_command_unrecoverable"
  | "budget_incomplete"
  | "budget_overflow"
  | "disagreement_unresolved"
  | "disagreement_governed";

export interface HealthReason {
  code: HealthReasonCode;
  severity: "info" | "warning" | "error";
  summary: string;
  source_id?: string;
  referent?: string;
}

export interface HealthEnvelope {
  health_version: typeof HEALTH_ENVELOPE_VERSION;
  generated_at: string;
  substrate: SubstrateState;
  projection_version: ProtocolVersion;
  policy: HealthPolicyRef;
  sources: readonly HealthSource[];
  quarantined: readonly QuarantineRecord[];
  stale_projections: readonly StaleProjection[];
  pending_commands: readonly PendingCommandHealth[];
  budget: HealthBudget;
  disagreements: readonly HealthDisagreement[];
  reasons: readonly HealthReason[];
}

export interface BuildHealthEnvelopeInput {
  generated_at: string;
  projection_version: ProtocolVersion;
  policy: HealthPolicyRef;
  sources: readonly HealthSource[];
  quarantined?: readonly QuarantineRecord[];
  stale_projections?: readonly StaleProjection[];
  pending_commands?: readonly PendingCommandHealth[];
  budget: HealthBudget;
  disagreements?: readonly HealthDisagreement[];
}

interface HealthDerivation {
  substrate: SubstrateState;
  reasons: HealthReason[];
}

export function buildHealthEnvelope(input: BuildHealthEnvelopeInput): HealthEnvelope {
  assertExactKeys(input, [
    "generated_at", "projection_version", "policy", "sources", "quarantined",
    "stale_projections", "pending_commands", "budget", "disagreements",
  ], "health_input");
  assertArray(input.sources, "sources");
  for (const [field, value] of [
    ["quarantined", input.quarantined],
    ["stale_projections", input.stale_projections],
    ["pending_commands", input.pending_commands],
    ["disagreements", input.disagreements],
  ] as const) {
    if (value !== undefined) assertArray(value, field);
  }
  assertIsoTimestamp(input.generated_at, "generated_at");
  const projectionVersion = parseProtocolVersion(input.projection_version, "projection");
  const policy = normalizePolicy(input.policy);
  const sources = [...input.sources].map(normalizeSource).sort(by("source_id"));
  assertUnique(sources.map((source) => source.source_id), "source_id");
  const sourceIds = new Set(sources.map((source) => source.source_id));
  const sourceMap = new Map(sources.map((source) => [source.source_id, source]));
  const quarantined = [...(input.quarantined ?? [])].map((record) => normalizeQuarantine(record, sourceIds))
    .sort(compareQuarantine);
  const staleProjections = [...(input.stale_projections ?? [])].map((record) => normalizeStale(record, sourceMap))
    .sort(compareStale);
  const pendingCommands = [...(input.pending_commands ?? [])].map(normalizePending).sort(by("command_id"));
  assertUnique(pendingCommands.map((command) => command.command_id), "command_id");
  const budget = normalizeBudget(input.budget);
  const disagreements = [...(input.disagreements ?? [])].map((record) => normalizeDisagreement(record, sourceMap))
    .sort(by("field"));
  assertUnique(disagreements.map((record) => record.field), "disagreement.field");
  for (const source of sources) assertNotFuture(source.observed_at, input.generated_at, "source.observed_at");
  for (const record of staleProjections) assertNotFuture(record.observed_at, input.generated_at, "stale.observed_at");
  for (const command of pendingCommands) assertNotFuture(command.observed_at, input.generated_at, "pending.observed_at");
  for (const record of disagreements) {
    for (const claim of record.claims) assertNotFuture(claim.observed_at, input.generated_at, "disagreement.observed_at");
  }

  const derivation = deriveHealth({
    generatedAt: input.generated_at,
    projectionVersion,
    policy,
    sources,
    quarantined,
    staleProjections,
    pendingCommands,
    budget,
    disagreements,
  });
  return deepFreeze({
    health_version: HEALTH_ENVELOPE_VERSION,
    generated_at: input.generated_at,
    substrate: derivation.substrate,
    projection_version: projectionVersion,
    policy,
    sources,
    quarantined,
    stale_projections: staleProjections,
    pending_commands: pendingCommands,
    budget,
    disagreements,
    reasons: derivation.reasons,
  });
}

export function assertHealthEnvelope(envelope: HealthEnvelope): void {
  if (envelope.health_version !== HEALTH_ENVELOPE_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "health_envelope",
      found: envelope.health_version,
    });
  }
  const rebuilt = buildHealthEnvelope({
    generated_at: envelope.generated_at,
    projection_version: envelope.projection_version,
    policy: envelope.policy,
    sources: envelope.sources,
    quarantined: envelope.quarantined,
    stale_projections: envelope.stale_projections,
    pending_commands: envelope.pending_commands,
    budget: envelope.budget,
    disagreements: envelope.disagreements,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(envelope)) {
    throw protocolError("seedrop.protocol.health_inconsistent", {
      expected_digest: canonicalJsonDigest(rebuilt),
      received_digest: canonicalJsonDigest(envelope),
    });
  }
}

function deriveHealth(input: {
  generatedAt: string;
  projectionVersion: ProtocolVersion;
  policy: HealthPolicyRef;
  sources: HealthSource[];
  quarantined: QuarantineRecord[];
  staleProjections: StaleProjection[];
  pendingCommands: PendingCommandHealth[];
  budget: HealthBudget;
  disagreements: HealthDisagreement[];
}): HealthDerivation {
  const reasons: HealthReason[] = [];
  const candidates: SubstrateState[] = [];
  const required = new Set(input.policy.required_source_ids);
  const bySource = new Map(input.sources.map((source) => [source.source_id, source]));

  for (const sourceId of input.policy.required_source_ids) {
    const source = bySource.get(sourceId);
    if (!source) {
      candidates.push("unreachable");
      reasons.push(reason("required_source_missing", "error", `Required source ${sourceId} is absent.`, sourceId));
      continue;
    }
    if (source.status === "corrupt") {
      candidates.push("corrupt");
      reasons.push(reason("required_source_corrupt", "error", `Required source ${sourceId} is corrupt.`, sourceId));
    } else if (source.status === "migrating") {
      candidates.push("migrating");
      reasons.push(reason("required_source_migrating", "warning", `Required source ${sourceId} is migrating.`, sourceId));
    } else if (source.status === "unreachable") {
      candidates.push("unreachable");
      reasons.push(reason("required_source_unreachable", "error", `Required source ${sourceId} is unreachable.`, sourceId));
    }
  }

  for (const source of input.sources) {
    if (!required.has(source.source_id) && source.status !== "available") {
      candidates.push("degraded");
      reasons.push(reason("optional_source_unavailable", "warning", `Optional source ${source.source_id} is ${source.status}.`, source.source_id));
    }
    if (source.fresh_until && Date.parse(input.generatedAt) > Date.parse(source.fresh_until)) {
      candidates.push("degraded");
      reasons.push(reason("source_stale", "warning", `Source ${source.source_id} is past its freshness boundary.`, source.source_id));
    }
  }

  for (const record of input.quarantined) {
    candidates.push(record.severity === "error" ? "corrupt" : "degraded");
    reasons.push({
      code: "quarantine_present",
      severity: record.severity,
      summary: `Quarantine ${record.code} retains ${record.referent}.`,
      source_id: record.source_id,
      referent: record.referent,
    });
  }
  for (const record of input.staleProjections) {
    candidates.push("degraded");
    reasons.push({
      code: "projection_stale",
      severity: "warning",
      summary: `Projection ${record.projection} lags source ${record.source_id}.`,
      source_id: record.source_id,
      referent: record.projection,
    });
  }
  if (compareProtocolVersions(input.projectionVersion, input.policy.required_projection_version) !== 0) {
    candidates.push("degraded");
    reasons.push({
      code: "projection_version_incompatible",
      severity: "error",
      summary: `Projection ${input.projectionVersion} does not match required ${input.policy.required_projection_version}.`,
      referent: input.policy.policy_id,
    });
  }
  for (const command of input.pendingCommands) {
    candidates.push(command.recoverable ? "degraded" : "corrupt");
    reasons.push({
      code: command.recoverable ? "pending_command" : "pending_command_unrecoverable",
      severity: command.recoverable ? "warning" : "error",
      summary: `Command ${command.command_id} is pending in phase ${command.phase}.`,
      referent: command.command_id,
    });
  }
  if (!input.budget.complete) {
    candidates.push("degraded");
    reasons.push(reason("budget_incomplete", "warning", "The requested envelope is incomplete under its byte budget."));
  }
  if (input.budget.actual_bytes > input.budget.requested_bytes) {
    candidates.push("degraded");
    reasons.push(reason("budget_overflow", "error", "Actual output bytes exceed the requested byte budget."));
  }
  for (const disagreement of input.disagreements) {
    if (disagreement.resolution.status === "unresolved") {
      candidates.push("degraded");
      reasons.push({
        code: "disagreement_unresolved",
        severity: "error",
        summary: `Sources disagree on ${disagreement.field} without a governing decision.`,
        referent: disagreement.field,
      });
    } else {
      reasons.push({
        code: "disagreement_governed",
        severity: "info",
        summary: `Sources disagree on ${disagreement.field}; policy ${disagreement.resolution.policy_id}/${disagreement.resolution.rule_id} governs.`,
        referent: disagreement.field,
      });
    }
  }

  reasons.sort(compareReasons);
  return { substrate: highestState(candidates), reasons };
}

function normalizePolicy(policy: HealthPolicyRef): HealthPolicyRef {
  assertExactKeys(policy, ["policy_id", "policy_version", "required_projection_version", "required_source_ids"], "policy");
  assertNonEmpty(policy.policy_id, "policy_id");
  assertArray(policy.required_source_ids, "required_source_ids");
  const required = [...policy.required_source_ids].map((value) => nonEmpty(value, "required_source_id")).sort();
  assertUnique(required, "required_source_id");
  if (required.length === 0) throw protocolError("seedrop.protocol.health_invalid", { field: "required_source_id", reason: "minimum" });
  return Object.freeze({
    policy_id: policy.policy_id,
    policy_version: parseProtocolVersion(policy.policy_version),
    required_projection_version: parseProtocolVersion(policy.required_projection_version, "projection"),
    required_source_ids: Object.freeze(required),
  });
}

function normalizeSource(source: HealthSource): HealthSource {
  assertExactKeys(source, [
    "source_id", "kind", "status", "high_watermark", "content_digest", "observed_at",
    "fresh_until", "governing_record_id", "message",
  ], "source");
  assertNonEmpty(source.source_id, "source_id");
  assertNonEmpty(source.kind, "source.kind");
  if (!(source.status === "available" || source.status === "corrupt" || source.status === "migrating" || source.status === "unreachable")) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "source.status" });
  }
  assertIsoTimestamp(source.observed_at, "source.observed_at");
  if (source.fresh_until !== undefined) {
    assertIsoTimestamp(source.fresh_until, "source.fresh_until");
    if (Date.parse(source.fresh_until) < Date.parse(source.observed_at)) {
      throw protocolError("seedrop.protocol.health_invalid", { field: "source.fresh_until", reason: "before_observation" });
    }
  }
  if (source.high_watermark !== null) assertNonEmpty(source.high_watermark, "source.high_watermark");
  if (source.content_digest !== null) assertSha256(source.content_digest, "source.content_digest");
  if (source.governing_record_id !== null) assertGoverningId(source.governing_record_id);
  if (source.status === "available" && (!source.high_watermark || !source.content_digest || !source.governing_record_id)) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "source.available_evidence", source_id: source.source_id });
  }
  if (source.message !== undefined) assertNonEmpty(source.message, "source.message");
  return Object.freeze({
    source_id: source.source_id,
    kind: source.kind,
    status: source.status,
    high_watermark: source.high_watermark,
    content_digest: source.content_digest,
    observed_at: source.observed_at,
    ...(source.fresh_until === undefined ? {} : { fresh_until: source.fresh_until }),
    governing_record_id: source.governing_record_id,
    ...(source.message === undefined ? {} : { message: source.message }),
  });
}

function normalizeQuarantine(record: QuarantineRecord, sourceIds: Set<string>): QuarantineRecord {
  assertExactKeys(record, ["source_id", "kind", "referent", "code", "severity", "repair"], "quarantine");
  assertSourceRef(record.source_id, sourceIds, "quarantine.source_id");
  assertNonEmpty(record.kind, "quarantine.kind");
  assertNonEmpty(record.referent, "quarantine.referent");
  assertNonEmpty(record.code, "quarantine.code");
  if (!(record.severity === "warning" || record.severity === "error")) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "quarantine.severity" });
  }
  if (record.repair !== undefined) assertNonEmpty(record.repair, "quarantine.repair");
  return Object.freeze({
    source_id: record.source_id,
    kind: record.kind,
    referent: record.referent,
    code: record.code,
    severity: record.severity,
    ...(record.repair === undefined ? {} : { repair: record.repair }),
  });
}

function normalizeStale(record: StaleProjection, sources: Map<string, HealthSource>): StaleProjection {
  assertExactKeys(record, [
    "projection", "source_id", "projection_watermark", "source_high_watermark", "observed_at", "reason",
  ], "stale");
  assertNonEmpty(record.projection, "stale.projection");
  const source = sources.get(record.source_id);
  if (!source) throw protocolError("seedrop.protocol.health_invalid", { field: "stale.source_id", source_id: record.source_id });
  if (record.projection_watermark !== null) assertNonEmpty(record.projection_watermark, "stale.projection_watermark");
  assertNonEmpty(record.source_high_watermark, "stale.source_high_watermark");
  if (source.high_watermark !== record.source_high_watermark) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "stale.source_high_watermark", source_id: record.source_id });
  }
  assertIsoTimestamp(record.observed_at, "stale.observed_at");
  assertNonEmpty(record.reason, "stale.reason");
  return Object.freeze({
    projection: record.projection,
    source_id: record.source_id,
    projection_watermark: record.projection_watermark,
    source_high_watermark: record.source_high_watermark,
    observed_at: record.observed_at,
    reason: record.reason,
  });
}

function normalizePending(command: PendingCommandHealth): PendingCommandHealth {
  assertExactKeys(command, ["command_id", "phase", "recoverable", "observed_at", "recovery_owner"], "pending");
  parseCanonicalId(command.command_id, "command");
  if (!(command.phase === "accepted" || command.phase === "executing" || command.phase === "effects_pending"
    || command.phase === "recovery_pending")) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "pending.phase" });
  }
  assertBoolean(command.recoverable, "pending.recoverable");
  assertIsoTimestamp(command.observed_at, "pending.observed_at");
  if (command.recovery_owner !== undefined) parseCanonicalId(command.recovery_owner, "principal");
  if (command.recoverable !== (command.recovery_owner !== undefined)) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "pending.recovery_owner", reason: "recoverability_mismatch" });
  }
  return Object.freeze({
    command_id: command.command_id,
    phase: command.phase,
    recoverable: command.recoverable,
    observed_at: command.observed_at,
    ...(command.recovery_owner === undefined ? {} : { recovery_owner: command.recovery_owner }),
  });
}

function normalizeBudget(budget: HealthBudget): HealthBudget {
  assertExactKeys(budget, [
    "requested_bytes", "actual_bytes", "complete", "candidate_count", "indexed_count",
    "scanned_count", "omitted_categories",
  ], "budget");
  assertBoolean(budget.complete, "budget.complete");
  assertArray(budget.omitted_categories, "budget.omitted_categories");
  for (const [field, value] of Object.entries({
    requested_bytes: budget.requested_bytes,
    actual_bytes: budget.actual_bytes,
    candidate_count: budget.candidate_count,
    indexed_count: budget.indexed_count,
    scanned_count: budget.scanned_count,
  })) assertNonNegativeInteger(value, `budget.${field}`);
  const omitted = [...budget.omitted_categories].map((value) => nonEmpty(value, "budget.omitted_category")).sort();
  assertUnique(omitted, "budget.omitted_category");
  if (budget.complete && omitted.length > 0) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "budget.complete", reason: "omitted_categories_present" });
  }
  if (budget.indexed_count + budget.scanned_count !== budget.candidate_count) {
    throw protocolError("seedrop.protocol.health_invalid", { field: "budget.candidate_count", reason: "accounting_mismatch" });
  }
  return Object.freeze({ ...budget, omitted_categories: Object.freeze(omitted) });
}

function normalizeDisagreement(record: HealthDisagreement, sources: Map<string, HealthSource>): HealthDisagreement {
  assertExactKeys(record, ["field", "claims", "resolution"], "disagreement");
  assertNonEmpty(record.field, "disagreement.field");
  assertArray(record.claims, "disagreement.claims");
  if (record.claims.length < 2) throw protocolError("seedrop.protocol.health_disagreement_invalid", { field: record.field, reason: "claims_minimum" });
  const claims = record.claims.map((claim) => {
    assertExactKeys(claim, [
      "source_id", "value", "observed_at", "source_high_watermark", "source_content_digest", "governing_record_id",
    ], "disagreement.claim");
    const source = sources.get(claim.source_id);
    if (!source) {
      throw protocolError("seedrop.protocol.health_invalid", { field: "disagreement.source_id", source_id: claim.source_id });
    }
    assertIsoTimestamp(claim.observed_at, "disagreement.observed_at");
    assertNonEmpty(claim.source_high_watermark, "disagreement.source_high_watermark");
    assertSha256(claim.source_content_digest, "disagreement.source_content_digest");
    assertGoverningId(claim.governing_record_id);
    if (claim.source_high_watermark !== source.high_watermark || claim.source_content_digest !== source.content_digest) {
      throw protocolError("seedrop.protocol.health_disagreement_invalid", {
        field: record.field,
        reason: "source_evidence_mismatch",
        source_id: claim.source_id,
      });
    }
    canonicalJson(claim.value);
    return Object.freeze({ ...claim, value: structuredClone(claim.value) });
  });
  assertUnique(claims.map((claim) => claim.source_id), "disagreement.source_id");
  if (new Set(claims.map((claim) => canonicalJsonDigest(claim.value))).size < 2) {
    throw protocolError("seedrop.protocol.health_disagreement_invalid", { field: record.field, reason: "claims_equal" });
  }
  const resolution = normalizeResolution(record.field, record.resolution, claims.length);
  return Object.freeze({ field: record.field, claims: Object.freeze(claims), resolution });
}

function normalizeResolution(field: string, trace: GoverningPolicyTrace, claimCount: number): GoverningPolicyTrace {
  assertExactKeys(trace, [
    "status", "policy_id", "policy_version", "rule_id", "selected_claim_index",
    "decision_record_id", "explanation",
  ], "disagreement.resolution");
  assertNonEmpty(trace.policy_id, "resolution.policy_id");
  parseProtocolVersion(trace.policy_version);
  assertNonEmpty(trace.rule_id, "resolution.rule_id");
  assertNonEmpty(trace.explanation, "resolution.explanation");
  if (trace.status === "governed") {
    if (!Number.isSafeInteger(trace.selected_claim_index) || trace.selected_claim_index === null || trace.selected_claim_index < 0 || trace.selected_claim_index >= claimCount) {
      throw protocolError("seedrop.protocol.health_disagreement_invalid", { field, reason: "selected_claim_index" });
    }
    if (!trace.decision_record_id) throw protocolError("seedrop.protocol.health_disagreement_invalid", { field, reason: "decision_record_required" });
    assertGoverningId(trace.decision_record_id);
  } else if (trace.status === "unresolved") {
    if (trace.selected_claim_index !== null || trace.decision_record_id !== null) {
      throw protocolError("seedrop.protocol.health_disagreement_invalid", { field, reason: "unresolved_must_not_select" });
    }
  } else {
    throw protocolError("seedrop.protocol.health_disagreement_invalid", { field, reason: "resolution_status" });
  }
  return Object.freeze({ ...trace, policy_version: parseProtocolVersion(trace.policy_version) });
}

function assertGoverningId(value: GoverningRecordId): void {
  for (const kind of ["claim", "receipt", "event"] as const) {
    try {
      parseCanonicalId(value, kind);
      return;
    } catch {
      // Try the next permitted governing record kind.
    }
  }
  throw protocolError("seedrop.protocol.health_invalid", { field: "governing_record_id" });
}

function highestState(states: readonly SubstrateState[]): SubstrateState {
  const precedence: readonly SubstrateState[] = ["corrupt", "migrating", "unreachable", "degraded", "healthy"];
  return precedence.find((state) => states.includes(state)) ?? "healthy";
}

function reason(code: HealthReasonCode, severity: HealthReason["severity"], summary: string, sourceId?: string): HealthReason {
  return sourceId === undefined ? { code, severity, summary } : { code, severity, summary, source_id: sourceId };
}

function assertSourceRef(sourceId: string, sourceIds: Set<string>, field: string): void {
  if (!sourceIds.has(sourceId)) throw protocolError("seedrop.protocol.health_invalid", { field, source_id: sourceId });
}

function assertSha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw protocolError("seedrop.protocol.health_invalid", { field });
}

function assertIsoTimestamp(value: string, field: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw protocolError("seedrop.protocol.health_invalid", { field });
  }
}

function assertNotFuture(observedAt: string, generatedAt: string, field: string): void {
  if (Date.parse(observedAt) > Date.parse(generatedAt)) {
    throw protocolError("seedrop.protocol.health_invalid", { field, reason: "after_generated_at" });
  }
}

function assertExactKeys(value: unknown, allowed: readonly string[], field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("seedrop.protocol.health_invalid", { field, reason: "object_required" });
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw protocolError("seedrop.protocol.health_invalid", { field, reason: "unknown_fields", unknown_fields: extras.sort().join(",") });
  }
}

function assertArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError("seedrop.protocol.health_invalid", { field, reason: "array_required" });
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw protocolError("seedrop.protocol.health_invalid", { field, reason: "boolean_required" });
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw protocolError("seedrop.protocol.health_invalid", { field });
}

function nonEmpty(value: string, field: string): string {
  assertNonEmpty(value, field);
  return value;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw protocolError("seedrop.protocol.health_invalid", { field });
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw protocolError("seedrop.protocol.health_invalid", { field, reason: "duplicate" });
}

function by<K extends string>(key: K): (left: Record<K, string>, right: Record<K, string>) => number {
  return (left, right) => left[key].localeCompare(right[key]);
}

function compareQuarantine(left: QuarantineRecord, right: QuarantineRecord): number {
  return `${left.source_id}\u0000${left.referent}\u0000${left.code}`.localeCompare(`${right.source_id}\u0000${right.referent}\u0000${right.code}`);
}

function compareStale(left: StaleProjection, right: StaleProjection): number {
  return `${left.projection}\u0000${left.source_id}`.localeCompare(`${right.projection}\u0000${right.source_id}`);
}

function compareReasons(left: HealthReason, right: HealthReason): number {
  return `${left.code}\u0000${left.source_id ?? ""}\u0000${left.referent ?? ""}`
    .localeCompare(`${right.code}\u0000${right.source_id ?? ""}\u0000${right.referent ?? ""}`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
