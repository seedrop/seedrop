import { describe, expect, it } from "vitest";
import { KERNEL_PACKAGE_CONTRACT } from "../src/index.js";

describe("@seedrop/kernel package contract", () => {
  it("owns execution and points inward through project to protocol", () => {
    expect(KERNEL_PACKAGE_CONTRACT).toEqual({
      schema_version: "1.3",
      package_name: "@seedrop/kernel",
      role: "command_kernel",
      owns: [
        "state_changing_command_execution",
        "native_work_command_definitions",
        "atomic_recovery_proof",
      ],
      depends_on: ["@seedrop/project", "@seedrop/protocol"],
      excludes: ["adapter_policy", "durable_project_storage", "v1_writer_connection"],
    });
    expect(Object.isFrozen(KERNEL_PACKAGE_CONTRACT)).toBe(true);
    expect(Object.isFrozen(KERNEL_PACKAGE_CONTRACT.owns)).toBe(true);
  });
});
