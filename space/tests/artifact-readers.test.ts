import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceView,
  WorkspaceViewParseError,
  type ArtifactFamily,
  type ArtifactReadResult,
} from "../src/view.js";

describe("honest durable artifact readers", () => {
  let root: string;
  let view: WorkspaceView;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seedrop-artifact-readers-"));
    view = WorkspaceView.open({ root, agent: "codex", now: () => new Date("2026-08-09T06:00:00.000Z") });
    await view.init("artifact-reader-test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports malformed manifest and policy singletons instead of treating them as absent", async () => {
    const manifestPath = path.join(root, ".seedrop", "view", "manifest.json");
    const policyPath = path.join(root, ".seedrop", "view", "policy.json");

    await writeFile(manifestPath, "{not-json", "utf8");
    await writeFile(policyPath, JSON.stringify({ schema_version: "1.0", ignore: ["/absolute"] }), "utf8");

    expectPartial(await view.readManifestArtifact(), "manifest", ".seedrop/view/manifest.json", "invalid_json");
    expectPartial(await view.readPolicyArtifact(), "policy", ".seedrop/view/policy.json", "schema_validation");
  });

  it("preserves valid siblings and names corrupt paths for every directory-backed family", async () => {
    await view.log({ mission: "valid packet", summary: "valid continuity sibling" });
    const run = await view.startRun({ goal: "valid run", newRun: true });
    const task = await view.createTask({ title: "valid task" });
    const signal = await view.claimSignal({ target: "space/src/view.ts", intent: "valid signal" });

    const dataDir = path.join(root, ".seedrop", "view");
    await writeFile(path.join(dataDir, "continuity", "corrupt.json"), "{not-json", "utf8");
    await writeFile(path.join(dataDir, "runs", "corrupt.json"), "{not-json", "utf8");
    await writeFile(
      path.join(dataDir, "tasks", "corrupt.json"),
      JSON.stringify({ schema_version: "1.0", task_id: "not-a-uuid" }),
      "utf8",
    );
    await writeFile(path.join(dataDir, "signals", "corrupt.json"), "{not-json", "utf8");

    const handoffId = randomUUID();
    await writeFile(
      path.join(dataDir, "handoffs", `${handoffId}.json`),
      JSON.stringify({
        schema_version: "1.0",
        handoff_id: handoffId,
        created_at: "2026-08-09T05:00:00.000Z",
        updated_at: "2026-08-09T05:00:00.000Z",
        source_agent: "codex",
        recipient: "claude",
        summary: "valid legacy handoff",
        status: "pending",
        files_changed: [],
        validation: [],
        blockers: [],
        risks: [],
        open_threads: [],
        next_actions: [],
      }),
      "utf8",
    );
    await writeFile(path.join(dataDir, "handoffs", "corrupt.json"), "{not-json", "utf8");

    const packets = await view.readContinuityPackets();
    expect(packets.records).toHaveLength(1);
    expectPartial(packets, "continuity", ".seedrop/view/continuity/corrupt.json", "invalid_json");

    const runs = await view.readRuns();
    expect(runs.records.map((record) => record.run_id)).toContain(run.run.run_id);
    expectPartial(runs, "runs", ".seedrop/view/runs/corrupt.json", "invalid_json");

    const tasks = await view.readTasks();
    expect(tasks.records.map((record) => record.task_id)).toContain(task.task_id);
    expectPartial(tasks, "tasks", ".seedrop/view/tasks/corrupt.json", "schema_validation");

    const signals = await view.readSignals({ includeExpired: true });
    expect(signals.records.map((record) => record.id)).toContain(signal.id);
    expectPartial(signals, "signals", ".seedrop/view/signals/corrupt.json", "invalid_json");

    const handoffs = await view.readHandoffs();
    expect(handoffs.records.map((record) => record.handoff_id)).toContain(handoffId);
    expectPartial(handoffs, "handoffs", ".seedrop/view/handoffs/corrupt.json", "invalid_json");
  });

  it("salvages valid signal archive entries and diagnoses a corrupt entry by JSON pointer", async () => {
    const archivePath = path.join(root, ".seedrop", "view", "signals-archive.json");
    const valid = {
      id: randomUUID(),
      type: "claim",
      target: "space/src/view.ts",
      owner: "codex",
      created_at: "2026-08-09T05:00:00.000Z",
      expires_at: "2026-08-09T05:30:00.000Z",
      intent: "valid archived signal",
      archived_at: "2026-08-09T06:00:00.000Z",
    };
    await writeFile(archivePath, JSON.stringify([valid, { ...valid, id: "not-a-uuid" }]), "utf8");

    const result = await view.readArchivedSignals();
    expect(result.records).toEqual([valid]);
    expectPartial(result, "signals_archive", ".seedrop/view/signals-archive.json#/1", "schema_validation");
  });

  it("keeps legacy list callers compatible but makes partial reads visible on stderr", async () => {
    await view.createTask({ title: "valid task" });
    await writeFile(path.join(root, ".seedrop", "view", "tasks", "corrupt.json"), "{not-json", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await view.listTasks()).toHaveLength(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("tasks artifact .seedrop/view/tasks/corrupt.json"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("classifies forward schema versions separately from malformed JSON", async () => {
    const filePath = path.join(root, ".seedrop", "view", "tasks", "future.json");
    await writeFile(filePath, JSON.stringify({ schema_version: "99.0", task_id: randomUUID() }), "utf8");

    expectPartial(await view.readTasks(), "tasks", ".seedrop/view/tasks/future.json", "unsupported_schema_version");
  });

  it("does not convert exact task corruption into TaskNotFound", async () => {
    const taskId = randomUUID();
    await writeFile(path.join(root, ".seedrop", "view", "tasks", `${taskId}.json`), "{not-json", "utf8");

    await expect(view.getTask(taskId)).rejects.toBeInstanceOf(WorkspaceViewParseError);
  });

  it("fails mutations closed when their governing family is partial", async () => {
    const corruptRun = path.join(root, ".seedrop", "view", "runs", "corrupt.json");
    await writeFile(corruptRun, "{not-json", "utf8");

    await expect(view.startRun({ goal: "must not start" })).rejects.toThrow(
      /Cannot start a run.*corrupt\.json/s,
    );
    expect((await view.readRuns()).records).toEqual([]);
  });

  it("never overwrites a corrupt manifest or signal archive during a mutating flow", async () => {
    const manifestPath = path.join(root, ".seedrop", "view", "manifest.json");
    await writeFile(manifestPath, "{broken-manifest", "utf8");
    await expect(view.init("replacement-must-not-be-written")).rejects.toBeInstanceOf(WorkspaceViewParseError);
    expect(await readFile(manifestPath, "utf8")).toBe("{broken-manifest");

    const archivePath = path.join(root, ".seedrop", "view", "signals-archive.json");
    await writeFile(archivePath, "{broken-archive", "utf8");
    const signal = await view.claimSignal({ target: "space/src/view.ts", intent: "expired", ttlMs: -1 });
    await expect(view.gcExpiredSignals({ graceMs: 0 })).rejects.toThrow(/Cannot append to the signal archive/);
    expect(await readFile(archivePath, "utf8")).toBe("{broken-archive");
    expect((await view.readSignals({ includeExpired: true })).records.map((record) => record.id)).toContain(signal.id);
  });
});

function expectPartial<T>(
  result: ArtifactReadResult<T>,
  family: ArtifactFamily,
  artifactPath: string,
  code: ArtifactReadResult<T>["diagnostics"][number]["code"],
): void {
  expect(result.completeness).toBe("partial");
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ family, path: artifactPath, code }),
  ]);
  expect(result.diagnostics[0]?.reason.length).toBeGreaterThan(0);
}
