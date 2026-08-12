import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateCanonicalId, reconcilePrincipalCandidates } from "@seedrop/protocol";
import type { CanonicalId } from "@seedrop/protocol";
import {
  assertV1DryRunCommandDraft,
  collectV1ViewHistory,
  compareV1AndV2Projection,
  compatibilityProjectionBytes,
  digestReadOnlyTree,
  importViewHistory,
  translateV1CommandDryRun,
} from "../src/index.js";

const roots: string[] = [];
const AT = "2026-08-12T12:00:00.000Z";

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("read-only v1 compatibility edge", () => {
  it("classifies every semantic difference without mutating v1 source", async () => {
    const fixture = await createFixture();
    const before = await digestReadOnlyTree(fixture.viewRoot);
    const collection = await collectV1ViewHistory({ view_root: fixture.viewRoot });
    const imported = importViewHistory(importInput(collection));
    const first = compareV1AndV2Projection({ collection, imported });
    const second = compareV1AndV2Projection({ collection: { ...collection, records: [...collection.records].reverse() }, imported });
    const after = await digestReadOnlyTree(fixture.viewRoot);

    expect(after).toBe(before);
    expect(first.receipt.counts).toEqual({
      source_records: 3,
      equal_records: 0,
      intentionally_transformed_records: 1,
      quarantined_records: 1,
      unresolved_records: 1,
    });
    expect(first.differences.map((item) => item.disposition).sort()).toEqual(["intentionally_transformed", "quarantined", "unresolved"]);
    expect(compatibilityProjectionBytes(second)).toEqual(compatibilityProjectionBytes(first));
  });

  it("constructs deterministic open-work commands but cannot submit them", () => {
    const input = commandInput("task.create", {
      title: "Compatibility task",
      description: "Prove edge translation",
      target: "migration/src/compatibility.ts",
      lease_expires_at: "2026-08-13T12:00:00.000Z",
    });
    const first = translateV1CommandDryRun(input);
    const second = translateV1CommandDryRun(input);
    expect(first).toEqual(second);
    expect(first).toEqual(expect.objectContaining({
      disposition: "translated",
      submit_capability: false,
      command: expect.objectContaining({ command_name: "seedrop.work.open" }),
    }));
    expect(first).not.toHaveProperty("execute");
    expect(first).not.toHaveProperty("submit");
    expect(() => assertV1DryRunCommandDraft(first)).not.toThrow();
  });

  it("refuses to guess existing v2 identities and unknown v1 commands", () => {
    expect(translateV1CommandDryRun(commandInput("run.finish", {}))).toEqual(expect.objectContaining({
      disposition: "intentionally_unsupported", command: null, submit_capability: false,
    }));
    expect(translateV1CommandDryRun(commandInput("plugin.magic", {}))).toEqual(expect.objectContaining({
      disposition: "unresolved", command: null, submit_capability: false,
    }));
    expect(translateV1CommandDryRun(commandInput("task.create", { title: "No lease" }))).toEqual(expect.objectContaining({
      disposition: "unresolved", reason_code: "lease_expiry_required_for_v2_open",
    }));
  });

  it("rejects any attempt to add submission capability", () => {
    const draft = translateV1CommandDryRun(commandInput("plugin.magic", {}));
    expect(() => assertV1DryRunCommandDraft({ ...draft, submit_capability: true } as unknown as typeof draft)).toThrow(/invalid_contract/);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "seedrop-compatibility-"));
  roots.push(root);
  const viewRoot = join(root, ".seedrop", "view");
  const taskId = "11111111-1111-4111-8111-111111111111";
  await writeJson(join(viewRoot, "tasks", `${taskId}.json`), {
    schema_version: "1.0", task_id: taskId, title: "Valid", status: "open", owner: "agent-a",
    created_at: AT, updated_at: AT, related_runs: [],
  });
  await mkdir(join(viewRoot, "tasks"), { recursive: true });
  await writeFile(join(viewRoot, "tasks", "broken.json"), "{broken", "utf8");
  await writeJson(join(viewRoot, "continuity", "packet.json"), {
    schema_version: "1.0", id: "22222222-2222-4222-8222-222222222222", created_at: AT,
    agent: "agent-a", mission: "Continue", summary: "No explicit run link", decisions: [], assumptions: [],
    open_threads: [], changed_paths: [], validation: { status: "passed", commands: [] },
  });
  return { viewRoot };
}

function importInput(collection: Awaited<ReturnType<typeof collectV1ViewHistory>>) {
  const registry = reconcilePrincipalCandidates([
    { source_ref: "agent:a", kind: "agent", aliases: [{ namespace: "agent_id", value: "agent-a" }] },
    { source_ref: "agent:m", kind: "agent", aliases: [{ namespace: "agent_id", value: "migration" }] },
  ], { mint_id: (source) => id("principal", source) }).registry;
  return {
    collection,
    project_id: id("project", "fixture"),
    migration_principal_id: registry.principals.find((item) => item.source_refs.includes("agent:m"))!.principal_id,
    principal_registry: registry,
    snapshot_recorded_at: AT,
  };
}

function commandInput(command_name: string, args: object) {
  return {
    source_ref: `cli:${command_name}`,
    command_name,
    args,
    principal_id: id("principal", "agent-a"),
    project_id: id("project", "fixture"),
    expected_state_version: null,
  };
}

function id<K extends "principal" | "project">(kind: K, source: string): CanonicalId<K> {
  return generateCanonicalId(kind, { now: 1_725_000_000_000, entropy: createHash("sha256").update(source).digest().subarray(0, 10) });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
