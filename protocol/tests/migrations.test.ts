import { describe, expect, it } from "vitest";
import {
  PROTOCOL_ENVELOPE_MIGRATIONS,
  ProtocolError,
  defineMigrationPlan,
  migrateToCurrent,
  migrationPlanMetadata,
  orderedMigrationPath,
  validateMigrationPlan,
  type MigrationPlan,
} from "../src/index.js";
import { golden } from "./fixtures.js";

interface Example { schema_version: string; name?: string; display_name?: string; active?: boolean }

const completePlan = defineMigrationPlan<Example>({
  schema: "example",
  current: "2.0.0",
  roots: ["1.0.0"],
  steps: [
    {
      id: "example/1.0.0-1.1.0",
      from: "1.0.0",
      to: "1.1.0",
      description: "Rename name to display_name.",
      migrate: (value) => ({ schema_version: "1.1.0", display_name: value.name }),
    },
    {
      id: "example/1.1.0-2.0.0",
      from: "1.1.0",
      to: "2.0.0",
      description: "Add explicit active state.",
      migrate: (value) => ({ ...value, schema_version: "2.0.0", active: true }),
    },
  ],
});

describe("ordered protocol migrations", () => {
  it("freezes the production initial-version metadata vector", () => {
    expect(migrationPlanMetadata(PROTOCOL_ENVELOPE_MIGRATIONS)).toEqual(golden.migration_plan);
    expect(() => validateMigrationPlan(PROTOCOL_ENVELOPE_MIGRATIONS)).not.toThrow();
  });

  it("returns and applies the one deterministic gap-free path", () => {
    expect(orderedMigrationPath(completePlan, "1.0.0").map((step) => step.id)).toEqual([
      "example/1.0.0-1.1.0",
      "example/1.1.0-2.0.0",
    ]);
    expect(migrateToCurrent(completePlan, "1.0.0", { schema_version: "1.0.0", name: "Ada" },
      (value) => value.schema_version === "2.0.0" && value.display_name === "Ada" && value.active === true,
    )).toEqual({
      value: { schema_version: "2.0.0", display_name: "Ada", active: true },
      from: "1.0.0",
      to: "2.0.0",
      applied: ["example/1.0.0-1.1.0", "example/1.1.0-2.0.0"],
    });
  });

  it("fails graph definition on gaps, ambiguous edges, backward edges, and orphans", () => {
    expectGraphInvalid({
      schema: "gap", current: "2.0.0", roots: ["1.0.0"], steps: [],
    });
    expectGraphInvalid({
      schema: "ambiguous", current: "2.0.0", roots: ["1.0.0"],
      steps: [step("a", "1.0.0", "1.1.0"), step("b", "1.0.0", "2.0.0"), step("c", "1.1.0", "2.0.0")],
    });
    expectGraphInvalid({
      schema: "backward", current: "2.0.0", roots: ["2.0.0"], steps: [step("a", "2.0.0", "1.0.0")],
    });
    expectGraphInvalid({
      schema: "orphan", current: "2.0.0", roots: ["1.0.0"],
      steps: [step("a", "1.0.0", "2.0.0"), step("orphan", "1.5.0", "2.0.0")],
    });
  });

  it("fails typed on forward, unknown, transform failure, and validation failure", () => {
    expectProtocolCode(() => orderedMigrationPath(completePlan, "3.0.0"), "seedrop.protocol.version_forward");
    expectProtocolCode(() => orderedMigrationPath(completePlan, "0.9.0"), "seedrop.protocol.version_unknown");
    const broken = defineMigrationPlan<Example>({
      schema: "broken", current: "2.0.0", roots: ["1.0.0"],
      steps: [{ ...step("broken/1-2", "1.0.0", "2.0.0"), migrate: () => { throw new Error("boom"); } }],
    });
    expectProtocolCode(
      () => migrateToCurrent(broken, "1.0.0", { schema_version: "1.0.0" }, () => true),
      "seedrop.protocol.migration_failed",
    );
    expectProtocolCode(
      () => migrateToCurrent(completePlan, "1.0.0", { schema_version: "1.0.0" }, () => false),
      "seedrop.protocol.validation_failed",
    );
    expectProtocolCode(
      () => migrateToCurrent(completePlan, "2.0.0", { schema_version: "2.0.0" }, () => false),
      "seedrop.protocol.validation_failed",
    );
  });
});

function step(id: string, from: `${number}.${number}.${number}`, to: `${number}.${number}.${number}`) {
  return { id, from, to, description: id, migrate: (value: Example) => value };
}

function expectGraphInvalid(plan: MigrationPlan<Example>): void {
  expectProtocolCode(() => defineMigrationPlan(plan), "seedrop.protocol.migration_graph_invalid");
}

function expectProtocolCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}
