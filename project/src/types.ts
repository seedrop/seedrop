import type {
  CanonicalId,
  ClaimRecord,
  EpisodeRecord,
  IntentRecord,
  JsonValue,
  HealthEnvelope,
  LeaseRecord,
  LifecycleState,
  ProjectTransaction,
  ProjectTransactionDigest,
  WorkReceipt,
} from "@seedrop/protocol";

export const PROJECT_STORE_LAYOUT_VERSION = "1.1.0" as const;
export const PROJECT_PROJECTION_VERSION = "1.0.0" as const;
export const WORK_PROJECTION_VERSION = "1.0.0" as const;

export const PROJECT_PACKAGE_CONTRACT = Object.freeze({
  schema_version: "1.1",
  package_name: "@seedrop/project",
  role: "project_record",
  owns: Object.freeze([
    "canonical_project_transactions",
    "project_receipts",
    "project_projections",
    "project_health_and_quarantine",
  ] as const),
  depends_on: Object.freeze(["@seedrop/protocol"] as const),
  excludes: Object.freeze([
    "adapter_policy",
    "command_authorization",
    "machine_coordination",
    "v1_writer_connection",
  ] as const),
} as const);

export interface ProjectTransactionReference {
  project_id: CanonicalId<"project">;
  command_id: CanonicalId<"command">;
  digest: ProjectTransactionDigest;
}

export interface ProjectProjectionReference {
  project_id: CanonicalId<"project">;
  projection_version: typeof PROJECT_PROJECTION_VERSION;
  source_high_watermark: ProjectTransactionDigest | null;
  source_digest: ProjectTransactionDigest;
}

export interface ProjectStoreLayout {
  layout_version: typeof PROJECT_STORE_LAYOUT_VERSION;
  root: string;
  transactions_dir: string;
  staging_dir: string;
  index_dir: string;
  projection_index: string;
  locks_dir: string;
  writer_lock: string;
}

export type ProjectPublishBoundary =
  | "before_temp_write"
  | "after_temp_write"
  | "after_file_sync"
  | "after_publish"
  | "after_directory_sync";

export interface ProjectPublishOptions {
  root: string;
  transaction: ProjectTransaction;
  fault?: (boundary: ProjectPublishBoundary) => void | Promise<void>;
  publication_guard?: () => void | Promise<void>;
}

export interface ProjectPublishReceipt {
  status: "published" | "already_present";
  project_id: CanonicalId<"project">;
  command_id: CanonicalId<"command">;
  digest: ProjectTransactionDigest;
  relative_path: string;
  byte_length: number;
}

export type ProjectCommitBoundary =
  | "after_lock_acquired"
  | "after_snapshot"
  | "after_transaction_publish"
  | "after_projection";

export interface ProjectWriterLockOptions {
  acquisition_timeout_ms?: number;
  stale_after_ms?: number;
  poll_interval_ms?: number;
}

export interface ProjectCommitOptions {
  root: string;
  transaction: ProjectTransaction;
  expected_high_watermark: ProjectTransactionDigest | null;
  lock?: ProjectWriterLockOptions;
  fault?: (boundary: ProjectCommitBoundary) => void | Promise<void>;
  publish_fault?: ProjectPublishOptions["fault"];
}

export interface ProjectCommitReceipt {
  status: "committed" | "already_committed";
  transaction: ProjectPublishReceipt;
  previous_high_watermark: ProjectTransactionDigest | null;
  projection: ProjectProjectionReference;
}

export type ProjectArtifactDiagnosticCode =
  | "unexpected_path"
  | "uncommitted_temp"
  | "read_failed"
  | "digest_mismatch"
  | "invalid_utf8"
  | "invalid_json"
  | "noncanonical_bytes"
  | "invalid_transaction"
  | "project_mismatch"
  | "duplicate_command"
  | "duplicate_event"
  | "multiple_roots"
  | "missing_predecessor"
  | "fork"
  | "cycle_or_no_root"
  | "unreachable_transaction";

export interface ProjectArtifactDiagnostic {
  code: ProjectArtifactDiagnosticCode;
  path: string;
  transaction_digest: ProjectTransactionDigest | null;
  details: Readonly<Record<string, JsonValue>>;
}

export interface ProjectSourceArtifact {
  path: string;
  expected_digest: ProjectTransactionDigest | null;
  actual_digest: ProjectTransactionDigest | null;
  status: "valid" | "quarantined";
}

export interface ProjectStoredTransaction {
  digest: ProjectTransactionDigest;
  relative_path: string;
  byte_length: number;
  transaction: ProjectTransaction;
}

export interface ProjectLogScan {
  project_id: CanonicalId<"project">;
  transactions: readonly ProjectStoredTransaction[];
  sources: readonly ProjectSourceArtifact[];
  diagnostics: readonly ProjectArtifactDiagnostic[];
}

export interface ProjectProjectionEntry {
  transaction_digest: ProjectTransactionDigest;
  command_id: CanonicalId<"command">;
  recorded_at: string;
  event_ids: readonly CanonicalId<"event">[];
}

export interface ProjectLag {
  committed_transactions: number;
  applied_transactions: number;
  unapplied_transactions: number;
  quarantined_artifacts: number;
  complete: boolean;
}

export interface ProjectProjection {
  projection_version: typeof PROJECT_PROJECTION_VERSION;
  project_id: CanonicalId<"project">;
  source_digest: ProjectTransactionDigest;
  source_high_watermark: ProjectTransactionDigest | null;
  transaction_count: number;
  event_count: number;
  applied: readonly ProjectProjectionEntry[];
  lag: ProjectLag;
  quarantined: readonly ProjectArtifactDiagnostic[];
}

export interface IntentProjectionRecord {
  record: IntentRecord;
  state: LifecycleState<"intent">;
  state_event_id: CanonicalId<"event">;
  correction_event_ids: readonly CanonicalId<"event">[];
}

export interface EpisodeProjectionRecord {
  record: EpisodeRecord;
  state: LifecycleState<"episode">;
  state_event_id: CanonicalId<"event">;
  correction_event_ids: readonly CanonicalId<"event">[];
}

export interface LeaseProjectionRecord {
  record: LeaseRecord;
  state: LifecycleState<"lease">;
  state_event_id: CanonicalId<"event">;
}

export interface WorkReceiptProjectionRecord {
  event_id: CanonicalId<"event">;
  transaction_digest: ProjectTransactionDigest;
  receipt: WorkReceipt;
}

export interface WorkProjection {
  projection_version: typeof WORK_PROJECTION_VERSION;
  project_id: CanonicalId<"project">;
  source_high_watermark: ProjectTransactionDigest | null;
  intents: readonly IntentProjectionRecord[];
  episodes: readonly EpisodeProjectionRecord[];
  claims: readonly ClaimRecord[];
  receipts: readonly WorkReceiptProjectionRecord[];
  leases: readonly LeaseProjectionRecord[];
}

export interface ImportedIntentProjectionRecord {
  intent_id: CanonicalId<"intent">;
  title: string;
  state: string;
  source_ref: string;
  observed_at: string;
  related_episode_ids: readonly CanonicalId<"episode">[];
}

export interface ImportedEpisodeProjectionRecord {
  episode_id: CanonicalId<"episode">;
  goal: string;
  state: string;
  source_ref: string;
  observed_at: string;
}

export interface ImportedOrientationProjection {
  projection_version: "1.0.0";
  project_id: CanonicalId<"project">;
  source_high_watermark: ProjectTransactionDigest | null;
  intents: readonly ImportedIntentProjectionRecord[];
  episodes: readonly ImportedEpisodeProjectionRecord[];
  ignored_event_count: number;
}

export interface WorkReceiptQuery {
  receipt_id?: CanonicalId<"receipt">;
  receipt_kind?: WorkReceipt["receipt_kind"];
  command_id?: CanonicalId<"command">;
  principal_id?: CanonicalId<"principal">;
  subject_id?: CanonicalId;
}

export type ProjectArtifactFamily = "transaction" | "staging" | "projection_index" | "writer_lock";

export interface ProjectArtifactEvidence {
  family: ProjectArtifactFamily;
  path: string;
  status: "valid" | "absent" | "quarantined";
  byte_length: number | null;
  expected_digest: ProjectTransactionDigest | null;
  actual_digest: ProjectTransactionDigest | null;
  code?: string;
  error_code?: string;
  repair?: string;
}

export interface ProjectSituationOptions {
  observed_at: string;
  requested_bytes?: number;
}

export interface ProjectSituation {
  project_id: CanonicalId<"project">;
  scan: ProjectLogScan;
  projection: ProjectProjection;
  artifacts: readonly ProjectArtifactEvidence[];
  health: HealthEnvelope;
}

export interface ProjectWorkReceiptQueryResult {
  complete: boolean;
  receipts: readonly WorkReceiptProjectionRecord[];
  artifacts: readonly ProjectArtifactEvidence[];
  health: HealthEnvelope;
}
