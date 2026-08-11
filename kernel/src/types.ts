import type {
  BuildProjectEventInput,
  CanonicalId,
  CommandAuditTrail,
  CommandCommitReceipt,
  JsonValue,
  OutboxDeliveryReceipt,
  OutboxEffect,
  ProjectTransaction,
  ProjectTransactionDigest,
  ProtocolVersion,
  RepairReceipt,
} from "@seedrop/protocol";
import type {
  ProjectLogScan,
  ProjectCommitOptions,
  ProjectProjection,
  ProjectProjectionReference,
  ProjectPublishOptions,
} from "@seedrop/project";

export const KERNEL_PACKAGE_CONTRACT = Object.freeze({
  schema_version: "1.3",
  package_name: "@seedrop/kernel",
  role: "command_kernel",
  owns: Object.freeze([
    "state_changing_command_execution",
    "native_work_command_definitions",
    "atomic_recovery_proof",
  ] as const),
  depends_on: Object.freeze(["@seedrop/project", "@seedrop/protocol"] as const),
  excludes: Object.freeze([
    "adapter_policy",
    "durable_project_storage",
    "v1_writer_connection",
  ] as const),
} as const);

export type KernelCommandKind = "mutation" | "repair";
export type KernelAuthorizationOperation = "execute" | "recover";

export interface KernelCommandRequest {
  command_id: CanonicalId<"command">;
  command_version: ProtocolVersion;
  command_name: string;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  idempotency_key: string;
  expected_state_version: ProjectTransactionDigest | null;
  payload: JsonValue;
}

export interface KernelRecoveryRequest {
  command_id: CanonicalId<"command">;
  actor_principal_id: CanonicalId<"principal">;
}

export interface KernelResolvedPrincipal {
  principal_id: CanonicalId<"principal">;
  active: boolean;
  attributes: Readonly<Record<string, JsonValue>>;
}

export interface KernelAuthorizationContext {
  operation: KernelAuthorizationOperation;
  principal: KernelResolvedPrincipal;
  project_id: CanonicalId<"project">;
  command_id: CanonicalId<"command">;
  command_name: string;
  command_version: ProtocolVersion;
  command_kind: KernelCommandKind;
}

export interface KernelAuthorizationDecision {
  allowed: boolean;
  reason_code: string;
}

export interface KernelCommandContext {
  request: KernelCommandRequest;
  principal: KernelResolvedPrincipal;
  input_digest: ProjectTransactionDigest;
  project_scan: ProjectLogScan;
  project_projection: ProjectProjection;
}

export interface NativeWorkClock {
  now(): string;
}

export interface NativeWorkIdFactory {
  event(): CanonicalId<"event">;
}

export interface NativeWorkCommandOptions {
  clock?: NativeWorkClock;
  ids?: NativeWorkIdFactory;
}

export interface KernelPlannedEffect {
  effect_id: CanonicalId<"event">;
  effect_key: string;
  effect_type: string;
  declared_at: string;
  required: boolean;
  payload: JsonValue;
}

export interface KernelCommandPlan {
  events: readonly BuildProjectEventInput[];
  effects: readonly KernelPlannedEffect[];
  repair_receipt: RepairReceipt | null;
}

export interface KernelCommandDefinition {
  command_name: string;
  command_version: ProtocolVersion;
  kind: KernelCommandKind;
  validate(context: KernelCommandContext): void | Promise<void>;
  plan(context: KernelCommandContext): KernelCommandPlan | Promise<KernelCommandPlan>;
}

export interface KernelPrincipalResolver {
  resolve(
    principalId: CanonicalId<"principal">,
    projectId: CanonicalId<"project">,
  ): Promise<KernelResolvedPrincipal>;
}

export interface KernelAuthorizer {
  authorize(context: KernelAuthorizationContext): Promise<KernelAuthorizationDecision>;
}

/**
 * Implementations must make `dispatch` idempotent by `effect_key` and return the
 * same immutable delivery Receipt on replay. Throwing leaves the effect pending;
 * returning `dead_letter` makes repair explicitly required.
 */
export interface KernelEffectOutbox {
  dispatch(effect: OutboxEffect): Promise<OutboxDeliveryReceipt>;
}

export interface KernelClock {
  now(): string;
}

export interface KernelIdFactory {
  event(): CanonicalId<"event">;
  receipt(): CanonicalId<"receipt">;
}

export type KernelExecutionBoundary =
  | "before_authorization"
  | "after_validation"
  | "before_commit"
  | "after_commit"
  | "before_effect"
  | "after_effect"
  | "before_receipt";

export interface KernelExecutorOptions {
  feature_enabled: boolean;
  project_root: string;
  project_id: CanonicalId<"project">;
  definitions: readonly KernelCommandDefinition[];
  principal_resolver: KernelPrincipalResolver;
  authorizer: KernelAuthorizer;
  outbox: KernelEffectOutbox;
  clock?: KernelClock;
  ids?: KernelIdFactory;
  recovery_window_ms?: number;
  attempt_limit?: number;
  fault?: (boundary: KernelExecutionBoundary, detail?: string) => void | Promise<void>;
  /** Test/proof seam for abrupt control loss inside the writer-locked commit. */
  project_fault?: ProjectCommitOptions["fault"];
  /** Test/proof seam for abrupt control loss inside immutable publication. */
  publish_fault?: ProjectPublishOptions["fault"];
}

export interface KernelCommandOutcome {
  command_id: CanonicalId<"command">;
  project_id: CanonicalId<"project">;
  transaction: ProjectTransaction;
  transaction_digest: ProjectTransactionDigest;
  projection: ProjectProjectionReference;
  audit: CommandAuditTrail;
  receipt: CommandCommitReceipt;
  effects: readonly OutboxEffect[];
  deliveries: readonly OutboxDeliveryReceipt[];
  idempotent_replay: boolean;
  recovered: boolean;
}

export interface KernelCommandExecutor {
  execute(command: KernelCommandRequest): Promise<KernelCommandOutcome>;
  recover(command: KernelRecoveryRequest): Promise<KernelCommandOutcome>;
}
