import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView, WorkspaceViewValidationError } from "../src/view.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-"));
  now = new Date("2026-05-14T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(): WorkspaceView {
  return WorkspaceView.open({
    root,
    agent: "codex",
    now: () => now,
  });
}

describe("WorkspaceView", () => {
  it("syncs a flat, hash-backed manifest and recommended reads", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n');
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n");
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "tests", "index.test.ts"), "expect(true).toBe(true);\n");
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n");

    const manifest = await view().sync({ workspaceId: "demo" });

    expect(manifest.workspace_id).toBe("demo");
    expect(manifest.files.map((file) => file.path)).toEqual([
      "package.json",
      "README.md",
      "src/index.ts",
      "tests/index.test.ts",
    ]);
    expect(manifest.files.find((file) => file.path === "README.md")?.kind).toBe("doc");
    expect(manifest.files.find((file) => file.path === "src/index.ts")?.kind).toBe("source");
    expect(manifest.files.find((file) => file.path === "tests/index.test.ts")?.kind).toBe("test");
    expect(manifest.recommended_reads).toEqual([
      { path: "README.md", reason: "Project overview", priority: 1 },
      { path: "package.json", reason: "Package metadata and scripts", priority: 2 },
    ]);

    const stored = JSON.parse(await readFile(path.join(root, ".seedrop", "view", "manifest.json"), "utf8"));
    expect(stored.files[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("logs continuity and assembles the active context", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();

    const packet = await view().log({
      mission: "harden workspace view",
      summary: "Added continuity packets.",
      decisions: ["Use flat manifest records."],
      openThreads: ["Add MCP adapter later."],
      validation: { status: "passed", commands: ["npm test"] },
      changedPaths: ["src/view.ts"],
    });

    const context = await view().context();

    expect(context.brief?.workspace?.id).toBe(path.basename(root));
    expect(context.latest_continuity?.id).toBe(packet.id);
    expect(context.open_threads).toEqual([
      {
        thread: "Add MCP adapter later.",
        packet_id: packet.id,
        created_at: "2026-05-14T10:00:00.000Z",
        source: "legacy_continuity",
      },
    ]);
    expect(context.active_signals).toEqual([]);
    expect(existsSync(path.join(root, ".seedrop", "view", "audit.json"))).toBe(false);
  });

  it("claims, hides expired, audits, and releases signal leases", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();

    const signal = await view().claimSignal({
      target: "src/view.ts",
      intent: "Refactor manifest handling",
      ttlMs: 1000,
      recovery: "Remove if expired.",
    });

    expect(await view().listSignals()).toHaveLength(1);

    now = new Date("2026-05-14T10:00:02.000Z");
    expect(await view().listSignals()).toHaveLength(0);
    expect(await view().listSignals({ includeExpired: true })).toHaveLength(1);

    const audit = await view().audit();
    expect(audit.issues).toContainEqual({
      severity: "warning",
      code: "signal_expired",
      message: `Signal ${signal.id} has expired and should be released or renewed.`,
      path: "src/view.ts",
    });

    const released = await view().releaseSignal({ id: signal.id });
    expect(released).toEqual([signal]);
    expect(await view().listSignals({ includeExpired: true })).toEqual([]);
  });

  it("reports manifest drift without failing the whole audit for warnings", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await writeFile(path.join(root, "README.md"), "# Changed\n");
    await writeFile(path.join(root, "new.txt"), "new\n");

    const audit = await view().audit();

    expect(audit.ok).toBe(true);
    expect(audit.issues).toEqual(
      expect.arrayContaining([
        {
          severity: "warning",
          code: "file_hash_changed",
          message: "File content changed since the last manifest sync.",
          path: "README.md",
        },
        {
          severity: "warning",
          code: "file_missing_from_manifest",
          message: "File exists on disk but is not listed in the manifest.",
          path: "new.txt",
        },
      ]),
    );
  });

  it("reports a missing manifest as an audit error", async () => {
    const audit = await view().audit();

    expect(audit).toMatchObject({
      ok: false,
      issues: [{ severity: "error", code: "manifest_missing", message: "Workspace manifest is missing." }],
    });
    expect(audit.next_actions?.[0]?.command).toBe("seed view sync");
  });

  it("validates stored manifests before returning them", async () => {
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "manifest.json"),
      JSON.stringify({
        schema_version: "1.0",
        workspace_id: "demo",
        root: ".",
        updated_at: "not-a-date",
        files: [],
        recommended_reads: [],
      }),
    );

    await expect(view().readManifest()).rejects.toBeInstanceOf(WorkspaceViewValidationError);
  });

  it("builds brief and context packets without crashing when view is absent", async () => {
    const brief = await view().brief();
    const context = await view().context();

    expect(brief.view.present).toBe(false);
    expect(brief.next_actions.map((action) => action.command)).toContain("seed bootstrap");
    expect(context.view?.present).toBe(false);
    expect(context.next_actions?.map((action) => action.command)).toContain("seed bootstrap");
    expect(existsSync(path.join(root, ".seedrop", "view"))).toBe(false);
  });

  it("journals a run from start through validation and finish", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();

    const started = await view().startRun({ goal: "ship view continuity" });
    expect(started.run.status).toBe("in_progress");

    await view().logRun({ summary: "Added run APIs.", changedPaths: ["src/view.ts"] });
    await view().decideRun("Keep claims advisory in v1.");
    await view().threadRun("Add MCP resources later.");
    const verified = await view().verifyRun({ command: "npm test", status: "passed" });

    expect(verified.validation).toEqual([
      { command: "npm test", status: "passed", recorded_at: "2026-05-14T10:00:00.000Z" },
    ]);
    expect(verified.changed_paths).toEqual(["src/view.ts"]);

    const finished = await view().finishRun({ status: "completed" });
    expect(finished.status).toBe("completed");
    expect(finished.finished_at).toBe("2026-05-14T10:00:00.000Z");
  });

  it("warns instead of starting a second active run for the same agent", async () => {
    await view().startRun({ goal: "first" });
    const second = await view().startRun({ goal: "second" });

    expect(second.run.goal).toBe("first");
    expect(second.warnings[0]).toContain("Active run already exists");
    expect(await view().listRuns()).toHaveLength(1);

    const forced = await view().startRun({ goal: "second", newRun: true });
    expect(forced.run.goal).toBe("second");
    expect(await view().listRuns()).toHaveLength(2);
  });

  it("creates, lists, reads, and accepts structured handoffs", async () => {
    await view().startRun({ goal: "handoff test" });
    await view().logRun({ summary: "Touched view.", changedPaths: ["src/view.ts"] });
    await view().threadRun("Recipient should run tests.");
    await view().verifyRun({ command: "npm test", status: "passed" });

    const handoff = await view().createHandoff({
      to: "claude",
      summary: "Continue validation.",
      risks: ["One route remains untested."],
    });

    expect(handoff.files_changed).toEqual(["src/view.ts"]);
    expect(handoff.validation[0]?.command).toBe("npm test");
    expect((await view().listHandoffs()).map((item) => item.handoff_id)).toEqual([handoff.handoff_id]);
    expect((await view().readHandoff(handoff.handoff_id.slice(0, 8))).summary).toBe("Continue validation.");

    const accepted = await view().acceptHandoff(handoff.handoff_id, "claude");
    expect(accepted.status).toBe("accepted");
    expect(accepted.accepted_by).toBe("claude");
  });

  it("preflight detects stale manifests, active runs, pending handoffs, and malformed policy", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await writeFile(path.join(root, "README.md"), "# Changed\n");
    await view().startRun({ goal: "preflight check" });
    await view().createHandoff({ to: "codex", summary: "Review me." });
    await writeFile(path.join(root, ".seedrop", "view", "policy.json"), "{bad json");

    const report = await view().preflight();

    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(["manifest_freshness", "active_run", "pending_handoffs", "policy"]),
    );
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["manifest_stale", "active_run", "policy_invalid"]),
    );
  });

  it("audit reports malformed run and handoff artifacts", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await mkdir(path.join(root, ".seedrop", "view", "runs"), { recursive: true });
    await mkdir(path.join(root, ".seedrop", "view", "handoffs"), { recursive: true });
    await writeFile(path.join(root, ".seedrop", "view", "runs", "bad.json"), "{}");
    await writeFile(path.join(root, ".seedrop", "view", "handoffs", "bad.json"), "{}");

    const audit = await view().audit();

    expect(audit.ok).toBe(false);
    expect(audit.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["runs_malformed", "handoffs_malformed"]));
  });
});
