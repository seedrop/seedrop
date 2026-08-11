import type {
  CanonicalId,
  CommandAuditTrail,
  JsonValue,
  ProtocolVersion,
} from "@seedrop/protocol";

export const KERNEL_PACKAGE_CONTRACT = Object.freeze({
  schema_version: "1.0",
  package_name: "@seedrop/kernel",
  role: "command_kernel",
  owns: Object.freeze(["state_changing_command_execution"] as const),
  depends_on: Object.freeze(["@seedrop/protocol"] as const),
  excludes: Object.freeze([
    "adapter_policy",
    "durable_project_storage",
    "v1_writer_connection",
  ] as const),
} as const);

/**
 * Transport-neutral input to the future Wave 3 executor.
 *
 * This package owns execution. Command names, identifiers, versions, phases, and
 * transition meaning remain owned by @seedrop/protocol.
 */
export interface KernelCommandRequest {
  command_id: CanonicalId<"command">;
  command_version: ProtocolVersion;
  command_name: string;
  principal_id: CanonicalId<"principal">;
  project_id: CanonicalId<"project">;
  idempotency_key: string;
  expected_state_version: string;
  payload: JsonValue;
}

/** A completed executor invocation always returns the protocol-owned audit truth. */
export interface KernelCommandOutcome {
  command_id: CanonicalId<"command">;
  project_id: CanonicalId<"project">;
  audit: CommandAuditTrail;
}

/**
 * The only v2 boundary allowed to execute a state-changing command.
 * TR-02 defines the port; the feature-flagged implementation arrives in TX-01–TX-04.
 */
export interface KernelCommandExecutor {
  execute(command: KernelCommandRequest): Promise<KernelCommandOutcome>;
}
