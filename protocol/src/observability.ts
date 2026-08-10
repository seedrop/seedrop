import {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
} from "./canonical-json.js";
import type { JsonValue } from "./canonical-json.js";
import { protocolError } from "./errors.js";
import { parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";
import { parseProtocolVersion } from "./versions.js";
import type { ProtocolVersion } from "./versions.js";
import type { GoverningRecordId, HealthBudget } from "./health.js";

export const OPERATIONAL_METRICS_VERSION = "1.0.0" as const;
export const EXPLANATION_TRACE_VERSION = "1.0.0" as const;
export const BOUNDED_OUTPUT_VERSION = "1.0.0" as const;
export const TELEMETRY_CONSENT_VERSION = "1.0.0" as const;
export const TELEMETRY_EXPORT_VERSION = "1.0.0" as const;
export const TELEMETRY_DEFAULT_MODE = "local_only" as const;

export const OPERATIONAL_METRIC_KINDS = Object.freeze([
  "duplicate_idempotency",
  "cas_conflict",
  "retry",
  "outbox_lag",
  "outbox_dead_letter",
] as const);
export type OperationalMetricKind = (typeof OPERATIONAL_METRIC_KINDS)[number];

export interface OperationalMetricPolicy {
  policy_id: string;
  policy_version: ProtocolVersion;
  maximum_retries_per_command: number;
  outbox_lag_slo_ms: number;
}

export interface OperationalMetricSpan {
  event_id: CanonicalId<"event">;
  project_id: CanonicalId<"project">;
  command_id: CanonicalId<"command">;
  kind: OperationalMetricKind;
  operation: string;
  observed_at: string;
  duration_ms: number;
  attempt: number;
  outbox_lag_ms: number | null;
  evidence_digest: string;
}

export interface OperationalMetricCounters {
  duplicate_idempotency_count: number;
  cas_conflict_count: number;
  retry_count: number;
  outbox_dead_letter_count: number;
  outbox_lag_sample_count: number;
}

export interface OutboxLagSummary {
  sample_count: number;
  total_ms: number;
  maximum_ms: number;
}

export type OperationalMetricAlertCode =
  | "retry_storm"
  | "outbox_lag_slo_exceeded"
  | "outbox_dead_letter";

export interface OperationalMetricAlert {
  code: OperationalMetricAlertCode;
  severity: "warning" | "error";
  command_id: CanonicalId<"command">;
  observed_value: number;
  allowed_value: number;
}

export interface OperationalMetricsSnapshot {
  metrics_version: typeof OPERATIONAL_METRICS_VERSION;
  generated_at: string;
  policy: OperationalMetricPolicy;
  spans: readonly OperationalMetricSpan[];
  counters: OperationalMetricCounters;
  outbox_lag: OutboxLagSummary;
  alerts: readonly OperationalMetricAlert[];
}

export interface BuildOperationalMetricsInput {
  generated_at: string;
  policy: OperationalMetricPolicy;
  spans: readonly OperationalMetricSpan[];
}

export function buildOperationalMetricsSnapshot(input: BuildOperationalMetricsInput): OperationalMetricsSnapshot {
  canonicalJson(input);
  assertExactKeys(input, ["generated_at", "policy", "spans"], "metrics", "seedrop.protocol.operational_metrics_invalid");
  assertTimestamp(input.generated_at, "generated_at", "seedrop.protocol.operational_metrics_invalid");
  const policy = normalizeMetricPolicy(input.policy);
  assertArray(input.spans, "spans", "seedrop.protocol.operational_metrics_invalid");
  const spans = input.spans.map((span, index) => normalizeMetricSpan(span, index, input.generated_at))
    .sort((left, right) => `${left.observed_at}\u0000${left.event_id}`.localeCompare(`${right.observed_at}\u0000${right.event_id}`));
  assertUnique(spans.map((span) => span.event_id), "spans.event_id", "seedrop.protocol.operational_metrics_invalid");

  const counters: OperationalMetricCounters = {
    duplicate_idempotency_count: count(spans, "duplicate_idempotency"),
    cas_conflict_count: count(spans, "cas_conflict"),
    retry_count: count(spans, "retry"),
    outbox_dead_letter_count: count(spans, "outbox_dead_letter"),
    outbox_lag_sample_count: spans.filter((span) => span.outbox_lag_ms !== null).length,
  };
  const lagValues = spans.flatMap((span) => span.outbox_lag_ms === null ? [] : [span.outbox_lag_ms]);
  const outboxLag: OutboxLagSummary = {
    sample_count: lagValues.length,
    total_ms: lagValues.reduce((total, value) => total + value, 0),
    maximum_ms: lagValues.length === 0 ? 0 : Math.max(...lagValues),
  };
  for (const [field, value] of Object.entries(outboxLag)) {
    if (!Number.isSafeInteger(value)) metricsInvalid(`outbox_lag.${field}`, "unsafe_integer");
  }

  const alerts: OperationalMetricAlert[] = [];
  const retryCounts = groupCount(spans.filter((span) => span.kind === "retry"));
  for (const [commandId, value] of retryCounts) {
    if (value > policy.maximum_retries_per_command) {
      alerts.push({
        code: "retry_storm",
        severity: "error",
        command_id: commandId as CanonicalId<"command">,
        observed_value: value,
        allowed_value: policy.maximum_retries_per_command,
      });
    }
  }
  for (const span of spans) {
    if (span.outbox_lag_ms !== null && span.outbox_lag_ms > policy.outbox_lag_slo_ms) {
      alerts.push({
        code: "outbox_lag_slo_exceeded",
        severity: "warning",
        command_id: span.command_id,
        observed_value: span.outbox_lag_ms,
        allowed_value: policy.outbox_lag_slo_ms,
      });
    }
    if (span.kind === "outbox_dead_letter") {
      alerts.push({
        code: "outbox_dead_letter",
        severity: "error",
        command_id: span.command_id,
        observed_value: 1,
        allowed_value: 0,
      });
    }
  }
  alerts.sort((left, right) => `${left.code}\u0000${left.command_id}`.localeCompare(`${right.code}\u0000${right.command_id}`));

  return deepFreeze({
    metrics_version: OPERATIONAL_METRICS_VERSION,
    generated_at: input.generated_at,
    policy,
    spans,
    counters,
    outbox_lag: outboxLag,
    alerts,
  });
}

export function assertOperationalMetricsSnapshot(snapshot: OperationalMetricsSnapshot): void {
  if (snapshot.metrics_version !== OPERATIONAL_METRICS_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "operational_metrics",
      found: snapshot.metrics_version,
    });
  }
  const rebuilt = buildOperationalMetricsSnapshot({
    generated_at: snapshot.generated_at,
    policy: snapshot.policy,
    spans: snapshot.spans,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(snapshot)) {
    throw protocolError("seedrop.protocol.operational_metrics_inconsistent", {
      expected_digest: canonicalJsonDigest(rebuilt),
      received_digest: canonicalJsonDigest(snapshot),
    });
  }
}

export type ExplanationConfidence = "confirmed" | "inferred" | "unknown";
export type ExplanationStatus = "resolved" | "unknown";

export interface ExplanationEvidence {
  record_id: GoverningRecordId;
  source_id: string;
  role: string;
  digest: string;
  observed_at: string;
}

export interface ExplanationPolicyTrace {
  policy_id: string;
  policy_version: ProtocolVersion;
  rule_id: string;
}

export interface ExplanationUnknown {
  code: string;
  message: string;
  requested_evidence: readonly string[];
}

export interface FieldExplanationTrace {
  explanation_version: typeof EXPLANATION_TRACE_VERSION;
  situation_id: CanonicalId<"situation">;
  field: string;
  status: ExplanationStatus;
  confidence: ExplanationConfidence;
  value_digest: string | null;
  projection_version: ProtocolVersion;
  policy: ExplanationPolicyTrace;
  decision_record_id: GoverningRecordId | null;
  evidence: readonly ExplanationEvidence[];
  unknown: ExplanationUnknown | null;
}

export interface BuildFieldExplanationInput extends Omit<FieldExplanationTrace, "explanation_version"> {}

export function buildFieldExplanation(input: BuildFieldExplanationInput): FieldExplanationTrace {
  canonicalJson(input);
  assertExactKeys(input, [
    "situation_id", "field", "status", "confidence", "value_digest",
    "projection_version", "policy", "decision_record_id", "evidence", "unknown",
  ], "explanation", "seedrop.protocol.explanation_trace_invalid");
  parseCanonicalId(input.situation_id, "situation");
  assertNonEmpty(input.field, "field", "seedrop.protocol.explanation_trace_invalid");
  const projectionVersion = parseProtocolVersion(input.projection_version, "projection");
  const policy = normalizeExplanationPolicy(input.policy);
  assertArray(input.evidence, "evidence", "seedrop.protocol.explanation_trace_invalid");
  const evidence = input.evidence.map(normalizeExplanationEvidence)
    .sort((left, right) => `${left.record_id}\u0000${left.source_id}`.localeCompare(`${right.record_id}\u0000${right.source_id}`));
  assertUnique(evidence.map((item) => `${item.record_id}\u0000${item.source_id}\u0000${item.role}`), "evidence", "seedrop.protocol.explanation_trace_invalid");

  if (input.status === "resolved") {
    if (!(input.confidence === "confirmed" || input.confidence === "inferred")) explanationInvalid("confidence", "resolved_confidence_required");
    if (input.value_digest === null) explanationInvalid("value_digest", "required");
    assertSha256(input.value_digest, "value_digest", "seedrop.protocol.explanation_trace_invalid");
    if (input.decision_record_id === null) explanationInvalid("decision_record_id", "required");
    assertGoverningRecordId(input.decision_record_id);
    if (evidence.length === 0) explanationInvalid("evidence", "minimum");
    if (!evidence.some((item) => isCanonicalKind(item.record_id, "event") || isCanonicalKind(item.record_id, "receipt"))) {
      explanationInvalid("evidence", "event_or_receipt_required");
    }
    if (input.unknown !== null) explanationInvalid("unknown", "not_permitted");
  } else if (input.status === "unknown") {
    if (input.confidence !== "unknown") explanationInvalid("confidence", "unknown_required");
    if (input.value_digest !== null || input.decision_record_id !== null) explanationInvalid("unknown", "must_not_assert_value_or_decision");
    if (input.unknown === null) explanationInvalid("unknown", "required");
  } else {
    explanationInvalid("status", "unknown");
  }
  const unknown = input.unknown === null ? null : normalizeExplanationUnknown(input.unknown);
  return deepFreeze({
    explanation_version: EXPLANATION_TRACE_VERSION,
    situation_id: input.situation_id,
    field: input.field,
    status: input.status,
    confidence: input.confidence,
    value_digest: input.value_digest,
    projection_version: projectionVersion,
    policy,
    decision_record_id: input.decision_record_id,
    evidence,
    unknown,
  });
}

export function assertFieldExplanation(trace: FieldExplanationTrace): void {
  if (trace.explanation_version !== EXPLANATION_TRACE_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "field_explanation",
      found: trace.explanation_version,
    });
  }
  const rebuilt = buildFieldExplanation({
    situation_id: trace.situation_id,
    field: trace.field,
    status: trace.status,
    confidence: trace.confidence,
    value_digest: trace.value_digest,
    projection_version: trace.projection_version,
    policy: trace.policy,
    decision_record_id: trace.decision_record_id,
    evidence: trace.evidence,
    unknown: trace.unknown,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(trace)) {
    throw protocolError("seedrop.protocol.explanation_trace_inconsistent", {
      expected_digest: canonicalJsonDigest(rebuilt),
      received_digest: canonicalJsonDigest(trace),
    });
  }
}

export type CandidateAcquisition = "index" | "scan";

export interface BoundedOutputCandidate {
  candidate_id: string;
  category: string;
  acquisition: CandidateAcquisition;
  required: boolean;
  priority: number;
  value: JsonValue;
}

export interface BoundedOutputItem {
  candidate_id: string;
  category: string;
  value: JsonValue;
}

export interface BoundedOutputEnvelope {
  budget_version: typeof BOUNDED_OUTPUT_VERSION;
  requested_bytes: number;
  actual_bytes: number;
  complete: boolean;
  candidate_count: number;
  indexed_count: number;
  scanned_count: number;
  scan_limit: number;
  included_count: number;
  omitted_count: number;
  omitted_categories: readonly string[];
  payload: readonly BoundedOutputItem[];
}

export interface CompileBoundedOutputInput {
  requested_bytes: number;
  maximum_scanned_count: number;
  candidates: readonly BoundedOutputCandidate[];
}

export function compileBoundedOutput(input: CompileBoundedOutputInput): BoundedOutputEnvelope {
  canonicalJson(input);
  assertExactKeys(input, ["requested_bytes", "maximum_scanned_count", "candidates"], "budget", "seedrop.protocol.budget_invalid");
  assertPositiveInteger(input.requested_bytes, "requested_bytes", "seedrop.protocol.budget_invalid");
  assertNonNegativeInteger(input.maximum_scanned_count, "maximum_scanned_count", "seedrop.protocol.budget_invalid");
  assertArray(input.candidates, "candidates", "seedrop.protocol.budget_invalid");
  const candidates = input.candidates.map(normalizeBoundedCandidate)
    .sort(compareBoundedCandidates);
  assertUnique(candidates.map((item) => item.candidate_id), "candidate_id", "seedrop.protocol.budget_invalid");
  const scannedCount = candidates.filter((item) => item.acquisition === "scan").length;
  if (scannedCount > input.maximum_scanned_count) {
    throw protocolError("seedrop.protocol.bounded_scan_exceeded", {
      scanned_count: scannedCount,
      allowed_count: input.maximum_scanned_count,
    });
  }

  const included = new Set(candidates.filter((item) => item.required).map((item) => item.candidate_id));
  let envelope = materializeBoundedEnvelope(input, candidates, included);
  if (envelope.actual_bytes > input.requested_bytes) {
    throw protocolError("seedrop.protocol.budget_insufficient", {
      requested_bytes: input.requested_bytes,
      mandatory_bytes: envelope.actual_bytes,
      required_candidate_count: included.size,
    });
  }
  for (const candidate of candidates) {
    if (candidate.required) continue;
    included.add(candidate.candidate_id);
    const proposed = materializeBoundedEnvelope(input, candidates, included);
    if (proposed.actual_bytes <= input.requested_bytes) envelope = proposed;
    else included.delete(candidate.candidate_id);
  }
  envelope = materializeBoundedEnvelope(input, candidates, included);
  if (envelope.actual_bytes > input.requested_bytes) {
    throw protocolError("seedrop.protocol.budget_insufficient", {
      requested_bytes: input.requested_bytes,
      mandatory_bytes: envelope.actual_bytes,
      required_candidate_count: included.size,
    });
  }
  return envelope;
}

export function assertBoundedOutput(envelope: BoundedOutputEnvelope): void {
  if (envelope.budget_version !== BOUNDED_OUTPUT_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "bounded_output",
      found: envelope.budget_version,
    });
  }
  canonicalJson(envelope);
  assertExactKeys(envelope, [
    "budget_version", "requested_bytes", "actual_bytes", "complete", "candidate_count",
    "indexed_count", "scanned_count", "scan_limit", "included_count", "omitted_count",
    "omitted_categories", "payload",
  ], "bounded_output", "seedrop.protocol.budget_invalid");
  if (typeof envelope.complete !== "boolean") budgetInvalid("complete", "boolean_required");
  assertArray(envelope.omitted_categories, "omitted_categories", "seedrop.protocol.budget_invalid");
  assertArray(envelope.payload, "payload", "seedrop.protocol.budget_invalid");
  if (canonicalJsonBytes(envelope).byteLength !== envelope.actual_bytes) budgetInvalid("actual_bytes", "accounting_mismatch");
  if (envelope.actual_bytes > envelope.requested_bytes) budgetInvalid("actual_bytes", "overflow");
  for (const field of [
    "requested_bytes", "actual_bytes", "candidate_count", "indexed_count", "scanned_count",
    "scan_limit", "included_count", "omitted_count",
  ] as const) {
    assertNonNegativeInteger(envelope[field], field, "seedrop.protocol.budget_invalid");
  }
  if (envelope.indexed_count + envelope.scanned_count !== envelope.candidate_count) budgetInvalid("candidate_count", "accounting_mismatch");
  if (envelope.included_count + envelope.omitted_count !== envelope.candidate_count) budgetInvalid("included_count", "accounting_mismatch");
  if (envelope.payload.length !== envelope.included_count) budgetInvalid("payload", "accounting_mismatch");
  if (envelope.scanned_count > envelope.scan_limit) budgetInvalid("scanned_count", "scan_limit_exceeded");
  if (envelope.complete !== (envelope.omitted_count === 0)) budgetInvalid("complete", "omission_mismatch");
  if (envelope.complete !== (envelope.omitted_categories.length === 0)) budgetInvalid("omitted_categories", "complete_mismatch");
  const omittedCategories = envelope.omitted_categories.map((category) => {
    assertNonEmpty(category, "omitted_category", "seedrop.protocol.budget_invalid");
    return category;
  });
  assertUnique(omittedCategories, "omitted_category", "seedrop.protocol.budget_invalid");
  if (omittedCategories.join("\u0000") !== [...omittedCategories].sort().join("\u0000")) budgetInvalid("omitted_categories", "not_canonical");
  envelope.payload.forEach((item, index) => {
    assertExactKeys(item, ["candidate_id", "category", "value"], `payload[${index}]`, "seedrop.protocol.budget_invalid");
    assertNonEmpty(item.candidate_id, `payload[${index}].candidate_id`, "seedrop.protocol.budget_invalid");
    assertNonEmpty(item.category, `payload[${index}].category`, "seedrop.protocol.budget_invalid");
    canonicalJson(item.value);
  });
  assertUnique(envelope.payload.map((item) => item.candidate_id), "payload.candidate_id", "seedrop.protocol.budget_invalid");
}

export function healthBudgetFromBoundedOutput(envelope: BoundedOutputEnvelope): HealthBudget {
  assertBoundedOutput(envelope);
  return deepFreeze({
    requested_bytes: envelope.requested_bytes,
    actual_bytes: envelope.actual_bytes,
    complete: envelope.complete,
    candidate_count: envelope.candidate_count,
    indexed_count: envelope.indexed_count,
    scanned_count: envelope.scanned_count,
    omitted_categories: envelope.omitted_categories,
  });
}

export type TelemetryConsentDecision = "granted" | "denied" | "revoked";

export interface TelemetryConsentScope {
  categories: readonly string[];
  destination: string;
  schema_id: string;
  schema_version: ProtocolVersion;
}

export interface TelemetryConsentReceipt {
  consent_version: typeof TELEMETRY_CONSENT_VERSION;
  receipt_id: CanonicalId<"receipt">;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  decision: TelemetryConsentDecision;
  issued_at: string;
  expires_at: string | null;
  purpose: string;
  scope: TelemetryConsentScope;
  evidence_record_id: GoverningRecordId;
}

export interface BuildTelemetryConsentInput extends Omit<TelemetryConsentReceipt, "consent_version"> {}

export interface TelemetryExportState {
  mode: "local_only" | "consented_export";
  export_enabled: boolean;
  reason: "no_consent" | "denied" | "revoked" | "not_yet_active" | "expired" | "active_grant";
  consent_receipt_id: CanonicalId<"receipt"> | null;
}

export interface TelemetrySecretFinding {
  path: string;
  pattern: "sensitive_key" | "private_key" | "bearer_credential" | "api_credential";
}

export interface TelemetryExportRequest {
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  requested_at: string;
  destination: string;
  schema_id: string;
  schema_version: ProtocolVersion;
  categories: readonly string[];
  payload: JsonValue;
}

export interface TelemetryExportAuthorization {
  export_version: typeof TELEMETRY_EXPORT_VERSION;
  consent_receipt_id: CanonicalId<"receipt">;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  authorized_at: string;
  destination: string;
  schema_id: string;
  schema_version: ProtocolVersion;
  categories: readonly string[];
  payload_digest: string;
}

export function buildTelemetryConsentReceipt(input: BuildTelemetryConsentInput): TelemetryConsentReceipt {
  canonicalJson(input);
  assertExactKeys(input, [
    "receipt_id", "principal_id", "project_id", "decision", "issued_at",
    "expires_at", "purpose", "scope", "evidence_record_id",
  ], "telemetry_consent", "seedrop.protocol.telemetry_consent_invalid");
  parseCanonicalId(input.receipt_id, "receipt");
  parseCanonicalId(input.principal_id, "principal");
  parseCanonicalId(input.project_id, "project");
  if (!(input.decision === "granted" || input.decision === "denied" || input.decision === "revoked")) consentInvalid("decision", "unknown");
  assertTimestamp(input.issued_at, "issued_at", "seedrop.protocol.telemetry_consent_invalid");
  if (input.expires_at !== null) {
    assertTimestamp(input.expires_at, "expires_at", "seedrop.protocol.telemetry_consent_invalid");
    if (Date.parse(input.expires_at) <= Date.parse(input.issued_at)) consentInvalid("expires_at", "not_after_issue");
  }
  if (input.decision === "granted" && input.expires_at === null) consentInvalid("expires_at", "grant_must_expire");
  assertNonEmpty(input.purpose, "purpose", "seedrop.protocol.telemetry_consent_invalid");
  assertGoverningRecordId(input.evidence_record_id);
  if (input.evidence_record_id === input.receipt_id) consentInvalid("evidence_record_id", "self_reference");
  const scope = normalizeTelemetryScope(input.scope);
  return deepFreeze({
    consent_version: TELEMETRY_CONSENT_VERSION,
    receipt_id: input.receipt_id,
    principal_id: input.principal_id,
    project_id: input.project_id,
    decision: input.decision,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    purpose: input.purpose,
    scope,
    evidence_record_id: input.evidence_record_id,
  });
}

export function assertTelemetryConsentReceipt(receipt: TelemetryConsentReceipt): void {
  if (receipt.consent_version !== TELEMETRY_CONSENT_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "telemetry_consent",
      found: receipt.consent_version,
    });
  }
  const rebuilt = buildTelemetryConsentReceipt({
    receipt_id: receipt.receipt_id,
    principal_id: receipt.principal_id,
    project_id: receipt.project_id,
    decision: receipt.decision,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    purpose: receipt.purpose,
    scope: receipt.scope,
    evidence_record_id: receipt.evidence_record_id,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) consentInvalid("receipt", "inconsistent");
}

export function telemetryExportState(
  receipt: TelemetryConsentReceipt | null | undefined,
  observedAt: string,
): TelemetryExportState {
  assertTimestamp(observedAt, "observed_at", "seedrop.protocol.telemetry_consent_invalid");
  if (!receipt) {
    return Object.freeze({
      mode: TELEMETRY_DEFAULT_MODE,
      export_enabled: false,
      reason: "no_consent",
      consent_receipt_id: null,
    });
  }
  assertTelemetryConsentReceipt(receipt);
  if (Date.parse(observedAt) < Date.parse(receipt.issued_at)) {
    return Object.freeze({
      mode: TELEMETRY_DEFAULT_MODE,
      export_enabled: false,
      reason: "not_yet_active",
      consent_receipt_id: receipt.receipt_id,
    });
  }
  const expired = receipt.expires_at !== null && Date.parse(observedAt) >= Date.parse(receipt.expires_at);
  if (receipt.decision !== "granted" || expired) {
    const reason = expired ? "expired" : receipt.decision === "denied" ? "denied" : "revoked";
    return Object.freeze({
      mode: TELEMETRY_DEFAULT_MODE,
      export_enabled: false,
      reason,
      consent_receipt_id: receipt.receipt_id,
    });
  }
  return Object.freeze({
    mode: "consented_export",
    export_enabled: true,
    reason: "active_grant",
    consent_receipt_id: receipt.receipt_id,
  });
}

export function findTelemetrySecretPatterns(payload: JsonValue): readonly TelemetrySecretFinding[] {
  canonicalJson(payload);
  const findings: TelemetrySecretFinding[] = [];
  walkTelemetry(payload, "$", findings);
  return deepFreeze(findings.sort((left, right) => `${left.path}\u0000${left.pattern}`.localeCompare(`${right.path}\u0000${right.pattern}`)));
}

export function authorizeTelemetryExport(
  receipt: TelemetryConsentReceipt | null | undefined,
  request: TelemetryExportRequest,
): TelemetryExportAuthorization {
  canonicalJson(request);
  normalizeTelemetryRequest(request);
  const state = telemetryExportState(receipt, request.requested_at);
  if (!receipt || !state.export_enabled) {
    throw protocolError("seedrop.protocol.telemetry_export_denied", {
      reason: state.reason,
    });
  }
  if (receipt.principal_id !== request.principal_id || receipt.project_id !== request.project_id) {
    telemetryDenied("identity_scope_mismatch");
  }
  if (receipt.scope.destination !== request.destination) telemetryDenied("destination_mismatch");
  if (receipt.scope.schema_id !== request.schema_id || receipt.scope.schema_version !== request.schema_version) {
    telemetryDenied("schema_mismatch");
  }
  const allowed = new Set(receipt.scope.categories);
  if (request.categories.some((category) => !allowed.has(category))) telemetryDenied("category_scope_mismatch");
  const findings = findTelemetrySecretPatterns(request.payload);
  if (findings.length > 0) {
    throw protocolError("seedrop.protocol.telemetry_secret_detected", {
      finding_count: findings.length,
      first_path: findings[0]!.path,
      first_pattern: findings[0]!.pattern,
    });
  }
  return deepFreeze({
    export_version: TELEMETRY_EXPORT_VERSION,
    consent_receipt_id: receipt.receipt_id,
    principal_id: request.principal_id,
    project_id: request.project_id,
    authorized_at: request.requested_at,
    destination: request.destination,
    schema_id: request.schema_id,
    schema_version: parseProtocolVersion(request.schema_version),
    categories: Object.freeze([...request.categories].sort()),
    payload_digest: canonicalJsonDigest(request.payload),
  });
}

function normalizeMetricPolicy(policy: OperationalMetricPolicy): OperationalMetricPolicy {
  assertExactKeys(policy, [
    "policy_id", "policy_version", "maximum_retries_per_command", "outbox_lag_slo_ms",
  ], "metrics.policy", "seedrop.protocol.operational_metrics_invalid");
  assertNonEmpty(policy.policy_id, "policy.policy_id", "seedrop.protocol.operational_metrics_invalid");
  assertNonNegativeInteger(policy.maximum_retries_per_command, "policy.maximum_retries_per_command", "seedrop.protocol.operational_metrics_invalid");
  assertNonNegativeInteger(policy.outbox_lag_slo_ms, "policy.outbox_lag_slo_ms", "seedrop.protocol.operational_metrics_invalid");
  return Object.freeze({
    policy_id: policy.policy_id,
    policy_version: parseProtocolVersion(policy.policy_version),
    maximum_retries_per_command: policy.maximum_retries_per_command,
    outbox_lag_slo_ms: policy.outbox_lag_slo_ms,
  });
}

function normalizeMetricSpan(span: OperationalMetricSpan, index: number, generatedAt: string): OperationalMetricSpan {
  assertExactKeys(span, [
    "event_id", "project_id", "command_id", "kind", "operation", "observed_at",
    "duration_ms", "attempt", "outbox_lag_ms", "evidence_digest",
  ], `spans[${index}]`, "seedrop.protocol.operational_metrics_invalid");
  parseCanonicalId(span.event_id, "event");
  parseCanonicalId(span.project_id, "project");
  parseCanonicalId(span.command_id, "command");
  if (!OPERATIONAL_METRIC_KINDS.includes(span.kind)) metricsInvalid(`spans[${index}].kind`, "unknown");
  assertNonEmpty(span.operation, `spans[${index}].operation`, "seedrop.protocol.operational_metrics_invalid");
  assertTimestamp(span.observed_at, `spans[${index}].observed_at`, "seedrop.protocol.operational_metrics_invalid");
  if (Date.parse(span.observed_at) > Date.parse(generatedAt)) metricsInvalid(`spans[${index}].observed_at`, "after_generated_at");
  assertNonNegativeInteger(span.duration_ms, `spans[${index}].duration_ms`, "seedrop.protocol.operational_metrics_invalid");
  assertNonNegativeInteger(span.attempt, `spans[${index}].attempt`, "seedrop.protocol.operational_metrics_invalid");
  const outboxKind = span.kind === "outbox_lag" || span.kind === "outbox_dead_letter";
  if (outboxKind !== (span.outbox_lag_ms !== null)) metricsInvalid(`spans[${index}].outbox_lag_ms`, "kind_mismatch");
  if (span.outbox_lag_ms !== null) {
    assertNonNegativeInteger(span.outbox_lag_ms, `spans[${index}].outbox_lag_ms`, "seedrop.protocol.operational_metrics_invalid");
  }
  assertSha256(span.evidence_digest, `spans[${index}].evidence_digest`, "seedrop.protocol.operational_metrics_invalid");
  return Object.freeze({ ...span });
}

function count(spans: readonly OperationalMetricSpan[], kind: OperationalMetricKind): number {
  return spans.filter((span) => span.kind === kind).length;
}

function groupCount(spans: readonly OperationalMetricSpan[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const span of spans) result.set(span.command_id, (result.get(span.command_id) ?? 0) + 1);
  return result;
}

function normalizeExplanationPolicy(policy: ExplanationPolicyTrace): ExplanationPolicyTrace {
  assertExactKeys(policy, ["policy_id", "policy_version", "rule_id"], "explanation.policy", "seedrop.protocol.explanation_trace_invalid");
  assertNonEmpty(policy.policy_id, "policy.policy_id", "seedrop.protocol.explanation_trace_invalid");
  assertNonEmpty(policy.rule_id, "policy.rule_id", "seedrop.protocol.explanation_trace_invalid");
  return Object.freeze({
    policy_id: policy.policy_id,
    policy_version: parseProtocolVersion(policy.policy_version),
    rule_id: policy.rule_id,
  });
}

function normalizeExplanationEvidence(evidence: ExplanationEvidence, index: number): ExplanationEvidence {
  assertExactKeys(evidence, [
    "record_id", "source_id", "role", "digest", "observed_at",
  ], `evidence[${index}]`, "seedrop.protocol.explanation_trace_invalid");
  assertGoverningRecordId(evidence.record_id);
  assertNonEmpty(evidence.source_id, `evidence[${index}].source_id`, "seedrop.protocol.explanation_trace_invalid");
  assertNonEmpty(evidence.role, `evidence[${index}].role`, "seedrop.protocol.explanation_trace_invalid");
  assertSha256(evidence.digest, `evidence[${index}].digest`, "seedrop.protocol.explanation_trace_invalid");
  assertTimestamp(evidence.observed_at, `evidence[${index}].observed_at`, "seedrop.protocol.explanation_trace_invalid");
  return Object.freeze({ ...evidence });
}

function normalizeExplanationUnknown(unknown: ExplanationUnknown): ExplanationUnknown {
  assertExactKeys(unknown, ["code", "message", "requested_evidence"], "unknown", "seedrop.protocol.explanation_trace_invalid");
  assertNonEmpty(unknown.code, "unknown.code", "seedrop.protocol.explanation_trace_invalid");
  assertNonEmpty(unknown.message, "unknown.message", "seedrop.protocol.explanation_trace_invalid");
  assertArray(unknown.requested_evidence, "unknown.requested_evidence", "seedrop.protocol.explanation_trace_invalid");
  const requested = unknown.requested_evidence.map((value) => {
    assertNonEmpty(value, "unknown.requested_evidence", "seedrop.protocol.explanation_trace_invalid");
    return value;
  }).sort();
  assertUnique(requested, "unknown.requested_evidence", "seedrop.protocol.explanation_trace_invalid");
  if (requested.length === 0) explanationInvalid("unknown.requested_evidence", "minimum");
  return Object.freeze({ code: unknown.code, message: unknown.message, requested_evidence: Object.freeze(requested) });
}

function normalizeBoundedCandidate(candidate: BoundedOutputCandidate, index: number): BoundedOutputCandidate {
  assertExactKeys(candidate, [
    "candidate_id", "category", "acquisition", "required", "priority", "value",
  ], `candidates[${index}]`, "seedrop.protocol.budget_invalid");
  assertNonEmpty(candidate.candidate_id, `candidates[${index}].candidate_id`, "seedrop.protocol.budget_invalid");
  assertNonEmpty(candidate.category, `candidates[${index}].category`, "seedrop.protocol.budget_invalid");
  if (!(candidate.acquisition === "index" || candidate.acquisition === "scan")) budgetInvalid(`candidates[${index}].acquisition`, "unknown");
  if (typeof candidate.required !== "boolean") budgetInvalid(`candidates[${index}].required`, "boolean_required");
  assertNonNegativeInteger(candidate.priority, `candidates[${index}].priority`, "seedrop.protocol.budget_invalid");
  canonicalJson(candidate.value);
  return deepFreeze({ ...candidate, value: structuredClone(candidate.value) });
}

function compareBoundedCandidates(left: BoundedOutputCandidate, right: BoundedOutputCandidate): number {
  if (left.required !== right.required) return left.required ? -1 : 1;
  if (left.priority !== right.priority) return right.priority - left.priority;
  return left.candidate_id.localeCompare(right.candidate_id);
}

function materializeBoundedEnvelope(
  input: CompileBoundedOutputInput,
  candidates: readonly BoundedOutputCandidate[],
  included: ReadonlySet<string>,
): BoundedOutputEnvelope {
  const omitted = candidates.filter((item) => !included.has(item.candidate_id));
  const base = {
    budget_version: BOUNDED_OUTPUT_VERSION,
    requested_bytes: input.requested_bytes,
    complete: omitted.length === 0,
    candidate_count: candidates.length,
    indexed_count: candidates.filter((item) => item.acquisition === "index").length,
    scanned_count: candidates.filter((item) => item.acquisition === "scan").length,
    scan_limit: input.maximum_scanned_count,
    included_count: included.size,
    omitted_count: omitted.length,
    omitted_categories: Object.freeze([...new Set(omitted.map((item) => item.category))].sort()),
    payload: Object.freeze(candidates.filter((item) => included.has(item.candidate_id)).map((item) => Object.freeze({
      candidate_id: item.candidate_id,
      category: item.category,
      value: structuredClone(item.value),
    }))),
  };
  let actualBytes = 0;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const candidate = { ...base, actual_bytes: actualBytes };
    const measured = canonicalJsonBytes(candidate).byteLength;
    if (measured === actualBytes) return deepFreeze(candidate);
    actualBytes = measured;
  }
  budgetInvalid("actual_bytes", "fixed_point_failed");
}

function normalizeTelemetryScope(scope: TelemetryConsentScope): TelemetryConsentScope {
  assertExactKeys(scope, ["categories", "destination", "schema_id", "schema_version"], "scope", "seedrop.protocol.telemetry_consent_invalid");
  assertArray(scope.categories, "scope.categories", "seedrop.protocol.telemetry_consent_invalid");
  const categories = scope.categories.map((value) => {
    assertNonEmpty(value, "scope.category", "seedrop.protocol.telemetry_consent_invalid");
    return value;
  }).sort();
  assertUnique(categories, "scope.category", "seedrop.protocol.telemetry_consent_invalid");
  if (categories.length === 0) consentInvalid("scope.categories", "minimum");
  assertNonEmpty(scope.destination, "scope.destination", "seedrop.protocol.telemetry_consent_invalid");
  assertNonEmpty(scope.schema_id, "scope.schema_id", "seedrop.protocol.telemetry_consent_invalid");
  return Object.freeze({
    categories: Object.freeze(categories),
    destination: scope.destination,
    schema_id: scope.schema_id,
    schema_version: parseProtocolVersion(scope.schema_version),
  });
}

function normalizeTelemetryRequest(request: TelemetryExportRequest): void {
  assertExactKeys(request, [
    "principal_id", "project_id", "requested_at", "destination", "schema_id",
    "schema_version", "categories", "payload",
  ], "telemetry_export", "seedrop.protocol.telemetry_export_denied");
  parseCanonicalId(request.principal_id, "principal");
  parseCanonicalId(request.project_id, "project");
  assertTimestamp(request.requested_at, "requested_at", "seedrop.protocol.telemetry_export_denied");
  assertNonEmpty(request.destination, "destination", "seedrop.protocol.telemetry_export_denied");
  assertNonEmpty(request.schema_id, "schema_id", "seedrop.protocol.telemetry_export_denied");
  parseProtocolVersion(request.schema_version);
  assertArray(request.categories, "categories", "seedrop.protocol.telemetry_export_denied");
  for (const category of request.categories) assertNonEmpty(category, "category", "seedrop.protocol.telemetry_export_denied");
  assertUnique(request.categories, "category", "seedrop.protocol.telemetry_export_denied");
  if (request.categories.length === 0) telemetryDenied("categories_empty");
  canonicalJson(request.payload);
  if (request.payload === null || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    telemetryDenied("payload_object_required");
  }
  const payloadCategories = Object.keys(request.payload).sort();
  const requestedCategories = [...request.categories].sort();
  if (payloadCategories.join("\u0000") !== requestedCategories.join("\u0000")) {
    telemetryDenied("payload_category_mismatch");
  }
}

function walkTelemetry(value: JsonValue, path: string, findings: TelemetrySecretFinding[]): void {
  if (typeof value === "string") {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) findings.push({ path, pattern: "private_key" });
    if (/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/i.test(value)) findings.push({ path, pattern: "bearer_credential" });
    if (/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/.test(value)) findings.push({ path, pattern: "api_credential" });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkTelemetry(item, `${path}[${index}]`, findings));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-\s]+/g, "_");
    if (SENSITIVE_TELEMETRY_KEYS.has(normalized)) findings.push({ path: `${path}.${key}`, pattern: "sensitive_key" });
    walkTelemetry(child, `${path}.${key}`, findings);
  }
}

const SENSITIVE_TELEMETRY_KEYS = new Set([
  "api_key",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "token",
  "access_token",
]);

function assertGoverningRecordId(value: GoverningRecordId): void {
  for (const kind of ["claim", "receipt", "event"] as const) {
    try {
      parseCanonicalId(value, kind);
      return;
    } catch {
      // Try the next permitted evidence kind.
    }
  }
  explanationInvalid("record_id", "unsupported_kind");
}

function isCanonicalKind(value: GoverningRecordId, kind: "event" | "receipt"): boolean {
  try {
    parseCanonicalId(value, kind);
    return true;
  } catch {
    return false;
  }
}

type LocalErrorCode =
  | "seedrop.protocol.operational_metrics_invalid"
  | "seedrop.protocol.explanation_trace_invalid"
  | "seedrop.protocol.budget_invalid"
  | "seedrop.protocol.telemetry_consent_invalid"
  | "seedrop.protocol.telemetry_export_denied";

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  field: string,
  code: LocalErrorCode,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(code, { field, reason: "object_required" });
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw protocolError(code, { field, reason: "unknown_fields", unknown_fields: extras.sort().join(",") });
}

function assertArray(value: unknown, field: string, code: LocalErrorCode): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError(code, { field, reason: "array_required" });
}

function assertNonEmpty(value: string, field: string, code: LocalErrorCode): void {
  if (typeof value !== "string" || value.trim().length === 0) throw protocolError(code, { field, reason: "nonempty_string_required" });
}

function assertTimestamp(value: string, field: string, code: LocalErrorCode): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw protocolError(code, { field, reason: "timestamp_required" });
  }
}

function assertSha256(value: string, field: string, code: LocalErrorCode): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw protocolError(code, { field, reason: "sha256_required" });
}

function assertNonNegativeInteger(value: number, field: string, code: LocalErrorCode): void {
  if (!Number.isSafeInteger(value) || value < 0) throw protocolError(code, { field, reason: "nonnegative_integer_required" });
}

function assertPositiveInteger(value: number, field: string, code: LocalErrorCode): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw protocolError(code, { field, reason: "positive_integer_required" });
}

function assertUnique(values: readonly string[], field: string, code: LocalErrorCode): void {
  if (new Set(values).size !== values.length) throw protocolError(code, { field, reason: "duplicate" });
}

function metricsInvalid(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.operational_metrics_invalid", { field, reason });
}

function explanationInvalid(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.explanation_trace_invalid", { field, reason });
}

function budgetInvalid(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.budget_invalid", { field, reason });
}

function consentInvalid(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.telemetry_consent_invalid", { field, reason });
}

function telemetryDenied(reason: string): never {
  throw protocolError("seedrop.protocol.telemetry_export_denied", { reason });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
