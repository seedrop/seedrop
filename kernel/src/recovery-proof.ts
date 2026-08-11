import type { ProjectCommitBoundary, ProjectPublishBoundary } from "@seedrop/project";
import type { KernelExecutionBoundary } from "./types.js";

export type KernelAtomicRecoveryBoundary =
  | `kernel.${KernelExecutionBoundary}`
  | `project.${ProjectCommitBoundary}`
  | `publish.${ProjectPublishBoundary}`;

export type KernelProcessRestartVisibility = "none" | "whole";
export type KernelRestartAction = "execute" | "recover";
export type KernelPersistenceState =
  | "not_started"
  | "staging_only"
  | "published_unconfirmed"
  | "directory_synced";
export type KernelEffectRestartState =
  | "absent"
  | "declared_pending"
  | "delivery_may_have_completed";

export interface KernelAtomicRecoveryCase {
  boundary: KernelAtomicRecoveryBoundary;
  process_restart_visibility: KernelProcessRestartVisibility;
  restart_action: KernelRestartAction;
  persistence_state: KernelPersistenceState;
  effect_state: KernelEffectRestartState;
}

/**
 * The executable process-crash contract for one native command transaction.
 * `published_unconfirmed` is visible after an ordinary process restart but has not
 * crossed the containing-directory fsync boundary, so power-loss durability is not
 * claimed until `directory_synced`.
 */
export const KERNEL_ATOMIC_RECOVERY_MATRIX = Object.freeze([
  recoveryCase("kernel.before_authorization", "none", "execute", "not_started", "absent"),
  recoveryCase("kernel.after_validation", "none", "execute", "not_started", "absent"),
  recoveryCase("kernel.before_commit", "none", "execute", "not_started", "absent"),
  recoveryCase("project.after_lock_acquired", "none", "execute", "not_started", "absent"),
  recoveryCase("project.after_snapshot", "none", "execute", "not_started", "absent"),
  recoveryCase("publish.before_temp_write", "none", "execute", "staging_only", "absent"),
  recoveryCase("publish.after_temp_write", "none", "execute", "staging_only", "absent"),
  recoveryCase("publish.after_file_sync", "none", "execute", "staging_only", "absent"),
  recoveryCase("publish.after_publish", "whole", "recover", "published_unconfirmed", "declared_pending"),
  recoveryCase("publish.after_directory_sync", "whole", "recover", "directory_synced", "declared_pending"),
  recoveryCase("project.after_transaction_publish", "whole", "recover", "directory_synced", "declared_pending"),
  recoveryCase("project.after_projection", "whole", "recover", "directory_synced", "declared_pending"),
  recoveryCase("kernel.after_commit", "whole", "recover", "directory_synced", "declared_pending"),
  recoveryCase("kernel.before_effect", "whole", "recover", "directory_synced", "declared_pending"),
  recoveryCase("kernel.after_effect", "whole", "recover", "directory_synced", "delivery_may_have_completed"),
  recoveryCase("kernel.before_receipt", "whole", "recover", "directory_synced", "delivery_may_have_completed"),
] satisfies readonly KernelAtomicRecoveryCase[]);

function recoveryCase(
  boundary: KernelAtomicRecoveryBoundary,
  processRestartVisibility: KernelProcessRestartVisibility,
  restartAction: KernelRestartAction,
  persistenceState: KernelPersistenceState,
  effectState: KernelEffectRestartState,
): KernelAtomicRecoveryCase {
  return Object.freeze({
    boundary,
    process_restart_visibility: processRestartVisibility,
    restart_action: restartAction,
    persistence_state: persistenceState,
    effect_state: effectState,
  });
}
