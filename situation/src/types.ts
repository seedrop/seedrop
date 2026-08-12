import type { GraveProjection, OutcomeProjection, SourceInvalidationProjection } from "@seedrop/outcomes";
import type { ProjectProjection, WorkProjection } from "@seedrop/project";
import type { CanonicalId, HealthEnvelope, ProjectTransactionDigest } from "@seedrop/protocol";

export const SITUATION_PROJECTION_VERSION = "1.0.0" as const;
export type SituationFreshness = "current" | "stale" | "unavailable";
export type SituationCompleteness = "complete" | "partial" | "unavailable";

export interface SituationSourceReference {
  source_id: string;
  source_digest: ProjectTransactionDigest;
  observed_at: string;
  freshness: SituationFreshness;
  completeness: SituationCompleteness;
}

export interface SituationReadPort<T> extends SituationSourceReference {
  value: T | null;
  missing: readonly string[];
}

export interface SituatedField<T> {
  value: T;
  provenance: readonly SituationSourceReference[];
  freshness: SituationFreshness;
  completeness: SituationCompleteness;
  missing: readonly string[];
}

export interface SituationProjectReadModel {
  projection: ProjectProjection;
  work: WorkProjection;
  health: HealthEnvelope;
}

export interface SituationIdentityReadModel {
  principal_id: CanonicalId<"principal"> | null;
  display_name: string | null;
  status: "resolved" | "ambiguous" | "unknown";
  candidates: readonly CanonicalId<"principal">[];
}

export interface SituationCoordinationReadModel {
  status: "available" | "partial" | "unavailable";
  active_claims: readonly string[];
  inbox_unacked: number;
}

export interface SituationIntent {
  intent_id: CanonicalId<"intent">;
  title: string;
  state: string;
  episode_id: CanonicalId<"episode"> | null;
  goal: string | null;
}

export interface SituationDelivery {
  subject_id: CanonicalId;
  reported_lifecycle: string | null;
  evidence: string;
  delivery: string;
  contradictions: readonly string[];
}

export interface SituationGrave {
  subject_id: CanonicalId;
  kind: string;
  cause: string;
  retry_status: string;
  retry_condition: string;
  completeness: SituationCompleteness;
}

export interface SituationRisk {
  code: string;
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
  source_ids: readonly string[];
}

export interface SituationSourceHealth {
  substrate: string;
  degraded_source_ids: readonly string[];
  quarantine_count: number;
  unresolved_disagreement_count: number;
}

export interface SituationRecommendation {
  disposition: "recommend";
  action: string;
  reason: string;
  command: string | null;
  restrictions: readonly string[];
  evidence_source_ids: readonly string[];
}

export interface SituationRefusal {
  disposition: "refuse";
  reason: string;
  blocking_unknowns: readonly string[];
  evidence_requests: readonly string[];
  smallest_repair: string;
  evidence_source_ids: readonly string[];
}

export type SituationDecision = SituationRecommendation | SituationRefusal;

export interface SituationProjection {
  projection_version: typeof SITUATION_PROJECTION_VERSION;
  generated_at: string;
  situation_id: ProjectTransactionDigest;
  decision_id: ProjectTransactionDigest;
  source_digest: ProjectTransactionDigest;
  identity: SituatedField<SituationIdentityReadModel | null>;
  coordination: SituatedField<SituationCoordinationReadModel | null>;
  intent: SituatedField<SituationIntent | null>;
  risk: SituatedField<readonly SituationRisk[]>;
  delivery: SituatedField<SituationDelivery | null>;
  grave: SituatedField<SituationGrave | null>;
  source_health: SituatedField<SituationSourceHealth | null>;
  next_action: SituatedField<SituationDecision>;
}

export interface CompileSituationInput {
  generated_at: string;
  project: SituationReadPort<SituationProjectReadModel>;
  outcomes: SituationReadPort<OutcomeProjection>;
  graves: SituationReadPort<GraveProjection>;
  identity: SituationReadPort<SituationIdentityReadModel>;
  coordination: SituationReadPort<SituationCoordinationReadModel>;
  invalidation: SituationReadPort<SourceInvalidationProjection>;
}
