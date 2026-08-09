export {
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
} from "./canonical-json.js";
export type { JsonPrimitive, JsonValue } from "./canonical-json.js";

export {
  CANONICAL_ID_KINDS,
  CANONICAL_ID_KIND_CODES,
  MIN_ID_PREFIX_HEX_LENGTH,
  generateCanonicalId,
  isCanonicalId,
  parseCanonicalId,
  resolveCanonicalIdInput,
} from "./ids.js";
export type {
  CanonicalId,
  CanonicalIdKind,
  GenerateCanonicalIdOptions,
  ParsedCanonicalId,
} from "./ids.js";

export {
  ERROR_REGISTRY,
  ProtocolError,
  isProtocolError,
  protocolError,
  protocolErrorEnvelope,
} from "./errors.js";
export type {
  ProtocolErrorCategory,
  ProtocolErrorCode,
  ProtocolErrorDetails,
  ProtocolErrorEnvelope,
} from "./errors.js";

export {
  CURRENT_VERSION_ENVELOPE,
  CURRENT_VERSIONS,
  SUPPORTED_VERSIONS,
  VERSION_AXES,
  assertSupportedVersion,
  compareProtocolVersions,
  parseProtocolVersion,
  parseVersionEnvelope,
} from "./versions.js";
export type { ProtocolVersion, VersionAxis, VersionEnvelope } from "./versions.js";

export {
  PROTOCOL_ENVELOPE_MIGRATIONS,
  defineMigrationPlan,
  migrateToCurrent,
  migrationPlanMetadata,
  orderedMigrationPath,
  validateMigrationPlan,
} from "./migrations.js";

export {
  IDENTITY_REGISTRY_VERSION,
  PRINCIPAL_ALIAS_NAMESPACES,
  PROJECT_ALIAS_NAMESPACES,
  assertPrincipalRegistry,
  assertProjectRegistry,
  normalizeGitRemote,
  normalizePlacementPath,
  normalizePrincipalAlias,
  reconcilePrincipalCandidates,
  reconcileProjectCandidates,
  resolveCommandIdentities,
  resolvePrincipalIdentity,
  resolveProjectIdentity,
} from "./identity.js";

export {
  HEALTH_ENVELOPE_VERSION,
  SUBSTRATE_STATES,
  assertHealthEnvelope,
  buildHealthEnvelope,
} from "./health.js";
export type {
  BuildHealthEnvelopeInput,
  DisagreementClaim,
  GoverningPolicyTrace,
  GoverningRecordId,
  HealthBudget,
  HealthDisagreement,
  HealthEnvelope,
  HealthPolicyRef,
  HealthReason,
  HealthReasonCode,
  HealthSource,
  HealthSourceStatus,
  PendingCommandHealth,
  QuarantineRecord,
  StaleProjection,
  SubstrateState,
} from "./health.js";

export {
  COMMAND_AUDIT_VERSION,
  COMMAND_PHASES,
  SWEEP_CANDIDATE_VERSION,
  TERMINAL_COMMAND_PHASES,
  assertCommandAuditTrail,
  buildCommandAuditTrail,
  evaluateCommandInvariants,
  findCommandSweepCandidates,
  isTerminalCommandPhase,
} from "./commands.js";
export type {
  BuildCommandAuditTrailInput,
  CommandAuditEntry,
  CommandAuditError,
  CommandAuditTrail,
  CommandInvariantCode,
  CommandInvariantReport,
  CommandInvariantViolation,
  CommandPhase,
  CommandRecoveryPlan,
  CommandSweepPolicy,
  NonterminalCommandPhase,
  SweepCandidateEvent,
  TerminalCommandPhase,
} from "./commands.js";

export {
  REPAIR_RECEIPT_VERSION,
  assertRepairJournal,
  assertRepairReceipt,
  buildRepairReceipt,
  queryRepairReceipts,
} from "./repairs.js";
export type {
  BuildRepairReceiptInput,
  RepairCommandRef,
  RepairEvidenceRecordId,
  RepairEvidenceRef,
  RepairFailure,
  RepairJournalLink,
  RepairOutcome,
  RepairReceipt,
  RepairReceiptQuery,
  RepairRollback,
  RepairStateRef,
} from "./repairs.js";
export type {
  IdentityDiagnostic,
  IdentityInput,
  PrincipalAliasNamespace,
  PrincipalAliasRecord,
  PrincipalCandidate,
  PrincipalKind,
  PrincipalReconciliationResult,
  PrincipalRecord,
  PrincipalRegistry,
  ProjectAliasNamespace,
  ProjectAliasRecord,
  ProjectCandidate,
  ProjectPlacementKind,
  ProjectPlacementRecord,
  ProjectReconciliationResult,
  ProjectRecord,
  ProjectRegistry,
  ReconciliationOptions,
  RepositoryIdentityKind,
  ResolvedCommandIdentity,
} from "./identity.js";
export type {
  MigrationPlan,
  MigrationPlanMetadata,
  MigrationResult,
  MigrationStep,
  MigrationStepMetadata,
} from "./migrations.js";
