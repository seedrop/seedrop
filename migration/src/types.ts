import type { ProjectProjectionReference } from "@seedrop/project";
import type { ProjectTransactionDigest } from "@seedrop/protocol";

export const SHADOW_MIGRATION_CONTRACT_VERSION = "1.0.0" as const;

export const SHADOW_MIGRATION_STATES = Object.freeze([
  "preview",
  "source_snapshot_verified",
  "staged",
  "verified_not_authorized_for_cutover",
] as const);

export type ShadowMigrationState = (typeof SHADOW_MIGRATION_STATES)[number];

export const MIGRATION_SOURCE_KINDS = Object.freeze([
  "identity",
  "view",
  "coordination",
  "machine_state",
] as const);

export type MigrationSourceKind = (typeof MIGRATION_SOURCE_KINDS)[number];

export interface MigrationSourceSummary {
  source_ref: string;
  source_kind: MigrationSourceKind;
  source_digest: ProjectTransactionDigest;
  file_count: number;
  byte_count: number;
  record_count: number;
}

export interface MigrationCorpusCounts {
  sources: number;
  files: number;
  bytes: number;
  records: number;
}

export interface MigrationCorpus {
  corpus_digest: ProjectTransactionDigest;
  sources: readonly MigrationSourceSummary[];
  counts: MigrationCorpusCounts;
}

export interface MigrationReconciliation {
  source_records: number;
  imported_records: number;
  quarantined_records: number;
  unresolved_records: number;
}

interface ShadowMigrationReceiptBase {
  contract_version: typeof SHADOW_MIGRATION_CONTRACT_VERSION;
  migration_id: string;
  corpus: MigrationCorpus;
  issued_at: string;
}

export interface PreviewMigrationReceipt extends ShadowMigrationReceiptBase {
  state: "preview";
  snapshot_receipt_digest: null;
  staged_projects: readonly [];
  reconciliation: null;
}

export interface SnapshotVerifiedMigrationReceipt extends ShadowMigrationReceiptBase {
  state: "source_snapshot_verified";
  snapshot_receipt_digest: ProjectTransactionDigest;
  staged_projects: readonly [];
  reconciliation: null;
}

export interface StagedMigrationReceipt extends ShadowMigrationReceiptBase {
  state: "staged";
  snapshot_receipt_digest: ProjectTransactionDigest;
  staged_projects: readonly ProjectProjectionReference[];
  reconciliation: null;
}

export interface VerifiedShadowMigrationReceipt extends ShadowMigrationReceiptBase {
  state: "verified_not_authorized_for_cutover";
  snapshot_receipt_digest: ProjectTransactionDigest;
  staged_projects: readonly ProjectProjectionReference[];
  reconciliation: MigrationReconciliation;
}

export type ShadowMigrationReceipt =
  | PreviewMigrationReceipt
  | SnapshotVerifiedMigrationReceipt
  | StagedMigrationReceipt
  | VerifiedShadowMigrationReceipt;

export type ShadowMigrationNextAction =
  | "verify_source_snapshot"
  | "stage_shadow_import"
  | "verify_reconciliation"
  | "stop_no_cutover_authority";

export type MigrationContractErrorCode =
  | "invalid_contract"
  | "invalid_transition"
  | "source_changed";

export const MIGRATION_PACKAGE_CONTRACT = Object.freeze({
  schema_version: "1.0",
  package_name: "@seedrop/migration",
  role: "shadow_migration",
  owns: Object.freeze([
    "v1_read_only_source_admission",
    "source_snapshot_binding",
    "staged_shadow_import",
    "migration_reconciliation",
  ] as const),
  depends_on: Object.freeze(["@seedrop/project", "@seedrop/protocol"] as const),
  excludes: Object.freeze([
    "v1_source_mutation",
    "cutover_authority",
    "adapter_policy",
    "custom_database",
  ] as const),
  terminal_state: "verified_not_authorized_for_cutover",
} as const);
