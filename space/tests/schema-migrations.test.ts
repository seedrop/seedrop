import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SchemaVersionUnsupportedError, WorkspaceViewValidationError } from "../src/errors.js";
import { compareVersions, parseAndMigrate, type MigrationChain } from "../src/migrations.js";
import {
  ContinuityPacketMigrationChain,
  RunJournalMigrationChain,
  TaskMigrationChain,
} from "../src/schema-migrations.js";

// A minimal v1.0 / v1.1 schema pair for exercising the chain logic
// without depending on the real Task / Run / Packet shapes.
const DummyV1 = z.object({ schema_version: z.literal("1.0"), name: z.string() });
const DummyV1_1 = z.object({
  schema_version: z.literal("1.1"),
  name: z.string(),
  // v1.1 splits name into first + last.
  first: z.string(),
  last: z.string(),
});

const chainV1: MigrationChain = {
  schemaName: "Dummy",
  current: "1.0",
  migrations: [],
};

const chainV1_1: MigrationChain = {
  schemaName: "Dummy",
  current: "1.1",
  migrations: [
    {
      from: "1.0",
      to: "1.1",
      migrate: (raw) => {
        const r = raw as { schema_version?: string; name: string };
        const [first, ...rest] = r.name.split(" ");
        return {
          schema_version: "1.1",
          name: r.name,
          first: first ?? "",
          last: rest.join(" "),
        };
      },
    },
  ],
};

describe("parseAndMigrate — version handling (1b8676dc)", () => {
  it("identity: v1.0 input + v1.0 chain returns parsed value unchanged", () => {
    const result = parseAndMigrate({ schema_version: "1.0", name: "ada" }, chainV1, DummyV1);
    expect(result).toEqual({ schema_version: "1.0", name: "ada" });
  });

  it("forward chain: v1.0 input migrates to v1.1 and Zod-parses against the new shape", () => {
    const result = parseAndMigrate(
      { schema_version: "1.0", name: "Ada Lovelace" },
      chainV1_1,
      DummyV1_1,
    );
    expect(result).toEqual({
      schema_version: "1.1",
      name: "Ada Lovelace",
      first: "Ada",
      last: "Lovelace",
    });
  });

  it("already-current input skips migrations", () => {
    let invoked = 0;
    const chain: MigrationChain = {
      schemaName: "Dummy",
      current: "1.1",
      migrations: [
        {
          from: "1.0",
          to: "1.1",
          migrate: (r) => {
            invoked += 1;
            return r;
          },
        },
      ],
    };
    parseAndMigrate(
      { schema_version: "1.1", name: "X", first: "X", last: "" },
      chain,
      DummyV1_1,
    );
    expect(invoked).toBe(0);
  });

  it("forward-version: stored > current throws SchemaVersionUnsupportedError (forward)", () => {
    try {
      parseAndMigrate({ schema_version: "9.9", name: "x" }, chainV1, DummyV1);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaVersionUnsupportedError);
      const e = err as SchemaVersionUnsupportedError;
      expect(e.reason).toBe("forward");
      expect(e.found).toBe("9.9");
      expect(e.supported).toBe("1.0");
      // Recovery hints must include the upgrade command.
      const commands = e.recovery.map((r) => r.command);
      expect(commands).toContain("seed --version");
      expect(commands).toContain("npm i -g @seedrop/cli@latest");
    }
  });

  it("unknown version: stored version not in chain throws (unknown)", () => {
    try {
      parseAndMigrate({ schema_version: "0.5", name: "x" }, chainV1_1, DummyV1_1);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaVersionUnsupportedError);
      expect((err as SchemaVersionUnsupportedError).reason).toBe("unknown");
    }
  });

  it("implicit v1.0: missing schema_version is treated as 1.0", () => {
    const result = parseAndMigrate({ name: "ada" } as unknown, chainV1, DummyV1.partial({ schema_version: true }).extend({
      schema_version: z.literal("1.0").optional(),
    }));
    expect(result.name).toBe("ada");
  });

  it("post-migration Zod failure surfaces as WorkspaceViewValidationError", () => {
    // A chain whose migration produces malformed output.
    const broken: MigrationChain = {
      schemaName: "Dummy",
      current: "1.1",
      migrations: [
        {
          from: "1.0",
          to: "1.1",
          migrate: () => ({ schema_version: "1.1" }), // missing `name`, `first`, `last`
        },
      ],
    };
    expect(() =>
      parseAndMigrate({ schema_version: "1.0", name: "x" }, broken, DummyV1_1),
    ).toThrow(WorkspaceViewValidationError);
  });

  it("preserves filePath in the thrown error for debugging", () => {
    try {
      parseAndMigrate({ schema_version: "9.9", name: "x" }, chainV1, DummyV1, "/tmp/broken.json");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as SchemaVersionUnsupportedError).path).toBe("/tmp/broken.json");
    }
  });
});

describe("compareVersions", () => {
  it("orders semver-ish strings numerically", () => {
    expect(compareVersions("1.0", "1.0")).toBe(0);
    expect(compareVersions("1.0", "1.1")).toBe(-1);
    expect(compareVersions("1.1", "1.0")).toBe(1);
    expect(compareVersions("1.0", "2.0")).toBe(-1);
    expect(compareVersions("1.10", "1.2")).toBe(1); // numeric, not lexicographic
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1", "1.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
  });
});

describe("real schema chains — shape sanity (1b8676dc)", () => {
  it("Task chain is registered at current=1.0 with no migrations", () => {
    expect(TaskMigrationChain.schemaName).toBe("Task");
    expect(TaskMigrationChain.current).toBe("1.0");
    expect(TaskMigrationChain.migrations).toEqual([]);
  });

  it("RunJournal chain is registered at current=1.0 with no migrations", () => {
    expect(RunJournalMigrationChain.schemaName).toBe("RunJournal");
    expect(RunJournalMigrationChain.current).toBe("1.0");
    expect(RunJournalMigrationChain.migrations).toEqual([]);
  });

  it("ContinuityPacket chain is registered at current=1.0 with no migrations", () => {
    expect(ContinuityPacketMigrationChain.schemaName).toBe("ContinuityPacket");
    expect(ContinuityPacketMigrationChain.current).toBe("1.0");
    expect(ContinuityPacketMigrationChain.migrations).toEqual([]);
  });
});
