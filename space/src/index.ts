export { Space } from "./space.js";
export type { SpaceOptions, SpacePostInput, SpacePostResult } from "./space.js";
export { SpaceHttpClient, SpaceHttpClientError } from "./client.js";
export type {
  NotifyRequest,
  PostOutboxQueryState,
  PresenceAckRequest,
  PresenceQuery,
  SpaceHttpClientOptions,
  SpacePostRequest,
} from "./client.js";
export { SpaceStore } from "./io.js";
export type { AppendMessageOnceResult, SpaceStoreOptions, SpaceStorePaths } from "./io.js";
export { applyRootMigration, previewRootMigration, rollbackRootMigration } from "./root-migration.js";
export type {
  RootMigrationDirectory,
  RootMigrationEntry,
  RootMigrationManifest,
  RootMigrationOptions,
  RootMigrationReconciliation,
} from "./root-migration.js";
export { LiveStore } from "./live.js";
export type { LiveStoreOptions, LiveStorePaths } from "./live.js";
export { Mentions } from "./mentions.js";
export type {
  MentionAckInput,
  MentionAckResult,
  MentionInsertInput,
  MentionListInput,
  MentionRecord,
} from "./mentions.js";
export { PostOutbox } from "./post-outbox.js";
export type {
  DispatchPostOutboxInput,
  DispatchPostOutboxResult,
  PostOutboxFaultPhase,
  PostOutboxRecord,
  PostOutboxState,
  PreparePostOutboxInput,
} from "./post-outbox.js";
export { Presence } from "./presence.js";
export type {
  PresenceOptions,
  PresenceAcknowledgeInput,
  PresenceRegisterInput,
  PresenceHeartbeatInput,
  PresenceListInput,
  PresenceEndInput,
} from "./presence.js";
export { Notification } from "./notification.js";
export type {
  NotificationAckInput,
  NotificationListInput,
  NotificationOptions,
  NotificationSendInput,
} from "./notification.js";
export { createServer } from "./http.js";
export type { CreateServerOptions, HealthMetadata, HealthPassportMetadata, IdentityResolver, ResolvedIdentity } from "./http.js";
export {
  createPassportIdentityResolver,
  readPassportIdentity,
  resolvePrincipalChain,
  startSpaceServer,
} from "./serve.js";
export type {
  PassportIdentity,
  PassportIdentityResolverOptions,
  ServeOptions,
  StartedSpaceServer,
} from "./serve.js";
export {
  MessageRoleSchema,
  MessageSchema,
  HandoffSchema,
  NextActionSchema,
  PathPurposeSchema,
  PolicyPathPurposeSchema,
  NotificationPointerSchema,
  NotificationSchema,
  PresenceRecordSchema,
  RunJournalSchema,
  RunStepSchema,
  RunValidationEntrySchema,
  SessionSchema,
  SpaceLifecycleSchema,
  SpaceMemberSchema,
  SpaceMetaSchema,
  ViewPolicySchema,
  WorkspaceManifestSchema,
} from "./schema.js";
export type {
  Handoff,
  Message,
  MessageRole,
  NextAction,
  PathPurpose,
  PolicyPathPurpose,
  Notification as NotificationRecord,
  NotificationPointer,
  PresenceRecord,
  RunJournal,
  RunStep,
  RunValidationEntry,
  Session,
  SpaceLifecycle,
  SpaceMember,
  SpaceMeta,
  ViewPolicy,
  WorkspaceManifest,
} from "./schema.js";
export { SpaceAuthError, SpaceError, SpaceMentionDeliveryError, SpaceNotFoundError, SpaceParseError, SpacePostOutboxError, SpaceRequestBodyTooLargeError, SpaceRequestConflictError, SpaceValidationError } from "./errors.js";
export { WorkspaceView } from "./view.js";
export type {
  Grave,
  KnowledgeArtifact,
  LogInput,
  ReleaseSignalInput,
  RunFinishInput,
  RunStartInput,
  RunStartResult,
  RunUpdateInput,
  RunVerifyInput,
  SignalInput,
  SyncOptions,
  ViewAuditOptions,
  ViewBriefOptions,
  ViewPreflightOptions,
  WorkspaceViewOptions,
} from "./view.js";
export type {
  ArtifactDiagnostic,
  ArtifactFamily,
  ArtifactReadResult,
  AuditIssue,
  AuditReport,
  ContinuityPacket,
  ContinuityValidation,
  Task,
  TaskStatus,
  ViewBrief,
  ViewCheck,
  ViewPreflightReport,
  WorkspaceContext,
} from "./view.js";
