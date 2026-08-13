import { canonicalJsonBytes, canonicalJsonDigest } from "@seedrop/protocol";
import type { JsonValue, ProjectTransactionDigest } from "@seedrop/protocol";
import type { BoundedSituationBudget, BoundedSituationProjection } from "./budget.js";

export const ADAPTER_SITUATION_VERSION = "1.0.0" as const;
export const ADAPTER_BUCKETS = ["ongoing", "needs_attention", "up_next", "quiet"] as const;
export const ADAPTER_HEALTH_STATES = ["healthy", "degraded", "blocked", "unknown"] as const;
export const ADAPTER_READINESS_STATES = ["ready", "active", "review", "blocked", "unknown"] as const;
export type AdapterBucket = typeof ADAPTER_BUCKETS[number];
export type AdapterHealthState = typeof ADAPTER_HEALTH_STATES[number];
export type AdapterReadinessState = typeof ADAPTER_READINESS_STATES[number];

export interface AdapterSituationHealth {
  state: AdapterHealthState;
  substrate: string;
  freshness: string;
  completeness: string;
  degraded_source_ids: readonly string[];
  quarantine_count: number;
  unresolved_disagreement_count: number;
}

export interface AdapterSituationDecision {
  disposition: "recommend" | "refuse" | "unknown";
  action: string | null;
  reason: string | null;
  smallest_repair: string | null;
  display: string;
}

export interface AdapterSituationProjection {
  adapter_version: typeof ADAPTER_SITUATION_VERSION;
  situation_id: ProjectTransactionDigest;
  decision_id: ProjectTransactionDigest;
  semantic_digest: ProjectTransactionDigest;
  bucket: AdapterBucket;
  readiness: AdapterReadinessState;
  health: AdapterSituationHealth;
  decision: AdapterSituationDecision;
  orientation: BoundedSituationProjection["orientation"];
  trust: Readonly<Record<string, JsonValue>>;
  budget: BoundedSituationBudget;
  warnings: readonly string[];
  mutation_capability: "read_only";
}

export type AdapterFallbackReason = "feature_disabled" | "projection_missing" | "projection_mismatch";
export type AdapterSituationSelection =
  | { mode: "v2"; reason: null; warning: null; served: { kind: "v2_situation"; payload: AdapterSituationProjection } }
  | { mode: "v1_fallback"; reason: AdapterFallbackReason; warning: string; served: { kind: "v1"; payload: JsonValue } };

export class AdapterMutationRejectedError extends Error {
  readonly code = "seedrop.adapter.direct_mutation_rejected";
  readonly recovery = "Submit a registered command through @seedrop/kernel or an approved compatibility translator.";
  constructor(readonly operation: string) { super(`Adapter operation ${operation} cannot mutate v2 truth directly.`); }
}

export function compileAdapterSituation(input: BoundedSituationProjection): AdapterSituationProjection {
  const health = compileHealth(input);
  const decision = compileDecision(input);
  const bucket = compileBucket(input, health);
  const warnings = compileWarnings(input, health);
  const body = deepFreeze({ adapter_version: ADAPTER_SITUATION_VERSION, situation_id: input.situation_id,
    decision_id: input.decision_id, bucket, readiness: compileReadiness(health, bucket, decision), health, decision,
    orientation: input.orientation, trust: input.trust ?? {}, budget: input.budget,
    warnings, mutation_capability: "read_only" as const });
  return deepFreeze({ ...body, semantic_digest: canonicalJsonDigest(body) as ProjectTransactionDigest });
}

export function adapterSituationBytes(input: AdapterSituationProjection): Uint8Array { return canonicalJsonBytes(input); }

export function assertAdapterSituation(input: unknown): asserts input is AdapterSituationProjection {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("object_required");
  const value = input as Record<string, unknown>;
  const required = ["adapter_version", "situation_id", "decision_id", "semantic_digest", "bucket", "readiness", "health", "decision", "orientation", "trust", "budget", "warnings", "mutation_capability"];
  if (Object.keys(value).sort().join("\u0000") !== [...required].sort().join("\u0000")) invalid("exact_fields_required");
  if (value.adapter_version !== ADAPTER_SITUATION_VERSION || value.mutation_capability !== "read_only") invalid("version_or_capability");
  if (![value.situation_id, value.decision_id, value.semantic_digest].every(isDigest)) invalid("digest_required");
  if (!(ADAPTER_BUCKETS as readonly unknown[]).includes(value.bucket)) invalid("bucket_unknown");
  if (!(ADAPTER_READINESS_STATES as readonly unknown[]).includes(value.readiness)) invalid("readiness_unknown");
  const health = value.health as Record<string, unknown>;
  if (!health || !(ADAPTER_HEALTH_STATES as readonly unknown[]).includes(health.state)) invalid("health_invalid");
  const decision = value.decision as Record<string, unknown>;
  if (!decision || !["recommend", "refuse", "unknown"].includes(String(decision.disposition))
    || typeof decision.display !== "string") invalid("decision_invalid");
  if (!Array.isArray(value.warnings) || value.warnings.some((item) => typeof item !== "string")) invalid("warnings_invalid");
  canonicalJsonBytes(input);
  const { semantic_digest: _digest, ...body } = value;
  if (canonicalJsonDigest(body) !== value.semantic_digest) invalid("semantic_digest_mismatch");
}

export function selectAdapterSituation(input: {
  feature_enabled: boolean;
  shared: AdapterSituationProjection | null;
  legacy: JsonValue;
  expected?: { situation_id?: ProjectTransactionDigest; decision_id?: ProjectTransactionDigest; semantic_digest?: ProjectTransactionDigest };
  projection_invalid?: boolean;
}): AdapterSituationSelection {
  if (!input.feature_enabled) return fallback("feature_disabled", input.legacy);
  if (input.projection_invalid) return fallback("projection_mismatch", input.legacy);
  if (!input.shared) return fallback("projection_missing", input.legacy);
  const expected = input.expected;
  if (expected && ((expected.situation_id && expected.situation_id !== input.shared.situation_id)
    || (expected.decision_id && expected.decision_id !== input.shared.decision_id)
    || (expected.semantic_digest && expected.semantic_digest !== input.shared.semantic_digest))) {
    return fallback("projection_mismatch", input.legacy);
  }
  return deepFreeze({ mode: "v2", reason: null, warning: null,
    served: { kind: "v2_situation", payload: input.shared } });
}

export function adapterFeatureEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === "1" || value === "true" || value === "enabled";
}

export function assertAdapterReadOnlyOperation(operation: string): void {
  if (!new Set(["read", "render", "translate", "compare"]).has(operation)) throw new AdapterMutationRejectedError(operation);
}

function compileHealth(input: BoundedSituationProjection): AdapterSituationHealth {
  const source = object(input.orientation.source_health), trust = object(input.trust?.source_health);
  const substrate = string(source.substrate) ?? "unknown";
  const freshness = string(trust.freshness) ?? "unknown";
  const completeness = string(trust.completeness) ?? (input.budget.complete ? "complete" : "partial");
  const quarantine = integer(source.quarantine_count), disagreements = integer(source.unresolved_disagreement_count);
  const degraded = strings(source.degraded_source_ids);
  const blocked = ["corrupt", "unreachable"].includes(substrate) || disagreements > 0;
  const unhealthy = substrate !== "healthy" || freshness !== "current" || completeness !== "complete"
    || degraded.length > 0 || quarantine > 0 || !input.budget.complete;
  return deepFreeze({ state: blocked ? "blocked" : substrate === "unknown" ? "unknown" : unhealthy ? "degraded" : "healthy",
    substrate, freshness, completeness, degraded_source_ids: degraded, quarantine_count: quarantine,
    unresolved_disagreement_count: disagreements });
}

function compileBucket(input: BoundedSituationProjection, health: AdapterSituationHealth): AdapterBucket {
  const decision = object(input.orientation.next_action), intent = object(input.orientation.intent);
  if (health.state === "blocked" || decision.disposition === "refuse") return "needs_attention";
  const state = string(intent.state);
  if (state && ["active", "in_progress", "claimed"].includes(state)) return "ongoing";
  if (decision.disposition === "recommend" || intent.intent_id) return "up_next";
  return "quiet";
}

function compileDecision(input: BoundedSituationProjection): AdapterSituationDecision {
  const value = object(input.orientation.next_action);
  const rawDisposition = string(value.disposition);
  const disposition = rawDisposition === "recommend" || rawDisposition === "refuse" ? rawDisposition : "unknown";
  const action = string(value.action);
  const reason = string(value.reason);
  const smallestRepair = string(value.smallest_repair);
  const display = disposition === "refuse"
    ? smallestRepair ?? reason ?? "Refuse unsafe continuation"
    : action ?? reason ?? (disposition === "recommend" ? "Continue" : "Decision unavailable");
  return deepFreeze({ disposition, action, reason, smallest_repair: smallestRepair, display });
}

function compileReadiness(
  health: AdapterSituationHealth,
  bucket: AdapterBucket,
  decision: AdapterSituationDecision,
): AdapterReadinessState {
  if (health.state === "blocked" || decision.disposition === "refuse") return "blocked";
  if (health.state === "unknown") return "unknown";
  if (health.state === "degraded") return "review";
  if (bucket === "ongoing") return "active";
  return "ready";
}

function compileWarnings(input: BoundedSituationProjection, health: AdapterSituationHealth): readonly string[] {
  const warnings: string[] = [];
  if (!input.budget.complete) warnings.push(`budget_limited:${input.budget.omitted_categories.join(",")}`);
  if (health.freshness !== "current") warnings.push(`freshness:${health.freshness}`);
  if (health.completeness !== "complete") warnings.push(`completeness:${health.completeness}`);
  if (health.quarantine_count > 0) warnings.push(`quarantine:${health.quarantine_count}`);
  if (health.unresolved_disagreement_count > 0) warnings.push(`unresolved_disagreement:${health.unresolved_disagreement_count}`);
  return Object.freeze([...new Set(warnings)].sort());
}

function fallback(reason: AdapterFallbackReason, legacy: JsonValue): AdapterSituationSelection {
  return deepFreeze({ mode: "v1_fallback", reason,
    warning: reason === "projection_mismatch" ? "projection_mismatch: v1 remains served" : `${reason}: v1 remains served`,
    served: { kind: "v1", payload: legacy } });
}
function isDigest(value: unknown): boolean { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }
function invalid(reason: string): never { throw new Error(`Invalid adapter Situation: ${reason}.`); }
function object(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function string(value: JsonValue | undefined): string | null { return typeof value === "string" ? value : null; }
function integer(value: JsonValue | undefined): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0; }
function strings(value: JsonValue | undefined): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))].sort() : []; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested); } return value; }
