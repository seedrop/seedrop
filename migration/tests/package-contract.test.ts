import { describe, expect, it } from "vitest";
import {
  MIGRATION_PACKAGE_CONTRACT,
  SHADOW_MIGRATION_STATES,
} from "../src/index.js";

describe("@seedrop/migration package contract", () => {
  it("owns only shadow migration and cannot represent Wave 4 cutover", () => {
    expect(MIGRATION_PACKAGE_CONTRACT).toEqual({
      schema_version: "1.0",
      package_name: "@seedrop/migration",
      role: "shadow_migration",
      owns: [
        "v1_read_only_source_admission",
        "source_snapshot_binding",
        "staged_shadow_import",
        "migration_reconciliation",
        "v1_edge_compatibility",
        "dry_run_command_translation",
      ],
      depends_on: ["@seedrop/id", "@seedrop/project", "@seedrop/protocol", "@seedrop/space"],
      excludes: ["v1_source_mutation", "cutover_authority", "adapter_policy", "custom_database", "command_submission"],
      terminal_state: "verified_not_authorized_for_cutover",
    });
    expect(SHADOW_MIGRATION_STATES).toEqual([
      "preview",
      "source_snapshot_verified",
      "staged",
      "verified_not_authorized_for_cutover",
    ]);
    expect(SHADOW_MIGRATION_STATES).not.toContain("cutover");
    expect(Object.isFrozen(MIGRATION_PACKAGE_CONTRACT)).toBe(true);
    expect(Object.isFrozen(SHADOW_MIGRATION_STATES)).toBe(true);
  });
});
