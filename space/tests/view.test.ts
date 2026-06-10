import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRunDirtyTreeError, WorkspaceRunUnloggedChangesError, WorkspaceView, WorkspaceViewValidationError, findProseBlockerCandidates } from "../src/view.js";

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

/**
 * Stage a path so `git status --porcelain` reports it as tracked (`A `
 * / `M `) rather than untracked (`??`). Needed for tests that exercise
 * the run-finish dirty-tree gate, which now only blocks on tracked
 * changes (task f3fc8250).
 */
function gitAdd(dir: string, ...paths: string[]): void {
  spawnSync("git", ["-C", dir, "add", ...paths]);
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

  it("drops files larger than the hash cap from the manifest", async () => {
    // Manifests are an orientation tool, not a backup index. Files over
    // 50MB crash readFile past Node's 2 GiB cap and are almost never useful
    // for orientation. They should be silently excluded.
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    // Allocate a 51MB sparse file via truncate (no actual bytes written).
    const big = path.join(root, "huge.bin");
    spawnSync("dd", ["if=/dev/zero", `of=${big}`, "bs=1m", "count=51"], { stdio: "ignore" });
    const manifest = await view().sync({ workspaceId: "demo" });
    expect(manifest.files.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("skips unreadable subdirectories instead of aborting the whole scan", async () => {
    // Repro of #21: `seed view sync` against ~/.seedrop/view crashed on
    // EPERM when the walker hit $HOME/.Trash. The fix: skip EPERM/EACCES/
    // ENOENT and continue, so unreadable subtrees do not nuke the manifest.
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n");
    const unreadable = path.join(root, "blocked");
    await mkdir(unreadable);
    await writeFile(path.join(unreadable, "secret.txt"), "noise\n");
    spawnSync("chmod", ["000", unreadable]);

    try {
      const manifest = await view().sync({ workspaceId: "demo" });
      expect(manifest.files.map((file) => file.path)).toEqual(["README.md", "src/index.ts"]);
    } finally {
      spawnSync("chmod", ["755", unreadable]);
    }
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
        id: expect.stringMatching(/^[0-9a-f]{12}$/),
        thread: "Add MCP adapter later.",
        packet_id: packet.id,
        created_at: "2026-05-14T10:00:00.000Z",
        source: "legacy_continuity",
      },
    ]);
    expect(context.active_signals).toEqual([]);
    expect(existsSync(path.join(root, ".seedrop", "view", "audit.json"))).toBe(false);
  });

  it("updates .seedrop/view/AGENTS.md when logging continuity", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();

    await view("codex").log({
      mission: "ship generated entrypoint",
      summary: "Rendered ambient context for new agents.",
      validation: { status: "passed", commands: ["npm test"] },
      changedPaths: ["space/src/view.ts"],
    });

    const generated = await readFile(path.join(root, ".seedrop", "view", "AGENTS.md"), "utf8");
    expect(generated).toContain("# Seedrop View");
    expect(generated).toContain("## Latest Continuity");
    expect(generated).toContain("agent: codex");
    expect(generated).toContain("mission: ship generated entrypoint");
    expect(generated).toContain("space/src/view.ts");
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

  it("supports dry-run and expired-only signal release while guarding broad active cleanup", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();

    const active = await view().claimSignal({
      target: "src/active.ts",
      intent: "Active work",
      ttlMs: 10_000,
    });
    const expired = await view().claimSignal({
      target: "src/expired.ts",
      intent: "Expired work",
      ttlMs: 1_000,
    });

    now = new Date("2026-05-14T10:00:02.000Z");

    const preview = await view().releaseSignal({ owner: "codex", expiredOnly: true, dryRun: true });
    expect(preview).toEqual([expired]);
    expect(await view().listSignals({ includeExpired: true })).toHaveLength(2);

    const releasedExpired = await view().releaseSignal({ owner: "codex", expiredOnly: true });
    expect(releasedExpired).toEqual([expired]);
    expect(await view().listSignals({ includeExpired: true })).toEqual([active]);

    await expect(view().releaseSignal({ owner: "codex" })).rejects.toThrow(/Refusing to release active signals/);
    expect(await view().listSignals({ includeExpired: true })).toEqual([active]);

    const releasedActive = await view().releaseSignal({ owner: "codex", force: true });
    expect(releasedActive).toEqual([active]);
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

  it("audit warns when knowledge markdown is marked superseded", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await writeFile(
      path.join(root, ".seedrop", "view", "knowledge", "mcp-cli-coverage.md"),
      [
        "---",
        "status: superseded",
        "updated_at: 2026-05-19T00:00:00.000Z",
        "superseded_by: mcp/src/coverage.ts",
        "validated_by: npm test --workspace @seedrop/mcp -- coverage.test.ts",
        "---",
        "# MCP CLI coverage",
        "Old coverage notes.",
        "",
      ].join("\n"),
    );

    const audit = await view().audit();

    expect(audit.ok).toBe(true);
    expect(audit.issues).toContainEqual({
      severity: "warning",
      code: "knowledge_superseded",
      message: "Knowledge file is marked superseded and should not drive current decisions.",
      path: "knowledge/mcp-cli-coverage.md",
    });
    expect(audit.checks?.find((check) => check.id === "knowledge_freshness")).toMatchObject({
      status: "warn",
      details: {
        files: [
          {
            path: "knowledge/mcp-cli-coverage.md",
            status: "superseded",
            superseded_by: "mcp/src/coverage.ts",
          },
        ],
      },
    });
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

  it("preflight surfaces prose-only blockers with a seed task update recovery", async () => {
    const blocker = await view().createTask({ title: "Add seed task update command" });
    const blocked = await view().createTask({
      title: "Lint prose-only blockers",
      description: `Sequence after or coordinate with ${blocker.task_id.slice(0, 8)} so the recovery points at a real command.`,
    });

    const report = await view().preflight();
    const check = report.checks.find((c) => c.id === "task_prose_blockers");
    expect(check?.status).toBe("warn");
    const details = (check?.details ?? {}) as { tasks?: Array<{ task_id: string; missing: string[] }> };
    expect(details.tasks?.[0]?.task_id).toBe(blocked.task_id);
    expect(details.tasks?.[0]?.missing).toEqual([blocker.task_id]);
    expect(report.issues.map((i) => i.code)).toContain("task_prose_blockers");
    const action = report.next_actions.find((a) => a.command?.startsWith("seed task update"));
    expect(action?.command).toBe(`seed task update ${blocked.task_id.slice(0, 8)} --blocked-by ${blocker.task_id.slice(0, 8)}`);
  });

  it("preflight does not flag prose blockers once blocked_by is encoded", async () => {
    const blocker = await view().createTask({ title: "Add seed task update command" });
    await view().createTask({
      title: "Lint prose-only blockers",
      description: `Depends on ${blocker.task_id.slice(0, 8)}.`,
      blockedBy: [blocker.task_id],
    });
    const report = await view().preflight();
    const check = report.checks.find((c) => c.id === "task_prose_blockers");
    expect(check?.status).toBe("pass");
  });

  it("preflight does not flag prose blockers that name an already-done blocker", async () => {
    const blocker = await view().createTask({ title: "Already shipped" });
    await view().claimTask(blocker.task_id);
    await view().startTask(blocker.task_id);
    await view().doneTask(blocker.task_id);
    await view().createTask({
      title: "References the done work",
      description: `Depends on ${blocker.task_id.slice(0, 8)} (already shipped).`,
    });
    const report = await view().preflight();
    expect(report.checks.find((c) => c.id === "task_prose_blockers")?.status).toBe("pass");
  });

  it("preflight ignores prose blockers in done or dropped tasks", async () => {
    const blocker = await view().createTask({ title: "blocker" });
    const t = await view().createTask({
      title: "blocked",
      description: `gated on ${blocker.task_id.slice(0, 8)}`,
    });
    await view().claimTask(t.task_id);
    await view().dropTask({ taskId: t.task_id, reason: "no longer relevant" });
    const report = await view().preflight();
    expect(report.checks.find((c) => c.id === "task_prose_blockers")?.status).toBe("pass");
  });

  it("findProseBlockerCandidates extracts ids near dependency phrases and ignores noise", () => {
    expect(findProseBlockerCandidates("Blocked by 8007f31c — must land first.")).toEqual(["8007f31c"]);
    expect(findProseBlockerCandidates("Depends on 8007f31c-d4ee-4705-8b23-2719b158a132 (full uuid).")).toEqual([
      "8007f31c-d4ee-4705-8b23-2719b158a132",
    ]);
    expect(findProseBlockerCandidates("Sequence after 8007f31c. Also gated on 1b8676dc.")).toEqual([
      "8007f31c",
      "1b8676dc",
    ]);
    // Vague phrases without an id near them shouldn't match.
    expect(findProseBlockerCandidates("After the audit lands we should revisit this.")).toEqual([]);
    // The id is too far from the phrase (>80 chars).
    expect(
      findProseBlockerCandidates(
        "blocked by something abstract that goes on and on with lots of filler text padding way past eighty characters before 8007f31c shows up at the end",
      ),
    ).toEqual([]);
    expect(findProseBlockerCandidates(undefined)).toEqual([]);
    expect(findProseBlockerCandidates("")).toEqual([]);
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

  it("finishRun refuses status=completed when tracked changed_paths are uncommitted", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    gitAdd(root, "README.md"); // tracked (staged) — the gate fires
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
    gitAdd(root, "README.md");
    await view().sync();
    await view().startRun({ goal: "test force" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });

    const run = await view().finishRun({ status: "completed", force: true });
    expect(run.status).toBe("completed");
  });

  it("finishRun allows status=blocked even with uncommitted changed_paths", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    gitAdd(root, "README.md");
    await view().sync();
    await view().startRun({ goal: "test blocked" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });

    const run = await view().finishRun({ status: "blocked" });
    expect(run.status).toBe("blocked");
  });

  it("finishRun refuses status=completed when tree has tracked changes and run logged none", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    gitAdd(root, "README.md"); // tracked-dirty
    await view().sync();
    await view().startRun({ goal: "test unlogged" });
    // No logRun call — run.changed_paths stays empty while README.md is tracked-dirty in git.

    await expect(view().finishRun({ status: "completed" })).rejects.toThrow(WorkspaceRunUnloggedChangesError);

    const runs = await view().listRuns();
    expect(runs.at(-1)?.status).toBe("in_progress");
  });

  it("finishRun allows force=true to bypass the unlogged-changes gate", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    gitAdd(root, "README.md");
    await view().sync();
    await view().startRun({ goal: "test force" });

    const run = await view().finishRun({ status: "completed", force: true });
    expect(run.status).toBe("completed");
  });

  it("finishRun allows status=blocked when tree is dirty with no logged changes", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    gitAdd(root, "README.md");
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

  it("finishRun ignores untracked-only noise (f3fc8250)", async () => {
    gitInit(root);
    // Establish a committed baseline so HEAD exists; subsequent untracked
    // files are real "noise" (scratch notes, build artifacts) that should
    // not block run completion.
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    gitCommitAll(root, "init");
    // An untracked scratch file the user left lying around — git status
    // reports it as `??`, the new split gate classifies it as noise.
    await writeFile(path.join(root, "scratch.md"), "# scratch notes\n");
    await view().sync();
    await view().startRun({ goal: "test untracked-only" });
    // No changed_paths logged AND no tracked dirty files — should pass.
    const run = await view().finishRun({ status: "completed" });
    expect(run.status).toBe("completed");
  });

  it("finishRun ignores untracked noise even when run logged changed_paths (f3fc8250)", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    gitCommitAll(root, "init");
    // The actual run's paths are clean in git, but an unrelated untracked
    // scratch file is sitting in the worktree. The old gate would have
    // refused on `paths.length > 0`; the new split gate ignores untracked.
    await writeFile(path.join(root, "scratch.md"), "# scratch\n");
    await view().sync();
    await view().startRun({ goal: "test untracked-noise" });
    await view().logRun({ summary: "step", changedPaths: ["README.md"] });
    const run = await view().finishRun({ status: "completed" });
    expect(run.status).toBe("completed");
  });

  it("brief.success caps below L4 when run changed_paths are tracked-uncommitted", async () => {
    gitInit(root);
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
    gitAdd(root, "README.md", "package.json"); // tracked-dirty
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

  describe("open threads list/resolve", () => {
    it("lists open threads from continuity packets with stable ids", async () => {
      await view().log({ mission: "m", summary: "s", openThreads: ["alpha thread", "beta thread"] });
      const list = await view().listThreads();
      expect(list.open).toHaveLength(2);
      const ids = list.open.map((t) => t.id);
      expect(ids.every((id) => /^[0-9a-f]{12}$/.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(2);
      // ids are deterministic across reads
      const again = await view().listThreads();
      expect(again.open.map((t) => t.id)).toEqual(ids);
    });

    it("resolves a thread by id prefix and suppresses it from open threads", async () => {
      await view().log({ mission: "m", summary: "s", openThreads: ["keep me", "resolve me"] });
      const before = await view().listThreads();
      const target = before.open.find((t) => t.thread === "resolve me");
      expect(target).toBeDefined();
      const result = await view().resolveThread({ idPrefix: target!.id.slice(0, 6), note: "done" });
      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0].thread).toBe("resolve me");

      const after = await view().listThreads({ includeResolved: true });
      expect(after.open.map((t) => t.thread)).toEqual(["keep me"]);
      expect(after.resolved.map((t) => t.thread)).toEqual(["resolve me"]);
      expect(after.resolved[0].note).toBe("done");

      // context() reflects the suppression too
      const context = await view().context();
      expect(context.open_threads.map((t) => t.thread)).toEqual(["keep me"]);
    });

    it("rejects short prefixes, no-match, and ambiguous prefixes", async () => {
      await view().log({ mission: "m", summary: "s", openThreads: ["x"] });
      await expect(view().resolveThread({ idPrefix: "ab" })).rejects.toThrow(/too short/i);
      await expect(view().resolveThread({ idPrefix: "ffffffff" })).rejects.toThrow(/No open thread/i);
    });

    it("is idempotent — resolving an already-resolved thread does not duplicate the ledger", async () => {
      await view().log({ mission: "m", summary: "s", openThreads: ["only"] });
      const { open } = await view().listThreads();
      const id = open[0].id;
      await view().resolveThread({ idPrefix: id });
      await view().resolveThread({ idPrefix: id });
      const after = await view().listThreads({ includeResolved: true });
      expect(after.resolved).toHaveLength(1);
    });
  });
});

describe("context byte budget (fc8b8b30)", () => {
  async function seedFatView(): Promise<void> {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync({ workspaceId: "budget-demo" });
    const longText = "x".repeat(1200);
    for (let i = 0; i < 12; i += 1) {
      await view().createTask({ title: `Task ${i}`, description: longText });
    }
    await view().log({
      mission: "budget fixture",
      summary: longText,
      decisions: Array.from({ length: 6 }, (_, i) => `decision ${i}: ${"y".repeat(120)}`),
      openThreads: Array.from({ length: 8 }, (_, i) => `thread ${i}: ${"z".repeat(120)}`),
      validation: { status: "passed", commands: ["npm test"] },
    });
  }

  it("summarizes the manifest and never inlines the file list", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync({ workspaceId: "budget-demo" });

    const context = await view().context();

    expect(context.manifest?.workspace_id).toBe("budget-demo");
    expect(context.manifest?.files_count).toBeGreaterThan(0);
    expect((context.manifest as unknown as { files?: unknown }).files).toBeUndefined();
    expect(context.manifest?.files_note).toContain("manifest.json");
  });

  it("applies trim stages until the payload fits and records them", async () => {
    await seedFatView();

    const context = await view().context({ budgetBytes: 4096 });

    expect(context.budget).toBeDefined();
    expect(context.budget?.limit_bytes).toBe(4096);
    expect(context.budget?.stages_applied).toContain("task_descriptions_truncated");
    const description = context.active_tasks?.[0]?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(160);
    expect(context.budget?.bytes).toBeLessThanOrEqual(4096);
    expect(context.budget?.exceeded).toBe(false);
  });

  it("reports exceeded honestly when stages cannot reach the limit", async () => {
    await seedFatView();

    const context = await view().context({ budgetBytes: 64 });

    expect(context.budget?.exceeded).toBe(true);
    expect(context.budget?.stages_applied.length).toBeGreaterThan(0);
  });

  it("budgetBytes 0 disables trimming entirely", async () => {
    await seedFatView();

    const context = await view().context({ budgetBytes: 0 });

    expect(context.budget).toBeUndefined();
    expect((context.active_tasks?.[0]?.description ?? "").length).toBe(1200);
    expect(context.manifest?.files_count).toBeGreaterThan(0);
  });
});

describe("signal GC (1eeadcf3)", () => {
  it("keeps expired signals live during the grace period", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().claimSignal({ target: "README.md", intent: "short claim", ttlMs: 1000 });

    now = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h later: expired, within grace
    await view().sync();

    expect(await view().listSignals({ includeExpired: true })).toHaveLength(1);
    expect(await view().listArchivedSignals()).toHaveLength(0);
  });

  it("archives signals expired beyond the grace period and clears audit warnings", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    const claim = await view().claimSignal({ target: "README.md", intent: "old claim", ttlMs: 1000 });

    now = new Date(now.getTime() + 26 * 60 * 60 * 1000); // past expiry + 24h grace
    await view().sync();

    expect(await view().listSignals({ includeExpired: true })).toHaveLength(0);
    const archived = await view().listArchivedSignals();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ id: claim.id, intent: "old claim" });
    expect(archived[0]?.archived_at).toBeTruthy();

    const audit = await view().audit();
    expect(audit.issues.filter((issue) => issue.code === "signal_expired")).toHaveLength(0);
  });

  it("gc is explicit and reads never sweep", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().claimSignal({ target: "README.md", intent: "stale claim", ttlMs: 1000 });

    now = new Date(now.getTime() + 26 * 60 * 60 * 1000);
    // Read-only surfaces must not mutate state.
    await view().listSignals({ includeExpired: true });
    await view().context();
    expect(await view().listSignals({ includeExpired: true })).toHaveLength(1);

    const swept = await view().gcExpiredSignals();
    expect(swept).toHaveLength(1);
    expect(await view().listSignals({ includeExpired: true })).toHaveLength(0);
  });
});

describe("run claim lifecycle (57e37682)", () => {
  it("archives the run's own claims on completed finish", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    const { run } = await view().startRun({ goal: "edit readme", claim: ["README.md"] });
    await view().logRun({ summary: "done", changedPaths: [] });

    expect(await view().listSignals()).toHaveLength(1);
    await view().finishRun({ status: "completed" });

    expect(await view().listSignals({ includeExpired: true })).toHaveLength(0);
    const archived = await view().listArchivedSignals();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ target: "README.md", details: { run_id: run.run_id } });
    expect(archived[0]?.archived_at).toBeTruthy();
  });

  it("releases claims on blocked and failed finishes too", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "stuck work", claim: ["README.md"] });
    await view().finishRun({ status: "blocked" });

    expect(await view().listSignals({ includeExpired: true })).toHaveLength(0);
    expect(await view().listArchivedSignals()).toHaveLength(1);
  });

  it("leaves other agents' and unrelated claims alone", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    const other = WorkspaceView.open({ root, agent: "claude", now: () => now });
    await other.claimSignal({ target: "README.md", intent: "claude reviewing readme" });
    await view().claimSignal({ target: "docs/guide.md", intent: "codex manual claim, no run" });

    await view().startRun({ goal: "edit readme", claim: ["src/index.ts"] });
    await view().finishRun({ status: "completed" });

    const live = await view().listSignals({ includeExpired: true });
    expect(live.map((s) => s.target).sort()).toEqual(["README.md", "docs/guide.md"]);
    expect((await view().listArchivedSignals()).map((s) => s.target)).toEqual(["src/index.ts"]);
  });

  it("releases pre-stamp claims via the intent prefix fallback", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    const { run } = await view().startRun({ goal: "legacy claims" });
    // Simulate a claim created before details.run_id stamping existed.
    await view().claimSignal({ target: "README.md", intent: `run ${run.run_id.slice(0, 8)}: legacy claims` });

    await view().finishRun({ status: "completed" });

    expect(await view().listSignals({ includeExpired: true })).toHaveLength(0);
    expect(await view().listArchivedSignals()).toHaveLength(1);
  });
});
