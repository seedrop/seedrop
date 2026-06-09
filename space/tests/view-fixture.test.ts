import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContinuityPacketSchema,
  HandoffSchema,
  RunJournalSchema,
  TaskSchema,
  ViewPolicySchema,
  WorkspaceManifestSchema,
} from "../src/schema.js";

const fixtureDir = path.resolve(process.cwd(), "..", "docs", "examples", "view");

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function jsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

describe("committed View fixture", () => {
  it("parses with the runtime View schemas", async () => {
    expect(WorkspaceManifestSchema.parse(await readJson(path.join(fixtureDir, "manifest.json"))).workspace_id).toBe("seedrop-example");
    expect(ViewPolicySchema.parse(await readJson(path.join(fixtureDir, "policy.json"))).required_success_level).toBe("L4");

    for (const file of await jsonFiles(path.join(fixtureDir, "runs"))) {
      expect(RunJournalSchema.parse(await readJson(file)).status).toBe("completed");
    }
    for (const file of await jsonFiles(path.join(fixtureDir, "handoffs"))) {
      expect(HandoffSchema.parse(await readJson(file)).status).toBe("pending");
    }
    for (const file of await jsonFiles(path.join(fixtureDir, "tasks"))) {
      expect(TaskSchema.parse(await readJson(file)).status).toBe("done");
    }
    for (const file of await jsonFiles(path.join(fixtureDir, "continuity"))) {
      expect(ContinuityPacketSchema.parse(await readJson(file)).validation.status).toBe("passed");
    }
  });

  it("keeps knowledge freshness metadata on the markdown note", async () => {
    const note = await readFile(path.join(fixtureDir, "knowledge", "committed-view.md"), "utf8");
    expect(note).toContain("status: current");
    expect(note).toContain("validated_by:");
  });
});
