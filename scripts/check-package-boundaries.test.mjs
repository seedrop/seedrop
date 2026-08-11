import assert from "node:assert/strict";
import test from "node:test";
import { findDependencyCycles, inspectPackageBoundaries } from "./check-package-boundaries.mjs";

test("the live workspace graph obeys the v2 package contract", async () => {
  const result = await inspectPackageBoundaries();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cycles, []);
  assert.equal(result.ok, true);
  assert.equal(result.workspace_count, 10);
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
