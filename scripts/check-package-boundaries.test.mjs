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

test("Wave 5 authority and ownership boundaries remain explicit", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../architecture/package-boundaries.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.shadow_only_packages, ["@seedrop/kernel", "@seedrop/project", "@seedrop/migration", "@seedrop/outcomes", "@seedrop/situation"]);
  assert.deepEqual(contract.shadow_projection_consumers, {
    "@seedrop/situation": ["@seedrop/cli", "@seedrop/id", "@seedrop/mcp", "@seedrop/observer"],
    "@seedrop/migration": ["@seedrop/cli"],
  });
  assert.deepEqual(contract.rules, {
    adapters_own_domain_semantics: false,
    v1_writers_remain_authoritative: true,
    custom_database_is_main_path: false,
    wave_4_cutover_authorized: false,
    migration_v1_source_access: "read_only",
    wave_5_shadow_mismatch_behavior: "serve_v1",
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
  assert.deepEqual(contract.packages["@seedrop/outcomes"], {
    workspace: "outcomes",
    role: "external_outcome_projection",
    owns: [
      "validation_observation_projection",
      "delivery_observation_projection",
      "outcome_freshness_and_contradiction",
      "negative_continuity_grave_projection",
      "source_digest_claim_invalidation",
    ],
    allowed_internal_dependencies: ["@seedrop/protocol"],
  });
  assert.deepEqual(contract.packages["@seedrop/situation"], {
    workspace: "situation",
    role: "deterministic_orientation_projection",
    owns: [
      "situation_compilation",
      "field_provenance_freshness_completeness",
      "justified_next_action_or_refusal",
      "bounded_orientation_encoding",
      "adapter_semantic_projection_and_fallback",
    ],
    allowed_internal_dependencies: ["@seedrop/outcomes", "@seedrop/project", "@seedrop/protocol"],
  });
});
