import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findDependencyCycles, inspectPackageBoundaries } from "./check-package-boundaries.mjs";

test("the live workspace graph obeys the v2 package contract", async () => {
  const result = await inspectPackageBoundaries();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cycles, []);
  assert.equal(result.ok, true);
  assert.equal(result.workspace_count, 11);
});

test("dependency cycles are reported with the closing edge", () => {
  const graph = new Map([
    ["@seedrop/protocol", []],
    ["@seedrop/kernel", ["@seedrop/project"]],
    ["@seedrop/project", ["@seedrop/kernel"]],
  ]);
  assert.deepEqual(findDependencyCycles(graph), [
    ["@seedrop/kernel", "@seedrop/project", "@seedrop/kernel"],
  ]);
});

test("Wave 4 authority and ownership boundaries remain explicit", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../architecture/package-boundaries.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.shadow_only_packages, ["@seedrop/kernel", "@seedrop/project", "@seedrop/migration"]);
  assert.deepEqual(contract.rules, {
    adapters_own_domain_semantics: false,
    v1_writers_remain_authoritative: true,
    custom_database_is_main_path: false,
    wave_4_cutover_authorized: false,
    migration_v1_source_access: "read_only",
  });
  assert.deepEqual(contract.packages["@seedrop/project"].owns, [
    "canonical_project_transactions",
    "project_receipts",
    "project_projections",
    "project_health_and_quarantine",
  ]);
  assert.deepEqual(contract.packages["@seedrop/kernel"].owns, [
    "state_changing_command_execution",
  ]);
  assert.deepEqual(contract.packages["@seedrop/migration"].owns, [
    "v1_read_only_source_admission",
    "source_snapshot_binding",
    "staged_shadow_import",
    "migration_reconciliation",
  ]);
});
