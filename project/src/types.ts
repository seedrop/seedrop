import type {
  CanonicalId,
  JsonValue,
  ProjectTransaction,
  ProjectTransactionDigest,
} from "@seedrop/protocol";

export const PROJECT_STORE_LAYOUT_VERSION = "1.0.0" as const;
export const PROJECT_PROJECTION_VERSION = "1.0.0" as const;

export const PROJECT_PACKAGE_CONTRACT = Object.freeze({
  schema_version: "1.0",
  package_name: "@seedrop/project",
  role: "project_record",
  owns: Object.freeze([
    "canonical_project_transactions",
    "project_receipts",
    "project_projections",
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
}

export interface ProjectPublishReceipt {
  status: "published" | "already_present";
  project_id: CanonicalId<"project">;
  command_id: CanonicalId<"command">;
  digest: ProjectTransactionDigest;
  relative_path: string;
  byte_length: number;
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
