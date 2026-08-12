import { canonicalJsonBytes } from "@seedrop/protocol";
import type { ProjectTransactionDigest } from "@seedrop/protocol";
import type { SituatedField, SituationProjection } from "./types.js";

export const BOUNDED_SITUATION_VERSION = "1.0.0" as const;

export interface BoundedSituationMetrics {
  candidate_count: number;
  indexed_count: number;
  scanned_count: number;
  event_count: number;
  file_count: number;
}

export interface BoundedSituationBudget extends BoundedSituationMetrics {
  requested_bytes: number;
  actual_bytes: number;
  complete: boolean;
  omitted_categories: readonly string[];
}

export interface BoundedSituationProjection {
  schema_version: typeof BOUNDED_SITUATION_VERSION;
  situation_id: ProjectTransactionDigest;
  decision_id: ProjectTransactionDigest;
  budget: BoundedSituationBudget;
  orientation: {
    intent: unknown;
    risk: unknown;
    delivery: unknown;
    grave: unknown;
    source_health: unknown;
    next_action: unknown;
  };
  trust?: Readonly<Record<string, unknown>>;
}

export class SituationBudgetInsufficientError extends Error {
  readonly code = "seedrop.situation.budget_insufficient";
  constructor(readonly requested_bytes: number, readonly required_bytes: number) {
    super(`Situation budget ${requested_bytes} bytes cannot fit the ${required_bytes}-byte mandatory envelope.`);
  }
}

export function compileBoundedSituation(
  situation: SituationProjection,
  options: { requested_bytes: number; metrics: BoundedSituationMetrics },
): BoundedSituationProjection {
  assertMetrics(options);
  const omitted = new Set<string>();
  const orientation = {
    intent: compactIntent(situation, omitted),
    risk: compactRisks(situation, omitted),
    delivery: compactDelivery(situation, omitted),
    grave: compactGrave(situation, omitted),
    source_health: compactHealth(situation, omitted),
    next_action: compactDecision(situation, omitted),
  };
  const base = { schema_version: BOUNDED_SITUATION_VERSION, situation_id: situation.situation_id,
    decision_id: situation.decision_id, budget: budget(options, omitted), orientation };
  let result = finalize(base);
  if (byteLength(result) > options.requested_bytes) {
    omitted.add("orientation_detail");
    result = finalize({ ...base, budget: budget(options, omitted), orientation: minimalOrientation(situation) });
  }
  if (byteLength(result) > options.requested_bytes) throw new SituationBudgetInsufficientError(options.requested_bytes, byteLength(result));

  const trust = Object.fromEntries((["intent", "risk", "delivery", "grave", "source_health", "next_action"] as const)
    .map((name) => [name, compactTrust(situation[name])]));
  const withTrust = finalize({ ...result, trust, budget: budget(options, omitted) });
  if (byteLength(withTrust) <= options.requested_bytes) result = withTrust;
  else omitted.add("field_trust_detail");
  result = finalize({ ...result, budget: budget(options, omitted) });
  if (byteLength(result) > options.requested_bytes) throw new SituationBudgetInsufficientError(options.requested_bytes, byteLength(result));
  return deepFreeze(result as BoundedSituationProjection);
}

export function boundedSituationBytes(value: BoundedSituationProjection): Uint8Array { return canonicalJsonBytes(value); }

function compactIntent(situation: SituationProjection, omitted: Set<string>): unknown {
  const value = situation.intent.value;
  if (!value) return null;
  return { intent_id: value.intent_id, title: text(value.title, 120, "intent_text", omitted), state: value.state,
    episode_id: value.episode_id, goal: value.goal === null ? null : text(value.goal, 160, "intent_text", omitted) };
}
function compactRisks(situation: SituationProjection, omitted: Set<string>): unknown {
  if (situation.risk.value.length > 4) omitted.add("additional_risks");
  return situation.risk.value.slice(0, 4).map((risk) => ({ code: risk.code, severity: risk.severity,
    summary: text(risk.summary, 120, "risk_text", omitted), source_ids: risk.source_ids.slice(0, 4) }));
}
function compactDelivery(situation: SituationProjection, omitted: Set<string>): unknown {
  const value = situation.delivery.value;
  if (!value) return null;
  if (value.contradictions.length > 3) omitted.add("additional_contradictions");
  return { subject_id: value.subject_id, reported_lifecycle: value.reported_lifecycle, evidence: value.evidence,
    delivery: value.delivery, contradictions: value.contradictions.slice(0, 3) };
}
function compactGrave(situation: SituationProjection, omitted: Set<string>): unknown {
  const value = situation.grave.value;
  return value ? { subject_id: value.subject_id, kind: value.kind, cause: text(value.cause, 120, "grave_text", omitted),
    retry_status: value.retry_status, retry_condition: text(value.retry_condition, 120, "grave_text", omitted), completeness: value.completeness } : null;
}
function compactHealth(situation: SituationProjection, omitted: Set<string>): unknown {
  const value = situation.source_health.value;
  if (!value) return null;
  if (value.degraded_source_ids.length > 8) omitted.add("additional_degraded_sources");
  return { substrate: value.substrate, degraded_source_ids: value.degraded_source_ids.slice(0, 8),
    quarantine_count: value.quarantine_count, unresolved_disagreement_count: value.unresolved_disagreement_count };
}
function compactDecision(situation: SituationProjection, omitted: Set<string>): unknown {
  const value = situation.next_action.value;
  if (value.disposition === "recommend") return { disposition: value.disposition, action: value.action,
    reason: text(value.reason, 160, "decision_text", omitted), command: value.command,
    restrictions: value.restrictions.slice(0, 4) };
  if (value.blocking_unknowns.length > 6 || value.evidence_requests.length > 6) omitted.add("additional_refusal_evidence");
  return { disposition: value.disposition, reason: text(value.reason, 160, "decision_text", omitted),
    blocking_unknowns: value.blocking_unknowns.slice(0, 6), evidence_requests: value.evidence_requests.slice(0, 6),
    smallest_repair: value.smallest_repair };
}
function minimalOrientation(situation: SituationProjection): BoundedSituationProjection["orientation"] {
  const decision = situation.next_action.value;
  return { intent: situation.intent.value ? { intent_id: situation.intent.value.intent_id, state: situation.intent.value.state } : null,
    risk: situation.risk.value[0] ? { code: situation.risk.value[0].code, severity: situation.risk.value[0].severity } : [],
    delivery: situation.delivery.value ? { evidence: situation.delivery.value.evidence, delivery: situation.delivery.value.delivery } : null,
    grave: situation.grave.value ? { kind: situation.grave.value.kind, retry_status: situation.grave.value.retry_status } : null,
    source_health: situation.source_health.value ? { substrate: situation.source_health.value.substrate,
      quarantine_count: situation.source_health.value.quarantine_count } : null,
    next_action: decision.disposition === "recommend" ? { disposition: "recommend", action: decision.action } :
      { disposition: "refuse", smallest_repair: decision.smallest_repair } };
}
function compactTrust(field: SituatedField<unknown>): unknown { return { freshness: field.freshness, completeness: field.completeness,
  source_ids: field.provenance.map((item) => item.source_id), missing: field.missing.slice(0, 8) }; }
function text(value: string, limit: number, category: string, omitted: Set<string>): string { if (value.length <= limit) return value; omitted.add(category); return `${value.slice(0, limit - 1)}…`; }
function budget(options: { requested_bytes: number; metrics: BoundedSituationMetrics }, omitted: ReadonlySet<string>): BoundedSituationBudget { return { requested_bytes: options.requested_bytes, actual_bytes: 0,
  complete: omitted.size === 0, ...options.metrics, omitted_categories: [...omitted].sort() }; }
function finalize<T extends { budget: BoundedSituationBudget }>(value: T): T { let result = value; for (let index = 0; index < 8; index += 1) { const actual = byteLength(result); if (result.budget.actual_bytes === actual) return result; result = { ...result, budget: { ...result.budget, actual_bytes: actual } }; } return result; }
function byteLength(value: unknown): number { return canonicalJsonBytes(value).byteLength; }
function assertMetrics(options: { requested_bytes: number; metrics: BoundedSituationMetrics }): void { if (!Number.isSafeInteger(options.requested_bytes) || options.requested_bytes < 1) throw new Error("requested_bytes must be a positive safe integer."); for (const [name, value] of Object.entries(options.metrics)) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`); if (options.metrics.scanned_count > options.metrics.candidate_count) throw new Error("scanned_count cannot exceed candidate_count."); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
