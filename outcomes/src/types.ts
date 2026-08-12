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
