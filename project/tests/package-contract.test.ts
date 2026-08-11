import { describe, expect, it } from "vitest";
import { PROJECT_PACKAGE_CONTRACT } from "../src/index.js";

describe("@seedrop/project package contract", () => {
  it("owns repo truth while importing semantics only from protocol", () => {
    expect(PROJECT_PACKAGE_CONTRACT).toEqual({
      schema_version: "1.0",
      package_name: "@seedrop/project",
      role: "project_record",
      owns: ["canonical_project_transactions", "project_receipts", "project_projections"],
      depends_on: ["@seedrop/protocol"],
      excludes: ["adapter_policy", "command_authorization", "machine_coordination", "v1_writer_connection"],
    });
    expect(Object.isFrozen(PROJECT_PACKAGE_CONTRACT)).toBe(true);
    expect(Object.isFrozen(PROJECT_PACKAGE_CONTRACT.owns)).toBe(true);
  });
});
