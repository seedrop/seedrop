import type { CanonicalId, ProjectTransactionDigest } from "@seedrop/protocol";

export const OUTCOME_PROJECTION_VERSION = "1.0.0" as const;
export const EVIDENCE_STATES = ["unverified", "passed", "failed", "stale", "unavailable"] as const;
export const DELIVERY_STATES = ["unobserved", "uncommitted", "committed", "review_open", "merged", "reverted", "superseded", "absent"] as const;
export type EvidenceState = typeof EVIDENCE_STATES[number];
export type DeliveryState = typeof DELIVERY_STATES[number];

export interface OutcomeObservationReference {
  event_id: CanonicalId<"event">;
  transaction_digest: ProjectTransactionDigest;
  observed_at: string;
  input_digest: ProjectTransactionDigest;
  build_identity: string | null;
  source_ref: string;
}

export interface SubjectOutcomeProjection {
  subject_id: CanonicalId;
  reported_lifecycle: string | null;
  evidence: EvidenceState;
  delivery: DeliveryState;
  validation_observation: OutcomeObservationReference | null;
  delivery_observation: OutcomeObservationReference | null;
  contradictions: readonly string[];
}

export interface OutcomeProjection {
  projection_version: typeof OUTCOME_PROJECTION_VERSION;
  source_digest: ProjectTransactionDigest;
  subjects: readonly SubjectOutcomeProjection[];
  observation_count: number;
  ignored_event_count: number;
}

export const GRAVE_PROJECTION_VERSION = "1.0.0" as const;
export const GRAVE_KINDS = ["failed", "blocked", "abandoned", "superseded", "unresolved"] as const;
export type GraveKind = typeof GRAVE_KINDS[number];

export interface GraveProjectionRecord {
  subject_id: CanonicalId;
  kind: GraveKind;
  goal: string | null;
  cause: string;
  scope: readonly string[];
  evidence_event_ids: readonly CanonicalId<"event">[];
  source_transaction_digests: readonly ProjectTransactionDigest[];
  source_refs: readonly string[];
  retry: { status: "ready" | "blocked" | "unknown"; condition: string };
  correction_event_ids: readonly CanonicalId<"event">[];
  completeness: { status: "complete" | "partial"; missing_fields: readonly string[] };
}

export interface GraveProjection {
  projection_version: typeof GRAVE_PROJECTION_VERSION;
  source_digest: ProjectTransactionDigest;
  graves: readonly GraveProjectionRecord[];
}
