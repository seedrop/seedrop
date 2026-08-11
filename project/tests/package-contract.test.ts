import { describe, expect, it } from "vitest";
import {
  PROJECT_PACKAGE_CONTRACT,
  PROJECT_PROJECTION_VERSION,
  PROJECT_STORE_LAYOUT_VERSION,
  WORK_PROJECTION_VERSION,
} from "../src/index.js";

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
    expect(PROJECT_STORE_LAYOUT_VERSION).toBe("1.1.0");
    expect(PROJECT_PROJECTION_VERSION).toBe("1.0.0");
    expect(WORK_PROJECTION_VERSION).toBe("1.0.0");
  });
});
