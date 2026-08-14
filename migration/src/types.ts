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
  | "source_changed"
  | "checkpoint_corrupt"
  | "checkpoint_conflict";

export const MIGRATION_EXECUTOR_VERSION = "1.0.0" as const;

export const MIGRATION_EXECUTION_PHASES = Object.freeze([
  "verify_source_snapshot",
  "stage_shadow_import",
  "verify_reconciliation",
  "complete",
] as const);

export type MigrationExecutionPhase = (typeof MIGRATION_EXECUTION_PHASES)[number];

export const MIGRATION_EXECUTION_FAULT_BOUNDARIES = Object.freeze([
  "before_preview_commit",
  "after_preview_commit",
  "before_snapshot_source",
  "after_snapshot_source",
  "after_snapshot_checkpoint",
  "before_snapshot_commit",
  "after_snapshot_commit",
  "before_stage_source",
  "after_stage_source",
  "after_stage_checkpoint",
  "before_stage_commit",
  "after_stage_commit",
  "before_verify_source",
  "after_verify_source",
  "after_verify_checkpoint",
  "before_terminal_commit",
  "after_terminal_commit",
] as const);

export type MigrationExecutionFaultBoundary = (typeof MIGRATION_EXECUTION_FAULT_BOUNDARIES)[number];

export interface MigrationExecutionCursor {
  phase: MigrationExecutionPhase;
  next_source_index: number;
}

export interface MigrationSnapshotSourceReceipt {
  source_ref: string;
  source_digest: ProjectTransactionDigest;
}

export interface MigrationStagedSourceReceipt extends MigrationSnapshotSourceReceipt {
  idempotency_key: ProjectTransactionDigest;
  staged_projects: readonly ProjectProjectionReference[];
  reconciliation: MigrationReconciliation;
}

export interface MigrationVerifiedSourceReceipt extends MigrationSnapshotSourceReceipt {
  idempotency_key: ProjectTransactionDigest;
  reconciliation: MigrationReconciliation;
}

export interface MigrationExecutionCheckpoint {
  executor_version: typeof MIGRATION_EXECUTOR_VERSION;
  migration_id: string;
  admitted_corpus: MigrationCorpus;
  receipt: ShadowMigrationReceipt;
  cursor: MigrationExecutionCursor;
  snapshot_sources: readonly MigrationSnapshotSourceReceipt[];
  staged_sources: readonly MigrationStagedSourceReceipt[];
  verified_sources: readonly MigrationVerifiedSourceReceipt[];
  revision: number;
  previous_checkpoint_digest: ProjectTransactionDigest | null;
  checkpoint_digest: ProjectTransactionDigest;
}

export interface MigrationSourceExecutionContext {
  migration_id: string;
  source: MigrationSourceSummary;
  source_index: number;
  idempotency_key: ProjectTransactionDigest;
}

export interface MigrationStageSourceResult {
  staged_projects: readonly ProjectProjectionReference[];
  reconciliation: MigrationReconciliation;
}

export interface MigrationVerifySourceResult {
  reconciliation: MigrationReconciliation;
}

export const COMPATIBILITY_VERSION = "1.0.0" as const;

export const COMPATIBILITY_DISPOSITIONS = Object.freeze([
  "equal",
  "intentionally_transformed",
  "quarantined",
  "unresolved",
] as const);

export type CompatibilityDisposition = (typeof COMPATIBILITY_DISPOSITIONS)[number];

export interface CompatibilityDifference {
  source_ref: string;
  source_family: ViewSourceFamily;
  source_digest: ProjectTransactionDigest;
  disposition: CompatibilityDisposition;
  reason_code: string;
  v1_semantic_digest: ProjectTransactionDigest;
  v2_semantic_digest: ProjectTransactionDigest | null;
}

export interface CompatibilityProjectionReceipt {
  compatibility_version: typeof COMPATIBILITY_VERSION;
  source_tree_digest: ProjectTransactionDigest;
  transaction_chain_digest: ProjectTransactionDigest;
  comparison_digest: ProjectTransactionDigest;
  counts: {
    source_records: number;
    equal_records: number;
    intentionally_transformed_records: number;
    quarantined_records: number;
    unresolved_records: number;
  };
}

export interface CompatibilityProjectionResult {
  receipt: CompatibilityProjectionReceipt;
  differences: readonly CompatibilityDifference[];
}

export const V1_TRANSLATOR_DISPOSITIONS = Object.freeze([
  "translated",
  "intentionally_unsupported",
  "unresolved",
] as const);

export type V1TranslatorDisposition = (typeof V1_TRANSLATOR_DISPOSITIONS)[number];

export interface V1CommandInput {
  source_ref: string;
  command_name: string;
  args: JsonValue;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  expected_state_version: ProjectTransactionDigest | null;
}

export interface V1DryRunCommandDraft {
  compatibility_version: typeof COMPATIBILITY_VERSION;
  source_ref: string;
  source_digest: ProjectTransactionDigest;
  disposition: V1TranslatorDisposition;
  reason_code: string;
  submit_capability: false;
  command: {
    command_id: CanonicalId<"command">;
    command_version: "1.0.0";
    command_name: string;
    principal_id: CanonicalId<"principal">;
    project_id: CanonicalId<"project">;
    idempotency_key: string;
    expected_state_version: ProjectTransactionDigest | null;
    payload: JsonValue;
  } | null;
}

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

export const COORDINATION_RECONCILIATION_VERSION = "1.0.0" as const;

export const COORDINATION_SOURCE_FAMILIES = Object.freeze([
  "space",
  "membership",
  "message",
  "notification",
  "mention",
  "outbox",
  "session",
  "session_cache",
  "root_migration",
  "unknown_sqlite_record",
] as const);

export type CoordinationSourceFamily = (typeof COORDINATION_SOURCE_FAMILIES)[number];

export const COORDINATION_AUTHORITY_CLASSES = Object.freeze([
  "durable_authority",
  "ttl_projection",
  "client_cache",
  "migration_evidence",
] as const);

export type CoordinationAuthorityClass = (typeof COORDINATION_AUTHORITY_CLASSES)[number];

export const COORDINATION_DISPOSITIONS = Object.freeze([
  "imported",
  "quarantined",
  "unresolved",
] as const);

export type CoordinationDisposition = (typeof COORDINATION_DISPOSITIONS)[number];

export const COORDINATION_DIAGNOSTIC_CODES = Object.freeze([
  "invalid_json",
  "schema_validation",
  "sqlite_unreadable",
  "unsupported_sqlite_table",
  "principal_unresolved",
  "space_unresolved",
  "message_unresolved",
  "replacement_unresolved",
  "notification_pointer_unresolved",
  "root_backup_mismatch",
  "root_canonical_incomplete",
  "root_legacy_mismatch",
] as const);

export type CoordinationDiagnosticCode = (typeof COORDINATION_DIAGNOSTIC_CODES)[number];

export interface CoordinationDiagnostic {
  code: CoordinationDiagnosticCode;
  reason: string;
}

export interface CoordinationSourceRecord {
  source_ref: string;
  source_family: CoordinationSourceFamily;
  authority_class: CoordinationAuthorityClass;
  source_digest: ProjectTransactionDigest;
  source_payload: JsonValue | null;
  diagnostics: readonly CoordinationDiagnostic[];
}

export interface MachineCoordinationCollection {
  corpus: MigrationCorpus;
  source_tree_digest: ProjectTransactionDigest;
  physical_file_count: number;
  physical_byte_count: number;
  records: readonly CoordinationSourceRecord[];
}

export interface CoordinationShadowRecord {
  source_ref: string;
  source_family: CoordinationSourceFamily;
  authority_class: CoordinationAuthorityClass;
  source_digest: ProjectTransactionDigest;
  disposition: CoordinationDisposition;
  mapped_principal_ids: readonly CanonicalId<"principal">[];
  diagnostics: readonly CoordinationDiagnostic[];
  projection: JsonValue;
}

export interface CoordinationDispositionCounts {
  source_records: number;
  imported_records: number;
  quarantined_records: number;
  unresolved_records: number;
}

export interface CoordinationFamilyCounts extends CoordinationDispositionCounts {
  source_family: CoordinationSourceFamily;
}

export interface CoordinationAuthorityCounts extends CoordinationDispositionCounts {
  authority_class: CoordinationAuthorityClass;
}

export interface MachineCoordinationReconciliationReceipt {
  reconciliation_version: typeof COORDINATION_RECONCILIATION_VERSION;
  corpus_digest: ProjectTransactionDigest;
  source_tree_digest: ProjectTransactionDigest;
  principal_registry_digest: ProjectTransactionDigest;
  record_mapping_digest: ProjectTransactionDigest;
  snapshot_at: string;
  ttl_seconds: number;
  counts: CoordinationDispositionCounts;
  family_counts: readonly CoordinationFamilyCounts[];
  authority_counts: readonly CoordinationAuthorityCounts[];
  presence: {
    sessions: number;
    online: number;
    offline: number;
  };
  root_migrations: {
    manifests: number;
    applied: number;
    rolled_back: number;
  };
}

export interface MachineCoordinationReconciliationResult {
  receipt: MachineCoordinationReconciliationReceipt;
  records: readonly CoordinationShadowRecord[];
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
    "v1_edge_compatibility",
    "dry_run_command_translation",
  ] as const),
  depends_on: Object.freeze([
    "@seedrop/id",
    "@seedrop/outcomes",
    "@seedrop/project",
    "@seedrop/protocol",
    "@seedrop/situation",
    "@seedrop/space",
  ] as const),
  excludes: Object.freeze([
    "v1_source_mutation",
    "cutover_authority",
    "adapter_policy",
    "custom_database",
    "command_submission",
  ] as const),
  terminal_state: "verified_not_authorized_for_cutover",
} as const);
