export { Identity } from "./identity.js";
export type {
  CommitSessionOptions,
  CommitSessionResult,
  UpsertActiveProjectInput,
  UpsertActiveProjectOptions,
  UpsertActiveProjectResult,
} from "./identity.js";
export {
  CommitJournalRecordSchema,
  clearCommitJournal,
  commitPassportTransaction,
  createCommitJournalRecord,
  defaultCommitJournalPath,
  readCommitJournal,
  repairPendingCommit,
  writeCommitJournal,
} from "./commit-journal.js";
export type {
  CommitJournalRecord,
  CommitRepairOptions,
  CommitRepairResult,
  CommitRepairStatus,
  PassportCommitPhase,
  PassportTransactionOptions,
  PassportTransactionResult,
} from "./commit-journal.js";
export {
  canonicalJSON,
  hashPassport,
  appendAuditEntry,
  readAuditLog,
  reversePassportChange,
} from "./audit.js";
export type { AuditEntry, PassportChanges } from "./audit.js";
export { Session } from "./session.js";
export type {
  SessionOptions,
  RecordOptions,
  Router,
  HarvestOptions,
  HarvestResult,
} from "./session.js";
export type { Message, Role, Channel, RecordedMessage, SessionSlots } from "./types.js";
export {
  RuleClassifier,
  LLMClassifier,
  HybridClassifier,
} from "./classifier.js";
export type {
  Classifier,
  ClassifierKind,
  LLMClient,
  LLMConfig,
  LLMRequest,
  LLMResponse,
} from "./classifier.js";
export { OllamaEmbeddings } from "./embeddings.js";
export type { EmbeddingProvider, OllamaEmbeddingsOptions } from "./embeddings.js";
export { cosineSimilarity, cosineDistance, meanVector } from "./vectors.js";
export {
  ActiveProjectSchema,
  ContinuityStateSchema,
  CredentialRefSchema,
  PassportSchema,
  PassportSchemaV1,
  LearnedBlockSchema,
} from "./schema.js";
export type { ActiveProject, ContinuityState, CredentialRef, Passport, LearnedBlock } from "./schema.js";
export {
  PassportError,
  PassportNotFoundError,
  PassportParseError,
  PassportValidationError,
  IdentityConfigError,
  IdentityCommitRepairError,
  IdentityVersionConflictError,
  IdentityCommandConflictError,
  IdentityLockTimeoutError,
} from "./errors.js";
