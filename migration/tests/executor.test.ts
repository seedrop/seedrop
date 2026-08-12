import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateCanonicalId } from "@seedrop/protocol";
import type { CanonicalId } from "@seedrop/protocol";
import {
  MIGRATION_EXECUTION_FAULT_BOUNDARIES,
  MigrationContractError,
  assertMigrationExecutionCheckpoint,
  buildMigrationCorpus,
  executeShadowMigration,
  migrationExecutionCheckpointBytes,
  readMigrationExecutionCheckpoint,
} from "../src/index.js";
import type { MigrationCorpus, MigrationExecutionFaultBoundary } from "../src/index.js";

const roots: string[] = [];
const A = `sha256:${"a".repeat(64)}` as const;
const B = `sha256:${"b".repeat(64)}` as const;
const C = `sha256:${"c".repeat(64)}` as const;
const AT = new Date("2026-08-12T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resumable shadow migration executor", () => {
  it("survives interruption before and after every boundary and resumes by source cursor", async () => {
    const exercised = new Set<MigrationExecutionFaultBoundary>();
    for (const target of MIGRATION_EXECUTION_FAULT_BOUNDARIES) {
      const fixture = await executorFixture();
      let interrupted = false;
      const options = fixture.options(async (boundary) => {
        if (!interrupted && boundary === target) {
          interrupted = true;
          exercised.add(boundary);
          throw new Error(`fault:${boundary}`);
        }
      });
      await expect(executeShadowMigration(options)).rejects.toThrow(`fault:${target}`);
      const result = await executeShadowMigration(fixture.options());

      expect(result.receipt.state).toBe("verified_not_authorized_for_cutover");
      expect(result.cursor).toEqual({ phase: "complete", next_source_index: 3 });
      expect(result.receipt.reconciliation).toEqual({
        source_records: 6,
        imported_records: 4,
        quarantined_records: 1,
        unresolved_records: 1,
      });
      expect(result.revision).toBe(13);
      expect(result.snapshot_sources.map((source) => source.source_ref)).toEqual(["identity", "view:a", "view:b"]);
      expect(result.staged_sources.map((source) => source.idempotency_key)).toHaveLength(3);
      expect(new Set(result.staged_sources.map((source) => source.idempotency_key)).size).toBe(3);
      expect(result.receipt).not.toHaveProperty("cutover_authorized");
      expect(result.receipt.state).not.toBe("cutover");
    }
    expect([...exercised].sort()).toEqual([...MIGRATION_EXECUTION_FAULT_BOUNDARIES].sort());
  });

  it("returns byte-identical terminal evidence without re-running source work", async () => {
    const fixture = await executorFixture();
    const first = await executeShadowMigration(fixture.options());
    const attempts = { ...fixture.attempts };
    const second = await executeShadowMigration(fixture.options());
    const loaded = await readMigrationExecutionCheckpoint(fixture.root, "wave4-executor");

    expect(migrationExecutionCheckpointBytes(second)).toEqual(migrationExecutionCheckpointBytes(first));
    expect(loaded).toEqual(first);
    expect(fixture.attempts).toEqual(attempts);
    const files = (await checkpointFiles(fixture.root)).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(13);
    expect(files.every((name, index) => name.startsWith(String(index + 1).padStart(12, "0")))).toBe(true);
  });

  it("replays an uncheckpointed stage callback under the same idempotency key", async () => {
    const fixture = await executorFixture();
    let failed = false;
    await expect(executeShadowMigration(fixture.options(async (boundary) => {
      if (!failed && boundary === "after_stage_source") {
        failed = true;
        throw new Error("power-loss");
      }
    }))).rejects.toThrow("power-loss");
    const keysBefore = [...fixture.stageKeys];
    const result = await executeShadowMigration(fixture.options());

    expect(result.cursor.phase).toBe("complete");
    expect(fixture.stageKeys[0]).toBe(keysBefore[0]);
    expect(fixture.stageKeys.filter((key) => key === keysBefore[0])).toHaveLength(2);
  });

  it("rejects source drift after source work without advancing the cursor", async () => {
    const fixture = await executorFixture();
    const changed = buildMigrationCorpus([
      { source_ref: "identity", source_kind: "identity", source_digest: A, file_count: 1, byte_count: 10, record_count: 2 },
      { source_ref: "view:a", source_kind: "view", source_digest: B, file_count: 1, byte_count: 21, record_count: 3 },
      { source_ref: "view:b", source_kind: "view", source_digest: C, file_count: 1, byte_count: 30, record_count: 1 },
    ]);
    fixture.mutateAfterFirstStage(changed);
    await expect(executeShadowMigration(fixture.options())).rejects.toThrowError(expect.objectContaining({ code: "source_changed" }));
    const checkpoint = await readMigrationExecutionCheckpoint(fixture.root, "wave4-executor");
    expect(checkpoint?.cursor).toEqual({ phase: "stage_shadow_import", next_source_index: 0 });
    expect(checkpoint?.staged_sources).toHaveLength(0);
  });

  it("rejects staged/verification disagreement and conserves every source record", async () => {
    const fixture = await executorFixture({ verificationMismatch: true });
    await expect(executeShadowMigration(fixture.options())).rejects.toThrowError(expect.objectContaining({ code: "invalid_contract" }));
    const checkpoint = await readMigrationExecutionCheckpoint(fixture.root, "wave4-executor");
    expect(checkpoint?.cursor).toEqual({ phase: "verify_reconciliation", next_source_index: 0 });
  });

  it("detects corrupt immutable journal bytes", async () => {
    const fixture = await executorFixture();
    const result = await executeShadowMigration(fixture.options());
    const files = await checkpointFiles(fixture.root);
    const final = files.find((name) => name.includes(result.checkpoint_digest.slice(7)))!;
    const directory = await checkpointDirectory(fixture.root);
    await writeFile(join(directory, final), "{broken", "utf8");
    await expect(readMigrationExecutionCheckpoint(fixture.root, "wave4-executor"))
      .rejects.toThrowError(expect.objectContaining({ code: "checkpoint_corrupt" }));
  });

  it("rejects checkpoint fields that imply cutover authority", async () => {
    const fixture = await executorFixture();
    const result = await executeShadowMigration(fixture.options());
    expect(() => assertMigrationExecutionCheckpoint({ ...result, cutover_authorized: true } as typeof result))
      .toThrowError(MigrationContractError);
  });
});

async function executorFixture(options: { verificationMismatch?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "seedrop-migration-executor-"));
  roots.push(root);
  const corpus = fixtureCorpus();
  let observed = corpus;
  let mutation: MigrationCorpus | null = null;
  const attempts: Record<string, number> = { stage: 0, verify: 0 };
  const stageKeys: string[] = [];
  const projectA = project("project-a", B);
  const projectB = project("project-b", C);
  const reconciliations = [
    { source_records: 2, imported_records: 2, quarantined_records: 0, unresolved_records: 0 },
    { source_records: 3, imported_records: 1, quarantined_records: 1, unresolved_records: 1 },
    { source_records: 1, imported_records: 1, quarantined_records: 0, unresolved_records: 0 },
  ];
  return {
    root,
    attempts,
    stageKeys,
    mutateAfterFirstStage(value: MigrationCorpus) { mutation = value; },
    options(fault?: (boundary: MigrationExecutionFaultBoundary) => void | Promise<void>) {
      return {
        state_root: root,
        migration_id: "wave4-executor",
        corpus,
        now: () => AT,
        observe_corpus: async () => observed,
        stage_source: async (context: { source_index: number; idempotency_key: string }) => {
          attempts.stage += 1;
          stageKeys.push(context.idempotency_key);
          const result = {
            staged_projects: context.source_index === 1 ? [projectA] : context.source_index === 2 ? [projectB] : [],
            reconciliation: reconciliations[context.source_index]!,
          };
          if (context.source_index === 0 && mutation) observed = mutation;
          return result;
        },
        verify_source: async (context: { source_index: number }, staged: { reconciliation: typeof reconciliations[number] }) => {
          attempts.verify += 1;
          if (options.verificationMismatch && context.source_index === 0) {
            return { reconciliation: { source_records: 2, imported_records: 1, quarantined_records: 0, unresolved_records: 1 } };
          }
          return { reconciliation: staged.reconciliation };
        },
        fault: fault ? async (boundary: MigrationExecutionFaultBoundary) => fault(boundary) : undefined,
      };
    },
  };
}

function fixtureCorpus() {
  return buildMigrationCorpus([
    { source_ref: "view:b", source_kind: "view", source_digest: C, file_count: 1, byte_count: 30, record_count: 1 },
    { source_ref: "identity", source_kind: "identity", source_digest: A, file_count: 1, byte_count: 10, record_count: 2 },
    { source_ref: "view:a", source_kind: "view", source_digest: B, file_count: 1, byte_count: 20, record_count: 3 },
  ]);
}

function project(source: string, digest: typeof A | typeof B | typeof C) {
  return {
    project_id: id("project", source),
    projection_version: "1.0.0",
    source_high_watermark: digest,
    source_digest: digest,
  };
}

function id<K extends "principal" | "project">(kind: K, source: string): CanonicalId<K> {
  return generateCanonicalId(kind, {
    now: 1_725_000_000_000,
    entropy: createHash("sha256").update(source).digest().subarray(0, 10),
  });
}

async function checkpointDirectory(root: string): Promise<string> {
  const [migration] = await readdir(root);
  return join(root, migration!, "checkpoints");
}

async function checkpointFiles(root: string): Promise<string[]> {
  return (await readdir(await checkpointDirectory(root))).sort();
}
