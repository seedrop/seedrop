import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRunDirtyTreeError, WorkspaceRunUnloggedChangesError, WorkspaceView, WorkspaceViewValidationError } from "../src/view.js";

function gitInit(dir: string): void {
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "config", "user.email", "t@t.test"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "t"]);
  spawnSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

function gitCommitAll(dir: string, message: string): void {
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "commit", "-q", "-m", message]);
}

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

  it("applies policy ignores, path purposes, recommended reads, and success requirements", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
    await writeFile(path.join(root, ".DS_Store"), "noise\n");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "view.ts"), "export const ok = true;\n");
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "policy.json"),
      JSON.stringify({
        purpose: "Demo orientation substrate.",
        current_focus: "Keep View useful.",
        required_success_level: "L2",
        freshness_ttl_hours: 24,
        ignore: [".DS_Store"],
        path_purposes: {
          "README.md": {
            purpose: "Human overview.",
            confidence: 0.9,
            recommended_read_reason: "Start here",
            recommended_read_priority: 1,
          },
          "src/": {
            purpose: "Source tree.",
            confidence: 0.8,
          },
          "src/view.ts": {
            purpose: "View implementation.",
            owner: "space",
            confidence: 0.95,
          },
        },
      }),
    );

    const manifest = await view().sync({ workspaceId: "demo" });
    const brief = await view().brief();
    const preflight = await view().preflight();

    expect(manifest.files.map((file) => file.path)).toEqual(["package.json", "README.md", "src/view.ts"]);
    expect(manifest.files.find((file) => file.path === "README.md")?.purpose).toBe("Human overview.");
    expect(manifest.files.find((file) => file.path === "src/view.ts")).toMatchObject({
      purpose: "View implementation.",
      owner: "space",
      confidence: 0.95,
    });
    expect(manifest.path_purposes?.map((entry) => entry.path)).toEqual(["README.md", "src/", "src/view.ts"]);
    expect(manifest.recommended_reads[0]).toEqual({ path: "README.md", reason: "Project overview", priority: 1 });
    expect(brief.success).toMatchObject({ level: "L2", required_level: "L2", meets_required: true });
    expect(preflight.checks.find((check) => check.id === "view_success")).toMatchObject({ status: "pass" });
  });

  it("sync throws WorkspaceViewValidationError when policy.json has unknown keys", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "policy.json"),
      JSON.stringify({
        purpose: "Demo.",
        path_purposes: {
          "README.md": { purpose: "overview", kind: "doc" },
        },
      }),
    );

    await expect(view().sync()).rejects.toThrow(WorkspaceViewValidationError);
  });

  it("sync throws WorkspaceViewParseError when policy.json is malformed JSON", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(path.join(root, ".seedrop", "view", "policy.json"), "{bad json");

    await expect(view().sync()).rejects.toThrow(/policy\.json/);
  });

  it("brief surfaces a policy_invalid next_action instead of advising to create one", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(path.join(root, ".seedrop", "view", "policy.json"), "{bad json");

    const brief = await view().brief();
    const reasons = brief.next_actions.map((action) => action.reason ?? "");

    expect(reasons.some((r) => /policy\.json is invalid/i.test(r))).toBe(true);
    expect(reasons.some((r) => /No repo policy is present/i.test(r))).toBe(false);
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

  it("finishRun refuses status=completed when changed_paths are uncommitted", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "test dirty gate" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });

    await expect(view().finishRun({ status: "completed" })).rejects.toThrow(WorkspaceRunDirtyTreeError);

    const runs = await view().listRuns();
    expect(runs.at(-1)?.status).toBe("in_progress");
  });

  it("finishRun allows force=true to bypass the dirty-tree gate", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "test force" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });

    const run = await view().finishRun({ status: "completed", force: true });
    expect(run.status).toBe("completed");
  });

  it("finishRun allows status=blocked even with uncommitted changed_paths", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "test blocked" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });

    const run = await view().finishRun({ status: "blocked" });
    expect(run.status).toBe("blocked");
  });

  it("finishRun refuses status=completed when tree is dirty and run logged no changed_paths", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "test unlogged" });
    // No logRun call — run.changed_paths stays empty while README.md is dirty in git.

    await expect(view().finishRun({ status: "completed" })).rejects.toThrow(WorkspaceRunUnloggedChangesError);

    const runs = await view().listRuns();
    expect(runs.at(-1)?.status).toBe("in_progress");
  });

  it("finishRun allows force=true to bypass the unlogged-changes gate", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "test force" });

    const run = await view().finishRun({ status: "completed", force: true });
    expect(run.status).toBe("completed");
  });

  it("finishRun allows status=blocked when tree is dirty with no logged changes", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "test blocked-unlogged" });

    const run = await view().finishRun({ status: "blocked" });
    expect(run.status).toBe("blocked");
  });

  it("finishRun allows status=completed with empty changed_paths when tree is clean", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    gitCommitAll(root, "init");
    await view().sync();
    await view().startRun({ goal: "test clean-empty" });

    const run = await view().finishRun({ status: "completed" });
    expect(run.status).toBe("completed");
  });

  it("finishRun allows status=completed when changed_paths are clean in git", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    gitCommitAll(root, "init");
    await view().sync();
    await view().startRun({ goal: "test clean" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });

    const run = await view().finishRun({ status: "completed" });
    expect(run.status).toBe("completed");
  });

  it("brief.success caps below L4 when run changed_paths are uncommitted", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "policy.json"),
      JSON.stringify({
        purpose: "Demo.",
        current_focus: "Test the gate.",
        required_success_level: "L2",
      }),
    );
    await view().sync();
    await view().log({
      mission: "do stuff",
      summary: "did stuff",
      validation: { status: "passed", commands: ["npm test"] },
      changedPaths: ["README.md"],
      openThreads: ["follow up"],
    });
    await view().startRun({ goal: "test" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });

    const brief = await view().brief();
    expect(brief.success.level).not.toBe("L4");
    expect(brief.success.summary).toMatch(/uncommitted/i);
  });

  it("log() writes git_status reflecting the current dirty tree", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");

    const packet = await view().log({ mission: "m", summary: "s" });

    expect(packet.git_status?.is_repo).toBe(true);
    expect(packet.git_status?.is_dirty).toBe(true);
    expect(packet.git_status?.uncommitted_count).toBeGreaterThan(0);
    expect(packet.git_status?.uncommitted_paths).toEqual(expect.arrayContaining(["README.md"]));
  });

  it("log() writes git_status.is_repo=false when not in a git repo", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");

    const packet = await view().log({ mission: "m", summary: "s" });

    expect(packet.git_status?.is_repo).toBe(false);
    expect(packet.git_status?.is_dirty).toBe(false);
    expect(packet.git_status?.uncommitted_count).toBe(0);
  });

  it("init seeds .seedrop/view/knowledge/README.md when missing", async () => {
    await view().init("demo");
    const readmePath = path.join(root, ".seedrop", "view", "knowledge", "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const content = await readFile(readmePath, "utf8");
    expect(content).toMatch(/knowledge folder/i);
  });

  it("init does not overwrite an existing knowledge README", async () => {
    await mkdir(path.join(root, ".seedrop", "view", "knowledge"), { recursive: true });
    await writeFile(path.join(root, ".seedrop", "view", "knowledge", "README.md"), "custom\n");
    await view().init("demo");
    const content = await readFile(path.join(root, ".seedrop", "view", "knowledge", "README.md"), "utf8");
    expect(content).toBe("custom\n");
  });

  it("finishRun status=completed auto-syncs the manifest", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    gitCommitAll(root, "init");
    await view().sync();
    await view().startRun({ goal: "test auto-sync" });
    // Add a new file after sync — manifest is now stale.
    await writeFile(path.join(root, "NEW.md"), "added during run\n");

    const before = await view().readManifest();
    expect(before.files.map((f) => f.path)).not.toContain("NEW.md");

    // Commit so the dirty-tree gate doesn't fire.
    gitCommitAll(root, "add NEW");
    await view().logRun({ summary: "added NEW.md", changedPaths: ["NEW.md"] });
    await view().finishRun({ status: "completed" });

    const after = await view().readManifest();
    expect(after.files.map((f) => f.path)).toContain("NEW.md");
  });

  it("finishRun suggests a continuity packet when run was non-trivial and no packet was written", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    gitCommitAll(root, "init");
    await view().sync();
    await view().startRun({ goal: "test packet suggestion" });
    await view().logRun({ summary: "did stuff", changedPaths: ["README.md"] });

    const run = await view().finishRun({ status: "completed" });
    const reasons = run.next_actions.map((a) => a.reason ?? "");
    expect(reasons.some((r) => /Log a continuity packet/.test(r))).toBe(true);
  });

  it("finishRun does NOT suggest a packet when one was written during the run", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    gitCommitAll(root, "init");
    await view().sync();
    await view().startRun({ goal: "with packet" });
    await view().logRun({ summary: "step 1", changedPaths: ["README.md"] });
    // Advance time so the packet's created_at is after run.started_at
    now = new Date(now.getTime() + 1000);
    await view().log({ mission: "captured mid-run", summary: "wrote packet here" });

    const run = await view().finishRun({ status: "completed" });
    const reasons = run.next_actions.map((a) => a.reason ?? "");
    expect(reasons.some((r) => /Log a continuity packet/.test(r))).toBe(false);
  });

  it("brief surfaces git_status and a next_action when the tree is dirty (no run required)", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();

    const brief = await view().brief();

    expect(brief.git_status?.is_repo).toBe(true);
    expect(brief.git_status?.is_dirty).toBe(true);
    expect(brief.git_status?.uncommitted_count).toBeGreaterThan(0);
    const reasons = brief.next_actions.map((a) => a.reason ?? "");
    expect(reasons.some((r) => /uncommitted file/i.test(r))).toBe(true);
  });
});
