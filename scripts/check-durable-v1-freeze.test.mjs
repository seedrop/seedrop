import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  acceptContract,
  checkContract,
  createContractSnapshot,
  createInitialManifest,
} from "./check-durable-v1-freeze.mjs";

const SOURCES = [
  "id/src/schema.ts",
  "id/src/audit.ts",
  "id/src/commit-journal.ts",
  "space/src/schema.ts",
  "space/src/schema-migrations.ts",
  "space/src/live.ts",
  "space/src/mentions.ts",
  "space/src/cli.ts",
  "cli/src/active-passport.ts",
  "cli/src/continuity-state.ts",
  "cli/src/router.ts",
];

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "seedrop-v1-freeze-"));
  for (const source of SOURCES) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    cpSync(join(process.cwd(), source), join(root, source));
  }
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(
    join(root, "docs", "adr", "0002-freeze.md"),
    "# Initial freeze\n\n- **Status:** accepted\n- **Durable v1 change class:** initial-freeze\n\n## Decision\n\nFreeze it.\n",
  );
  const snapshot = createContractSnapshot(root);
  const manifest = createInitialManifest(snapshot, "docs/adr/0002-freeze.md");
  mkdirSync(join(root, "docs", "v2"), { recursive: true });
  writeFileSync(join(root, "docs", "v2", "durable-v1-contract.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

test("passes an unchanged durable v1 contract and rejects an unversioned schema addition", () => {
  const root = fixtureRepo();
  try {
    assert.equal(checkContract(root).status, "passed");
    const schema = join(root, "space", "src", "schema.ts");
    writeFileSync(schema, `${readFileSync(schema, "utf8")}\nexport const UnversionedDurableSchema = z.object({ added: z.string() });\n`);
    assert.throws(() => checkContract(root), /changed without an accepted transition.*UnversionedDurableSchema/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("accepts a changed contract only through an accepted, class-matched ADR", () => {
  const root = fixtureRepo();
  try {
    const schema = join(root, "space", "src", "schema.ts");
    writeFileSync(schema, `${readFileSync(schema, "utf8")}\nexport const SafetyRepairSchema = z.object({ repaired: z.boolean() });\n`);
    const decision = join(root, "docs", "adr", "0003-repair.md");
    writeFileSync(
      decision,
      "# Safety repair\n\n- **Status:** proposed\n- **Durable v1 change class:** safety-repair\n\n## Decision\n\nRepair it.\n",
    );
    assert.throws(
      () => acceptContract(root, { decision: "docs/adr/0003-repair.md", changeClass: "safety-repair", write: true }),
      /status must be accepted/,
    );
    writeFileSync(
      decision,
      "# Safety repair\n\n- **Status:** accepted\n- **Durable v1 change class:** versioned-migration\n\n## Decision\n\nRepair it.\n",
    );
    assert.throws(
      () => acceptContract(root, { decision: "docs/adr/0003-repair.md", changeClass: "safety-repair", write: true }),
      /does not match/,
    );
    writeFileSync(
      decision,
      "# Safety repair\n\n- **Status:** accepted\n- **Durable v1 change class:** safety-repair\n\n## Decision\n\nRepair it.\n",
    );
    acceptContract(root, {
      decision: "docs/adr/0003-repair.md",
      changeClass: "safety-repair",
      id: "fixture-repair",
      write: true,
    });
    const checked = checkContract(root);
    assert.equal(checked.status, "passed");
    assert.equal(checked.accepted_transitions, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
