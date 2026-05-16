export { Space } from "./space.js";
export type { SpaceOptions, SpacePostInput } from "./space.js";
export { SpaceHttpClient, SpaceHttpClientError } from "./client.js";
export type {
  NotifyRequest,
  PresenceQuery,
  SpaceHttpClientOptions,
  SpacePostRequest,
} from "./client.js";
export { SpaceStore } from "./io.js";
export type { SpaceStoreOptions, SpaceStorePaths } from "./io.js";
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
export { Presence } from "./presence.js";
export type {
  PresenceOptions,
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
} from "./schema.js";
export type {
  Handoff,
  Message,
  MessageRole,
  NextAction,
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
} from "./schema.js";
export { SpaceAuthError, SpaceError, SpaceMentionDeliveryError, SpaceNotFoundError, SpaceParseError, SpaceValidationError } from "./errors.js";
export { WorkspaceView } from "./view.js";
export type {
  HandoffCreateInput,
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
  AuditIssue,
  AuditReport,
  ViewBrief,
  ViewCheck,
  ViewPreflightReport,
  WorkspaceContext,
} from "./view.js";
