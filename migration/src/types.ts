import type { ProjectProjectionReference } from "@seedrop/project";
import type {
  CanonicalId,
  IdentityDiagnostic,
  JsonValue,
  PrincipalRegistry,
  ProjectRegistry,
  ProjectTransaction,
  ProjectTransactionDigest,
} from "@seedrop/protocol";

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

export const IDENTITY_IMPORT_VERSION = "1.0.0" as const;

export interface IdentityImportCounts {
  principal_sources: number;
  project_sources: number;
  canonical_principals: number;
  canonical_projects: number;
  unique_project_placements: number;
  unresolved_project_sources: number;
}

export interface IdentityImportReceipt {
  import_version: typeof IDENTITY_IMPORT_VERSION;
  corpus_digest: ProjectTransactionDigest;
  principal_registry_digest: ProjectTransactionDigest;
  project_registry_digest: ProjectTransactionDigest;
  source_mapping_digest: ProjectTransactionDigest;
  counts: IdentityImportCounts;
  unresolved_project_sources: readonly string[];
  principal_diagnostics: readonly IdentityDiagnostic[];
  project_diagnostics: readonly IdentityDiagnostic[];
}

export interface IdentityImportResult {
  receipt: IdentityImportReceipt;
  principal_registry: PrincipalRegistry;
  project_registry: ProjectRegistry;
  source_to_principal: Readonly<Record<string, CanonicalId<"principal">>>;
  source_to_project: Readonly<Record<string, CanonicalId<"project">>>;
}

export interface LiveIdentityCollection {
  corpus: MigrationCorpus;
  principals: readonly import("@seedrop/protocol").PrincipalCandidate[];
  projects: readonly import("@seedrop/protocol").ProjectCandidate[];
  passport_file_count: number;
  project_link_count: number;
}

export const VIEW_HISTORY_IMPORT_VERSION = "1.0.0" as const;

export const VIEW_SOURCE_FAMILIES = Object.freeze([
  "task",
  "run",
  "continuity",
  "signal",
  "delivery_observation",
] as const);

export type ViewSourceFamily = (typeof VIEW_SOURCE_FAMILIES)[number];

export const VIEW_SOURCE_DISPOSITIONS = Object.freeze([
  "imported",
  "quarantined",
  "unresolved",
] as const);

export type ViewSourceDisposition = (typeof VIEW_SOURCE_DISPOSITIONS)[number];

export const VIEW_SOURCE_DIAGNOSTIC_CODES = Object.freeze([
  "invalid_json",
  "schema_validation",
  "source_container_invalid",
  "principal_unresolved",
  "task_blocker_missing",
  "related_run_missing",
  "continuity_run_link_absent",
  "delivery_run_missing",
] as const);

export type ViewSourceDiagnosticCode = (typeof VIEW_SOURCE_DIAGNOSTIC_CODES)[number];

export interface ViewSourceDiagnostic {
  code: ViewSourceDiagnosticCode;
  reason: string;
}

export interface ViewSourceRecord {
  source_ref: string;
  source_family: ViewSourceFamily;
  source_digest: ProjectTransactionDigest;
  source_payload: JsonValue | null;
  diagnostics: readonly ViewSourceDiagnostic[];
}

export interface ViewHistoryCollection {
  corpus: MigrationCorpus;
  source_tree_digest: ProjectTransactionDigest;
  records: readonly ViewSourceRecord[];
}

export interface ViewImportRecordReceipt {
  source_ref: string;
  source_family: ViewSourceFamily;
  source_digest: ProjectTransactionDigest;
  disposition: ViewSourceDisposition;
  diagnostic_codes: readonly ViewSourceDiagnosticCode[];
  transaction_digest: ProjectTransactionDigest;
}

export interface ViewHistoryImportCounts {
  source_records: number;
  imported_records: number;
  quarantined_records: number;
  unresolved_records: number;
  transactions: number;
  events: number;
}

export interface ViewHistoryImportReceipt {
  import_version: typeof VIEW_HISTORY_IMPORT_VERSION;
  corpus_digest: ProjectTransactionDigest;
  source_tree_digest: ProjectTransactionDigest;
  project_id: CanonicalId<"project">;
  migration_principal_id: CanonicalId<"principal">;
  transaction_chain_digest: ProjectTransactionDigest;
  record_mapping_digest: ProjectTransactionDigest;
  counts: ViewHistoryImportCounts;
}

export interface ViewHistoryImportResult {
  receipt: ViewHistoryImportReceipt;
  records: readonly ViewImportRecordReceipt[];
  transactions: readonly ProjectTransaction[];
}

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
  depends_on: Object.freeze(["@seedrop/id", "@seedrop/project", "@seedrop/protocol", "@seedrop/space"] as const),
  excludes: Object.freeze([
    "v1_source_mutation",
    "cutover_authority",
    "adapter_policy",
    "custom_database",
  ] as const),
  terminal_state: "verified_not_authorized_for_cutover",
} as const);
