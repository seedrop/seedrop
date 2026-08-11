import type { CanonicalId } from "@seedrop/protocol";

export const PROJECT_PACKAGE_CONTRACT = Object.freeze({
  schema_version: "1.0",
  package_name: "@seedrop/project",
  role: "project_record",
  owns: Object.freeze([
    "canonical_project_transactions",
    "project_receipts",
    "project_projections",
  ] as const),
  depends_on: Object.freeze(["@seedrop/protocol"] as const),
  excludes: Object.freeze([
    "adapter_policy",
    "command_authorization",
    "machine_coordination",
    "v1_writer_connection",
  ] as const),
} as const);

/** Stable identity of immutable canonical transaction bytes. */
export interface ProjectTransactionReference {
  project_id: CanonicalId<"project">;
  command_id: CanonicalId<"command">;
  digest: string;
}

/** A projection watermark is disposable and always points back to canonical truth. */
export interface ProjectProjectionReference {
  project_id: CanonicalId<"project">;
  projection_version: string;
  source_high_watermark: string;
  source_digest: string;
}
