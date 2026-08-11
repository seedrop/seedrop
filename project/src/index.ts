export {
  WORK_PROJECTION_VERSION,
  PROJECT_PACKAGE_CONTRACT,
  PROJECT_PROJECTION_VERSION,
  PROJECT_STORE_LAYOUT_VERSION,
} from "./types.js";
export type {
  EpisodeProjectionRecord,
  IntentProjectionRecord,
  LeaseProjectionRecord,
  ProjectArtifactDiagnostic,
  ProjectArtifactDiagnosticCode,
  ProjectCommitBoundary,
  ProjectCommitOptions,
  ProjectCommitReceipt,
  ProjectLag,
  ProjectLogScan,
  ProjectProjection,
  ProjectProjectionEntry,
  ProjectProjectionReference,
  ProjectPublishBoundary,
  ProjectPublishOptions,
  ProjectPublishReceipt,
  ProjectSourceArtifact,
  ProjectStoredTransaction,
  ProjectStoreLayout,
  ProjectTransactionReference,
  ProjectWriterLockOptions,
  WorkProjection,
  WorkReceiptProjectionRecord,
  WorkReceiptQuery,
} from "./types.js";

export {
  projectStoreLayout,
  projectTransactionRelativePath,
} from "./layout.js";

export {
  acquireProjectWriterLock,
  commitProjectTransaction,
} from "./commit.js";

export {
  activeLeaseForTarget,
  queryWorkReceipts,
  reduceWorkProjection,
} from "./work.js";

export type { HeldProjectWriterLock } from "./commit.js";

export {
  publishProjectTransaction,
  scanProjectTransactions,
} from "./store.js";

export {
  deleteProjectProjectionIndex,
  projectProjectionBytes,
  projectProjectionDigest,
  rebuildProjectProjection,
  reduceProjectTransactions,
} from "./projection.js";
