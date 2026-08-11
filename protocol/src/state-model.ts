import { protocolError } from "./errors.js";
import { PROTOCOL_INVENTORY_CORE, TRUST_AXES } from "./inventory.js";

const LIFECYCLES = PROTOCOL_INVENTORY_CORE.lifecycles;

export const LIFECYCLE_NAMES = Object.freeze([
  "intent", "episode", "lease", "command",
] as const satisfies readonly (keyof typeof LIFECYCLES)[]);

export type LifecycleName = (typeof LIFECYCLE_NAMES)[number];
export type LifecycleState<N extends LifecycleName = LifecycleName> =
  (typeof LIFECYCLES)[N]["states"][number];
export type TrustAxisName = keyof typeof TRUST_AXES;
export type EvidenceState = (typeof TRUST_AXES.evidence)[number];
export type DeliveryState = (typeof TRUST_AXES.delivery)[number];
export type SubstrateTrustState = (typeof TRUST_AXES.substrate)[number];
export type ReadinessState = (typeof TRUST_AXES.readiness)[number];
export type ConfidenceState = (typeof TRUST_AXES.confidence)[number];

export interface OrthogonalTrustState {
  evidence: EvidenceState;
  delivery: DeliveryState;
  substrate: SubstrateTrustState;
  readiness: ReadinessState;
  confidence: ConfidenceState;
}

type CrossAxisName = "intent_lifecycle" | "episode_lifecycle" | TrustAxisName;

export interface ForbiddenCrossAxisImplication {
  id: string;
  antecedent: { axis: CrossAxisName; value: string };
  consequent: { axis: CrossAxisName; value: string };
  reason: string;
}

interface ObservedStateClassBase {
  id: number;
  trust: OrthogonalTrustState;
  interpretation: string;
}

export type ObservedStateClass = ObservedStateClassBase & (
  | { lifecycle: "intent"; lifecycle_state: LifecycleState<"intent"> }
  | { lifecycle: "episode"; lifecycle_state: LifecycleState<"episode"> }
);

export const FORBIDDEN_CROSS_AXIS_IMPLICATIONS = deepFreeze([
  implication("reported_complete_not_passed", "intent_lifecycle", "reported_complete", "evidence", "passed", "A completion report is not validation evidence."),
  implication("reported_complete_not_committed", "intent_lifecycle", "reported_complete", "delivery", "committed", "A completion report is not a delivery observation."),
  implication("passed_not_merged", "evidence", "passed", "delivery", "merged", "Passing evidence does not prove delivery."),
  implication("merged_not_passed", "delivery", "merged", "evidence", "passed", "Delivery does not prove applicable validation."),
  implication("healthy_not_ready", "substrate", "healthy", "readiness", "ready", "Healthy substrate does not prove handoff readiness."),
  implication("ready_not_merged", "readiness", "ready", "delivery", "merged", "Readiness does not prove delivery."),
  implication("unknown_not_absent", "confidence", "unknown", "delivery", "absent", "Unknown evidence cannot be promoted to observed absence."),
  implication("unreachable_not_unavailable", "substrate", "unreachable", "evidence", "unavailable", "An unreachable substrate does not erase independently retained evidence."),
] as const);

export const OBSERVED_STATE_CLASSES = deepFreeze([
  observed(1, "intent", "reported_complete", "passed", "uncommitted", "healthy", "resumable_with_risk", "observed", "Reported and validated locally, but not delivered."),
  observed(2, "intent", "reported_complete", "unverified", "unobserved", "healthy", "resumable_with_risk", "observed", "Report preserved while evidence and delivery remain unknown."),
  observed(3, "intent", "reported_complete", "stale", "committed", "healthy", "resumable_with_risk", "observed", "Commit exists while validation no longer covers current inputs."),
  observed(4, "intent", "reported_complete", "passed", "merged", "healthy", "ready", "observed", "Strong delivery state still cites independent Receipts."),
  observed(5, "intent", "reported_complete", "passed", "reverted", "healthy", "not_ready", "observed", "Historical delivery was undone."),
  observed(6, "intent", "reported_complete", "passed", "superseded", "healthy", "not_ready", "observed", "Work survives only as superseded history."),
  observed(7, "intent", "reported_complete", "unavailable", "unobserved", "unreachable", "resumable_with_risk", "unknown", "Coordination outage preserves local report without delivery claims."),
  observed(8, "episode", "active", "failed", "uncommitted", "degraded", "not_ready", "observed", "Ongoing work has failing validation and local changes."),
  observed(9, "intent", "blocked", "passed", "review_open", "healthy", "resumable_with_risk", "observed", "Validation and review do not clear an explicit blocker."),
  observed(10, "episode", "failed", "failed", "absent", "healthy", "not_ready", "observed", "Failed attempt remains negative continuity evidence."),
  observed(11, "intent", "abandoned", "unverified", "not_applicable", "healthy", "not_ready", "observed", "Conscious negative knowledge is retained."),
  observed(12, "intent", "queued", "unavailable", "not_applicable", "corrupt", "not_ready", "unknown", "Corruption blocks confident orientation without erasing Intent."),
  observed(13, "episode", "active", "passed", "uncommitted", "migrating", "resumable_with_risk", "observed", "Work facts survive while migration prevents unsafe writes."),
  observed(14, "intent", "reported_complete", "passed", "absent", "healthy", "not_ready", "observed", "Report and validation coexist with observed absence."),
] as const satisfies readonly ObservedStateClass[]);

export function isLifecycleState<N extends LifecycleName>(
  lifecycle: N,
  value: unknown,
): value is LifecycleState<N> {
  if (!(LIFECYCLE_NAMES as readonly unknown[]).includes(lifecycle)) return false;
  return typeof value === "string" && (LIFECYCLES[lifecycle].states as readonly string[]).includes(value);
}

export function canLifecycleTransition(
  lifecycle: LifecycleName,
  from: string,
  to: string,
): boolean {
  if (!(LIFECYCLE_NAMES as readonly unknown[]).includes(lifecycle)) return false;
  if (!isLifecycleState(lifecycle, from) || !isLifecycleState(lifecycle, to)) return false;
  const transitions = LIFECYCLES[lifecycle].transitions as Readonly<Record<string, readonly string[]>>;
  return transitions[from]?.includes(to) ?? false;
}

export function assertLifecycleTransition(
  lifecycle: LifecycleName,
  from: string,
  to: string,
): void {
  if (!(LIFECYCLE_NAMES as readonly unknown[]).includes(lifecycle)) {
    throw protocolError("seedrop.protocol.lifecycle_state_unknown", { lifecycle, state: null });
  }
  if (!isLifecycleState(lifecycle, from)) {
    throw protocolError("seedrop.protocol.lifecycle_state_unknown", { lifecycle, state: from });
  }
  if (!isLifecycleState(lifecycle, to)) {
    throw protocolError("seedrop.protocol.lifecycle_state_unknown", { lifecycle, state: to });
  }
  if (!canLifecycleTransition(lifecycle, from, to)) {
    throw protocolError("seedrop.protocol.lifecycle_transition_invalid", { lifecycle, from, to });
  }
}

export function buildOrthogonalTrustState(input: unknown): OrthogonalTrustState {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidTrust(null, null, "object_required");
  const record = input as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) invalidTrust(null, null, "plain_object_required");
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string")) invalidTrust(null, null, "string_axes_required");
  if (Object.values(Object.getOwnPropertyDescriptors(record)).some((descriptor) => descriptor.get || descriptor.set)) {
    invalidTrust(null, null, "data_properties_required");
  }
  const expected = Object.keys(TRUST_AXES);
  const actual = Object.keys(record);
  const unknown = actual.filter((key) => !expected.includes(key)).sort();
  const missing = expected.filter((key) => !actual.includes(key)).sort();
  if (unknown.length > 0 || missing.length > 0) {
    throw protocolError("seedrop.protocol.trust_state_invalid", {
      axis: null,
      value: null,
      reason: "exact_axes_required",
      unknown_axes: unknown.join(","),
      missing_axes: missing.join(","),
    });
  }
  for (const axis of expected as TrustAxisName[]) {
    if (!(TRUST_AXES[axis] as readonly unknown[]).includes(record[axis])) {
      invalidTrust(axis, record[axis], "unknown_value");
    }
  }
  return Object.freeze({
    evidence: record.evidence as EvidenceState,
    delivery: record.delivery as DeliveryState,
    substrate: record.substrate as SubstrateTrustState,
    readiness: record.readiness as ReadinessState,
    confidence: record.confidence as ConfidenceState,
  });
}

function implication(
  id: string,
  antecedentAxis: CrossAxisName,
  antecedentValue: string,
  consequentAxis: CrossAxisName,
  consequentValue: string,
  reason: string,
): ForbiddenCrossAxisImplication {
  return {
    id,
    antecedent: { axis: antecedentAxis, value: antecedentValue },
    consequent: { axis: consequentAxis, value: consequentValue },
    reason,
  };
}

function observed<N extends "intent" | "episode">(
  id: number,
  lifecycle: N,
  lifecycle_state: LifecycleState<N>,
  evidence: EvidenceState,
  delivery: DeliveryState,
  substrate: SubstrateTrustState,
  readiness: ReadinessState,
  confidence: ConfidenceState,
  interpretation: string,
): ObservedStateClass {
  return {
    id,
    lifecycle,
    lifecycle_state,
    trust: { evidence, delivery, substrate, readiness, confidence },
    interpretation,
  } as ObservedStateClass;
}

function invalidTrust(axis: string | null, value: unknown, reason: string): never {
  throw protocolError("seedrop.protocol.trust_state_invalid", {
    axis,
    value: typeof value === "string" ? value : null,
    reason,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
