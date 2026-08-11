export {
  KERNEL_PACKAGE_CONTRACT,
} from "./types.js";
export type {
  KernelAuthorizationContext,
  KernelAuthorizationDecision,
  KernelAuthorizationOperation,
  KernelAuthorizer,
  KernelClock,
  KernelCommandContext,
  KernelCommandDefinition,
  KernelCommandExecutor,
  KernelCommandKind,
  KernelCommandOutcome,
  KernelCommandPlan,
  KernelCommandRequest,
  KernelEffectOutbox,
  KernelExecutionBoundary,
  KernelExecutorOptions,
  KernelIdFactory,
  KernelPlannedEffect,
  KernelPrincipalResolver,
  KernelRecoveryRequest,
  KernelResolvedPrincipal,
  NativeWorkClock,
  NativeWorkCommandOptions,
  NativeWorkIdFactory,
} from "./types.js";

export { createKernelCommandExecutor } from "./executor.js";
export { KERNEL_ATOMIC_RECOVERY_MATRIX } from "./recovery-proof.js";
export type {
  KernelAtomicRecoveryBoundary,
  KernelAtomicRecoveryCase,
  KernelEffectRestartState,
  KernelPersistenceState,
  KernelProcessRestartVisibility,
  KernelRestartAction,
} from "./recovery-proof.js";
export { createNativeWorkCommandDefinitions } from "./work.js";
export type {
  CorrectWorkPayload,
  ExpireLeasePayload,
  FinishWorkPayload,
  HandoffPayload,
  OpenWorkPayload,
} from "./work.js";
