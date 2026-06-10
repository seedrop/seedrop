import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultPassportPath,
  defaultSpaceRoot,
  resolveCommand,
  runCli,
  type CommandDispatch,
  type CommandRunner,
} from "../src/index.js";
import { WorkspaceView } from "@seedrop/space";

describe("resolveCommand", () => {
  it("routes id commands to seed-id", () => {
    expect(resolveCommand(["id", "repair", "--passport", "passport.json"])).toEqual({
      command: "seed-id",
      args: ["repair", "--passport", "passport.json"],
    });
  });

  it("normalizes positional id repair/status passport paths", () => {
    expect(resolveCommand(["id", "repair", "passport.json", "--json"])).toEqual({
      command: "seed-id",
      args: ["repair", "--passport", "passport.json", "--json"],
    });
    expect(resolveCommand(["id", "status", "passport.json"])).toEqual({
      command: "seed-id",
      args: ["status", "--passport", "passport.json"],
    });
  });

  it("normalizes positional id validate/show/audit passport paths", () => {
    expect(resolveCommand(["id", "validate", "passport.json"])).toEqual({
      command: "seed-id",
      args: ["validate", "--passport", "passport.json"],
    });
    expect(resolveCommand(["id", "show", "passport.json", "--json"])).toEqual({
      command: "seed-id",
      args: ["show", "--passport", "passport.json", "--json"],
    });
    expect(resolveCommand(["id", "audit", "passport.json"])).toEqual({
      command: "seed-id",
      args: ["audit", "--passport", "passport.json"],
    });
  });

  it("passes id init through without passport normalization", () => {
    expect(resolveCommand(["id", "init", "--name", "codex"])).toEqual({
      command: "seed-id",
      args: ["init", "--name", "codex"],
    });
  });

  it("routes space commands to seed-space", () => {
    expect(resolveCommand(["space", "view", "context"])).toEqual({
      command: "seed-space",
      args: ["view", "context"],
    });
  });

  it("routes view commands through seed-space view", () => {
    expect(resolveCommand(["view", "context"])).toEqual({
      command: "seed-space",
      args: ["view", "context"],
    });
    expect(resolveCommand(["view", "brief", "--json"])).toEqual({
      command: "seed-space",
      args: ["view", "brief", "--json"],
    });
    expect(resolveCommand(["view", "preflight", "--json"])).toEqual({
      command: "seed-space",
      args: ["view", "preflight", "--json"],
    });
  });

  it("routes run commands through seed-space", () => {
    expect(resolveCommand(["run", "start", "--goal", "ship"])).toEqual({
      command: "seed-space",
      args: ["run", "start", "--goal", "ship"],
    });
  });

  it("composes view init with passport project linking", () => {
    expect(
      resolveCommand([
        "view",
        "init",
        "--root",
        "/tmp/demo",
        "--workspace-id",
        "demo-space",
        "--passport",
        "passport.json",
        "--role",
        "implementation",
        "--current-focus",
        "Sprint 2",
        "--space",
        "seedrop-team",
      ]),
    ).toEqual([
      {
        command: "seed-space",
        args: ["view", "init", "--root", "/tmp/demo", "--workspace-id", "demo-space"],
      },
      {
        command: "seed-id",
        args: [
          "project",
          "link",
          "--passport",
          "passport.json",
          "--id",
          "demo-space",
          "--root",
          resolve("/tmp/demo"),
          "--view",
          ".seedrop/view",
          "--role",
          "implementation",
          "--current-focus",
          "Sprint 2",
          "--space",
          "seedrop-team",
        ],
      },
    ]);
  });

  it("returns help for --help and -h", () => {
    expect(resolveCommand(["--help"])).toBe("help");
    expect(resolveCommand(["-h"])).toBe("help");
    expect(resolveCommand(["help"])).toBe("help");
  });

  it("bare `seed` resolves based on passport presence", async () => {
    // Isolate $HOME so dev-machine active-passport doesn't leak into the
    // precedence chain. Also cd to a scratch dir so resolveCommand's
    // cwd-view check doesn't find this repo's .seedrop/view.
    // Precedence: env > active > operator.
    const prior = { passport: process.env.SEEDROP_PASSPORT, home: process.env.HOME, cwd: process.cwd() };
    const scratch = await mkdtemp(join(tmpdir(), "seed-bare-test-"));
    process.env.HOME = join(scratch, "home");
    await mkdir(process.env.HOME, { recursive: true });
    process.env.SEEDROP_PASSPORT = "/nonexistent/__seed-test-no-passport__.json";
    process.chdir(scratch);
    try {
      expect(resolveCommand([])).toBe("help");
    } finally {
      process.chdir(prior.cwd);
      if (prior.passport === undefined) delete process.env.SEEDROP_PASSPORT;
      else process.env.SEEDROP_PASSPORT = prior.passport;
      if (prior.home !== undefined) process.env.HOME = prior.home;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("bare `seed` resolves boot when repo View exists even without a passport", async () => {
    const priorPassport = process.env.SEEDROP_PASSPORT;
    const priorCwd = process.cwd();
    const scratch = await mkdtemp(join(tmpdir(), "seed-view-router-test-"));
    process.env.SEEDROP_PASSPORT = "/nonexistent/__seed-test-no-passport__.json";
    await mkdir(join(scratch, ".seedrop", "view"), { recursive: true });
    process.chdir(scratch);
    try {
      expect(resolveCommand([])).toBe("boot");
    } finally {
      process.chdir(priorCwd);
      if (priorPassport === undefined) delete process.env.SEEDROP_PASSPORT;
      else process.env.SEEDROP_PASSPORT = priorPassport;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("recognizes setup, daemon, continuity, and id-list as orchestrated domains", () => {
    expect(resolveCommand(["init"])).toBe("init");
    expect(resolveCommand(["doctor"])).toBe("doctor");
    expect(resolveCommand(["bootstrap"])).toBe("bootstrap");
    expect(resolveCommand(["bootstrap", "--name", "x"])).toBe("bootstrap");
    expect(resolveCommand(["daemon", "status"])).toBe("daemon");
    expect(resolveCommand(["continuity"])).toBe("continuity");
    expect(resolveCommand(["focus"])).toBe("focus");
    expect(resolveCommand(["print-boot-protocol"])).toBe("boot-protocol");
    expect(resolveCommand(["id", "list"])).toBe("id-list");
    expect(resolveCommand(["clients", "scan"])).toBe("clients");
    expect(resolveCommand(["id", "show"])).toMatchObject({ command: "seed-id" });
  });

  it("defaults view init passport to the global path when omitted", () => {
    const plan = resolveCommand(["view", "init", "--root", "/tmp/x"]);
    expect(Array.isArray(plan)).toBe(true);
    const dispatches = plan as CommandDispatch[];
    expect(dispatches[1]?.command).toBe("seed-id");
    const idArgs = dispatches[1]?.args ?? [];
    const passportIdx = idArgs.indexOf("--passport");
    expect(passportIdx).toBeGreaterThanOrEqual(0);
    expect(idArgs[passportIdx + 1]).toBe(defaultPassportPath());
  });
});

describe("defaults", () => {
  it("honors SEEDROP_PASSPORT env when no active-passport state is set", async () => {
    // Isolate $HOME so any real active-passport.json on the dev machine
    // doesn't leak in. Precedence is now env > active > operator.
    const prior = { passport: process.env.SEEDROP_PASSPORT, home: process.env.HOME };
    const scratch = await mkdtemp(join(tmpdir(), "seed-defaults-test-"));
    process.env.HOME = join(scratch, "home");
    await mkdir(process.env.HOME, { recursive: true });
    process.env.SEEDROP_PASSPORT = "/tmp/custom-passport.json";
    try {
      expect(defaultPassportPath()).toBe("/tmp/custom-passport.json");
    } finally {
      if (prior.passport === undefined) delete process.env.SEEDROP_PASSPORT;
      else process.env.SEEDROP_PASSPORT = prior.passport;
      if (prior.home !== undefined) process.env.HOME = prior.home;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("honors SEEDROP_SPACE_ROOT env over home default", () => {
    const prior = process.env.SEEDROP_SPACE_ROOT;
    process.env.SEEDROP_SPACE_ROOT = "/tmp/custom-space";
    try {
      expect(defaultSpaceRoot()).toBe("/tmp/custom-space");
    } finally {
      if (prior === undefined) delete process.env.SEEDROP_SPACE_ROOT;
      else process.env.SEEDROP_SPACE_ROOT = prior;
    }
  });
});

describe("continuity", () => {
  let scratch: string;
  let envSnapshot: { passport?: string; spaceRoot?: string; spaceUrl?: string; home?: string };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seed-continuity-test-"));
    envSnapshot = {
      passport: process.env.SEEDROP_PASSPORT,
      spaceRoot: process.env.SEEDROP_SPACE_ROOT,
      spaceUrl: process.env.SEEDROP_SPACE_URL,
      home: process.env.HOME,
    };
    // Isolate $HOME so the dev machine's active-passport does not leak in.
    // SEEDROP_PASSPORT has precedence over active login in this process.
    process.env.HOME = join(scratch, "home");
    await mkdir(process.env.HOME, { recursive: true });
    process.env.SEEDROP_PASSPORT = join(scratch, "passport.json");
    process.env.SEEDROP_SPACE_URL = "http://127.0.0.1:1"; // intentionally unreachable
  });

  async function writePassport(agent = "x"): Promise<string> {
    const passportPath = process.env.SEEDROP_PASSPORT as string;
    await writeFile(
      passportPath,
      JSON.stringify({ schema_version: "1.0", agent_id: agent, name: agent, purpose: "t", active_projects: [] }),
      "utf8",
    );
    return passportPath;
  }

  async function writeManifest(root: string, workspaceId = "demo"): Promise<void> {
    await mkdir(join(root, ".seedrop", "view", "runs"), { recursive: true });
    await mkdir(join(root, ".seedrop", "view", "handoffs"), { recursive: true });
    await mkdir(join(root, ".seedrop", "view", "continuity"), { recursive: true });
    await mkdir(join(root, ".seedrop", "view", "signals"), { recursive: true });
    await writeFile(
      join(root, ".seedrop", "view", "manifest.json"),
      JSON.stringify({
        schema_version: "1.0",
        workspace_id: workspaceId,
        root: ".",
        updated_at: "2026-05-16T00:00:00.000Z",
        files: [],
        recommended_reads: [],
      }),
      "utf8",
    );
  }

  afterEach(async () => {
    if (envSnapshot.passport === undefined) delete process.env.SEEDROP_PASSPORT;
    else process.env.SEEDROP_PASSPORT = envSnapshot.passport;
    if (envSnapshot.spaceRoot === undefined) delete process.env.SEEDROP_SPACE_ROOT;
    else process.env.SEEDROP_SPACE_ROOT = envSnapshot.spaceRoot;
    if (envSnapshot.spaceUrl === undefined) delete process.env.SEEDROP_SPACE_URL;
    else process.env.SEEDROP_SPACE_URL = envSnapshot.spaceUrl;
    if (envSnapshot.home !== undefined) process.env.HOME = envSnapshot.home;
    await rm(scratch, { recursive: true, force: true });
  });

  it("renders graceful no-passport block", async () => {
    const io = createIo();
    const code = await runCli(["continuity"], io, fakeRunner());
    expect(code).toBe(0);
    const out = io.stdoutText();
    expect(out).toContain("# Continuity");
    expect(out).toContain("(no passport yet)");
    expect(out).toContain("seed bootstrap");
  });

  it("renders identity + warnings when passport exists but view absent", async () => {
    const passportPath = process.env.SEEDROP_PASSPORT as string;
    await writeFile(
      passportPath,
      JSON.stringify({
        schema_version: "1.0",
        agent_id: "claude",
        name: "claude",
        purpose: "test",
        active_projects: [],
      }),
      "utf8",
    );
    const otherCwd = join(scratch, "elsewhere");
    await mkdir(otherCwd, { recursive: true });
    const prior = process.cwd();
    process.chdir(otherCwd);
    try {
      const io = createIo();
      const code = await runCli(["continuity", "--full"], io, fakeRunner());
      expect(code).toBe(0);
      const out = io.stdoutText();
      expect(out).toContain("acting as: claude");
      expect(out).toContain("view: absent");
      expect(out).toContain("daemon");
      expect(out).toContain("reachable: no");
      expect(out).toContain("Heads-up");
    } finally {
      process.chdir(prior);
    }
  });

  it("defaults continuity rendering to brief and exposes full explicitly", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "demo");

    const briefIo = createIo();
    await runCli(["continuity", "--cwd", scratch], briefIo, fakeRunner());
    expect(briefIo.stdoutText()).toContain("## Focus");
    expect(briefIo.stdoutText()).not.toContain("## Daemon");

    const fullIo = createIo();
    await runCli(["continuity", "--full", "--cwd", scratch], fullIo, fakeRunner());
    expect(fullIo.stdoutText()).toContain("## Daemon");
  });

  it("supports --json", async () => {
    await writePassport("x");
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.passport.agent_id).toBe("x");
    expect(parsed.daemon.reachable).toBe(false);
    expect(parsed.orientation.schema_version).toBe("1.0");
    expect(parsed.orientation.identity.agent_id).toBe("x");
    expect(parsed.orientation.place.view_present).toBe(false);
    expect(parsed.orientation.next_action.kind).toBe("setup");
    expect(parsed.orientation.next_action.command).toBe("seed bootstrap");
  });

  it("boot --json returns the stateless-agent cold-start contract", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "demo");
    const io = createIo();
    const code = await runCli(["boot", "--json", "--cwd", scratch, "--peek"], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());

    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.identity).toMatchObject({ present: true, agent_id: "codex" });
    expect(parsed.place).toMatchObject({ view_present: true, workspace_id: "demo" });
    expect(parsed).toHaveProperty("mission");
    expect(parsed).toHaveProperty("freshness");
    expect(parsed).toHaveProperty("coordination");
    expect(parsed).toHaveProperty("safety");
    expect(parsed).toHaveProperty("situation");
    expect(parsed.situation).toMatchObject({
      schema_version: "1.0",
      current_state: { identity: "codex", workspace: "demo" },
      next_move: { category: "focus", command: "seed run start --goal \"...\"" },
    });
    expect(parsed.trust.map((entry: { label: string }) => entry.label)).toContain("live_local");
    expect(parsed.next_action).toMatchObject({ kind: "focus", command: "seed run start --goal \"...\"" });
  });

  it("bare seed renders the boot report when orientation state exists", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "demo");
    const prior = process.cwd();
    process.chdir(scratch);
    try {
      const io = createIo();
      const code = await runCli([], io, fakeRunner());
      expect(code).toBe(0);
      expect(io.stdoutText()).toContain("Seedrop Situation");
      expect(io.stdoutText()).toContain("Next move:");
      expect(io.stdoutText()).toContain("Evidence / confidence:");
    } finally {
      process.chdir(prior);
    }
  });

  it("suggests cd to an active project when continuity runs from HOME", async () => {
    const projectRoot = join(process.env.HOME!, "Projects", "seedrop");
    await mkdir(projectRoot, { recursive: true });
    const passportPath = process.env.SEEDROP_PASSPORT as string;
    await writeFile(
      passportPath,
      JSON.stringify({
        schema_version: "1.0",
        agent_id: "codex",
        name: "codex",
        purpose: "test",
        active_projects: [
          {
            id: "seedrop",
            root: projectRoot,
            last_seen_at: "2026-05-19T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", process.env.HOME!], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.next_action.command).toBe(`cd ${projectRoot} && seed bootstrap`);
    expect(parsed.orientation.next_action.reason).toContain("active project seedrop");
  });

  it("orients against any folder root when no git root is present", async () => {
    await writePassport("x");
    const folder = join(scratch, "folder-root");
    await mkdir(folder, { recursive: true });
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", folder], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.place.cwd).toBe(folder);
    expect(parsed.orientation.place.root).toBe(folder);
    expect(parsed.orientation.place.root_kind).toBe("folder");
  });

  it("uses the git root as the orientation root when available", async () => {
    const git = spawnSync("git", ["--version"], { stdio: "ignore" });
    if (git.status !== 0) return;
    await writePassport("x");
    const repo = join(scratch, "repo");
    const subdir = join(repo, "src", "nested");
    await mkdir(subdir, { recursive: true });
    const init = spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    if (init.status !== 0) return;
    await writeManifest(repo, "repo");
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", subdir], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.place.cwd).toBe(subdir);
    expect(parsed.orientation.place.root).toBe(realpathSync(repo));
    expect(parsed.orientation.place.root_kind).toBe("git");
    expect(parsed.orientation.place.view_present).toBe(true);
  });

  it("folds a legacy pending handoff into an assigned task that continuity routes (ADR 0001)", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "handoff-demo");
    await writeFile(
      join(scratch, ".seedrop", "view", "handoffs", "handoff.json"),
      JSON.stringify({
        schema_version: "1.0",
        handoff_id: "11111111-1111-4111-8111-111111111111",
        created_at: "2026-05-16T00:00:00.000Z",
        updated_at: "2026-05-16T00:00:00.000Z",
        source_agent: "claude",
        recipient: "codex",
        summary: "Resume the orientation engine work.",
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

    // Sync performs the one-time fold.
    await WorkspaceView.open({ root: scratch, agent: "codex" }).sync();

    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.next_action.kind).toBe("run");
    expect(parsed.orientation.next_action.command).toContain("seed task start");
    expect(parsed.orientation.next_action.reason).toContain("assigned by claude");
  });

  async function writeTask(root: string, task: {
    task_id: string;
    title: string;
    status: "open" | "claimed" | "in_progress" | "blocked" | "done" | "dropped";
    owner?: string;
    assigned_by?: string;
    blocked_by?: string[];
  }): Promise<void> {
    await mkdir(join(root, ".seedrop", "view", "tasks"), { recursive: true });
    await writeFile(
      join(root, ".seedrop", "view", "tasks", `${task.task_id}.json`),
      JSON.stringify({
        schema_version: "1.0",
        task_id: task.task_id,
        title: task.title,
        status: task.status,
        ...(task.owner ? { owner: task.owner } : {}),
        ...(task.assigned_by ? { assigned_by: task.assigned_by } : {}),
        ...(task.blocked_by ? { blocked_by: task.blocked_by } : {}),
        created_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        related_runs: [],
      }),
      "utf8",
    );
  }

  it("prefers an in-progress task with no run over the inbox", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "task-demo");
    await writeTask(scratch, {
      task_id: "33333333-3333-4333-8333-333333333333",
      title: "Ship the blocker fix",
      status: "in_progress",
      owner: "codex",
    });
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.next_action.kind).toBe("run");
    expect(parsed.orientation.next_action.command).toContain("seed run start --task 33333333-3333-4333-8333-333333333333");
    expect(parsed.orientation.next_action.reason).toContain("in-progress task");
  });

  it("surfaces a claimed task with `seed task start` when nothing else is queued", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "task-demo");
    await writeTask(scratch, {
      task_id: "44444444-4444-4444-8444-444444444444",
      title: "Land the lint pass",
      status: "claimed",
      owner: "codex",
      assigned_by: "claude",
    });
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.next_action.kind).toBe("run");
    expect(parsed.orientation.next_action.command).toBe("seed task start 44444444-4444-4444-8444-444444444444");
    expect(parsed.orientation.next_action.reason).toContain("assigned by claude");
  });

  it("recommends resolving the blocker when a claimed task is blocked", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "task-demo");
    const blockerId = "55555555-5555-4555-8555-555555555555";
    const blockedId = "66666666-6666-4666-8666-666666666666";
    await writeTask(scratch, {
      task_id: blockerId,
      title: "Add seed task update command",
      status: "claimed",
      owner: "codex",
    });
    await writeTask(scratch, {
      task_id: blockedId,
      title: "Lint prose-only blockers",
      status: "claimed",
      owner: "codex",
      blocked_by: [blockerId],
    });
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    // The blocker task itself is also claimed and comes first in created_at order,
    // so the next_action should target it directly (start the blocker), not the blocked one.
    // If the blocked task is surfaced instead, we expect the blocker-aware recovery.
    const action = parsed.orientation.next_action;
    expect(action.kind).toBe("run");
    // Either: start the unblocked blocker task directly, OR surface blocker resolution.
    const startsBlocker = action.command === `seed task start ${blockerId}`;
    const surfacesBlockerResolution = action.command === `seed task show ${blockerId.slice(0, 8)}` && action.reason.includes("blocked by");
    expect(startsBlocker || surfacesBlockerResolution).toBe(true);
  });

  it("does not keep a claimed task blocked when its blocker is already done", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "task-demo");
    const blockerId = "77777777-7777-4777-8777-777777777777";
    const blockedId = "88888888-8888-4888-8888-888888888888";
    await writeTask(scratch, {
      task_id: blockerId,
      title: "Add seed task update command",
      status: "done",
      owner: "codex",
    });
    await writeTask(scratch, {
      task_id: blockedId,
      title: "Lint prose-only blockers",
      status: "claimed",
      owner: "codex",
      blocked_by: [blockerId],
    });

    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.next_action.kind).toBe("run");
    expect(parsed.orientation.next_action.command).toBe(`seed task start ${blockedId}`);
    expect(parsed.orientation.next_action.reason).not.toContain("blocked by");
  });

  it("surfaces failed validation before continuing a run", async () => {
    await writePassport("codex");
    await writeManifest(scratch, "validation-demo");
    await writeFile(
      join(scratch, ".seedrop", "view", "runs", "run.json"),
      JSON.stringify({
        schema_version: "1.0",
        run_id: "22222222-2222-4222-8222-222222222222",
        agent_id: "codex",
        goal: "Ship orientation harness",
        status: "in_progress",
        started_at: "2026-05-16T00:00:00.000Z",
        updated_at: "2026-05-16T00:01:00.000Z",
        steps: [],
        decisions: [],
        assumptions: [],
        open_threads: [],
        changed_paths: [],
        validation: [
          {
            command: "npm test",
            status: "failed",
            recorded_at: "2026-05-16T00:02:00.000Z",
          },
        ],
        next_actions: [],
      }),
      "utf8",
    );
    const io = createIo();
    const code = await runCli(["continuity", "--json", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.orientation.next_action.kind).toBe("verify");
    expect(parsed.orientation.next_action.command).toBe("npm test");
    expect(parsed.orientation.next_action.risk).toBe("high");
  });
});

describe("upsertCodexSeedEntry", () => {
  it("adds a fresh section + env when neither exists", async () => {
    const { upsertCodexSeedEntry } = await import("../src/router.js");
    const out = upsertCodexSeedEntry(`model = "x"\n`, {
      command: "/node",
      script: "/srv.js",
      passportPath: "/p.json",
    });
    expect(out).toContain("[mcp_servers.seedrop]");
    expect(out).toContain('command = "/node"');
    expect(out).toContain("[mcp_servers.seedrop.env]");
    expect(out).toContain('SEEDROP_PASSPORT = "/p.json"');
  });

  it("inserts env block into existing section", async () => {
    const { upsertCodexSeedEntry } = await import("../src/router.js");
    const input = `[mcp_servers.seedrop]\ncommand = "/node"\nargs = ["/srv.js"]\n\n[marketplaces.foo]\nx = 1\n`;
    const out = upsertCodexSeedEntry(input, {
      command: "/node",
      script: "/srv.js",
      passportPath: "/p.json",
    });
    expect(out).toContain("[mcp_servers.seedrop.env]");
    expect(out).toContain('SEEDROP_PASSPORT = "/p.json"');
    expect(out.indexOf("[mcp_servers.seedrop.env]")).toBeLessThan(out.indexOf("[marketplaces.foo]"));
  });

  it("replaces existing SEEDROP_PASSPORT (idempotent on re-run)", async () => {
    const { upsertCodexSeedEntry } = await import("../src/router.js");
    const input = `[mcp_servers.seedrop]\ncommand = "/node"\nargs = ["/srv.js"]\n\n[mcp_servers.seedrop.env]\nSEEDROP_PASSPORT = "/old.json"\nOTHER = "keep"\n`;
    const out = upsertCodexSeedEntry(input, {
      command: "/node",
      script: "/srv.js",
      passportPath: "/new.json",
    });
    expect(out).toContain('SEEDROP_PASSPORT = "/new.json"');
    expect(out).not.toContain('"/old.json"');
    expect(out).toContain('OTHER = "keep"');
  });
});

describe("seed login / logout / whoami", () => {
  let scratch: string;
  let envSnapshot: { passport?: string; home?: string };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seed-login-test-"));
    envSnapshot = { passport: process.env.SEEDROP_PASSPORT, home: process.env.HOME };
    process.env.HOME = join(scratch, "home");
    await mkdir(process.env.HOME, { recursive: true });
    delete process.env.SEEDROP_PASSPORT;
  });

  afterEach(async () => {
    if (envSnapshot.passport === undefined) delete process.env.SEEDROP_PASSPORT;
    else process.env.SEEDROP_PASSPORT = envSnapshot.passport;
    if (envSnapshot.home !== undefined) process.env.HOME = envSnapshot.home;
    await rm(scratch, { recursive: true, force: true });
  });

  async function makeAgentPassport(agent: string): Promise<string> {
    const dir = join(process.env.HOME!, ".seedrop", "id", "agents");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${agent}.json`);
    await writeFile(
      path,
      JSON.stringify({ schema_version: "1.0", agent_id: agent, name: agent, purpose: "test" }),
      "utf8",
    );
    return path;
  }

  it("login then whoami reports the logged-in agent + source", async () => {
    const path = await makeAgentPassport("codex");
    {
      const io = createIo();
      const code = await runCli(["login", "codex"], io, fakeRunner());
      expect(code).toBe(0);
      expect(io.stdoutText()).toContain("identity ready: codex");
      expect(io.stdoutText()).toContain("repo view:");
    }
    {
      const io = createIo();
      const code = await runCli(["whoami"], io, fakeRunner());
      expect(code).toBe(0);
      expect(io.stdoutText()).toContain("agent: codex");
      expect(io.stdoutText()).toContain("source: seed login");
      expect(io.stdoutText()).toContain(path);
    }
  });

  it("defaultPassportPath() respects active-passport state", async () => {
    const path = await makeAgentPassport("codex");
    await runCli(["login", "codex"], createIo(), fakeRunner());
    expect(defaultPassportPath()).toBe(path);
  });

  it("env var beats active-passport so MCP identity is process-scoped", async () => {
    await makeAgentPassport("codex");
    await runCli(["login", "codex"], createIo(), fakeRunner());
    process.env.SEEDROP_PASSPORT = "/explicit/override.json";
    expect(defaultPassportPath()).toBe("/explicit/override.json");
  });

  it("whoami reports env identity when env and active-passport are both set", async () => {
    await makeAgentPassport("claude");
    await runCli(["login", "claude"], createIo(), fakeRunner());
    const envPath = join(scratch, "codex-env-passport.json");
    await writeFile(
      envPath,
      JSON.stringify({ schema_version: "1.0", agent_id: "codex", name: "codex", purpose: "test" }),
      "utf8",
    );
    process.env.SEEDROP_PASSPORT = envPath;

    const io = createIo();
    const code = await runCli(["whoami"], io, fakeRunner());
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("agent: codex");
    expect(io.stdoutText()).toContain("source: $SEEDROP_PASSPORT");
    expect(io.stdoutText()).toContain(envPath);
  });

  it("logout removes the state", async () => {
    await makeAgentPassport("codex");
    await runCli(["login", "codex"], createIo(), fakeRunner());
    await runCli(["logout"], createIo(), fakeRunner());
    const io = createIo();
    await runCli(["whoami"], io, fakeRunner());
    expect(io.stdoutText()).toContain("source: operator default");
  });

  it("login with no agent prints usage", async () => {
    const io = createIo();
    const code = await runCli(["login"], io, fakeRunner());
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("Usage: seed login");
  });

  it("login to missing agent surfaces bootstrap hint", async () => {
    const io = createIo();
    const code = await runCli(["login", "ghost"], io, fakeRunner());
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("No passport at");
    expect(io.stderrText()).toContain("seed bootstrap --as ghost");
  });

  it("login from HOME clearly separates identity from repo view", async () => {
    await makeAgentPassport("codex");
    const prior = process.cwd();
    process.chdir(process.env.HOME!);
    try {
      const io = createIo();
      const code = await runCli(["login", "codex"], io, fakeRunner());
      expect(code).toBe(0);
      expect(io.stdoutText()).toContain("identity ready: codex");
      expect(io.stdoutText()).toContain("repo view: skipped");
      expect(io.stdoutText()).toContain("cwd is $HOME");
    } finally {
      process.chdir(prior);
    }
  });

  it("login is a no-op when SEEDROP_PASSPORT already points at the same passport", async () => {
    const path = await makeAgentPassport("codex");
    process.env.SEEDROP_PASSPORT = path;
    const io = createIo();
    const code = await runCli(["login", "codex"], io, fakeRunner());
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("already authenticated as codex");
    expect(io.stdoutText()).toContain("--force");
    expect(io.stdoutText()).not.toContain("identity ready");
    // active-passport.json must NOT have been written
    const statePath = join(process.env.HOME!, ".seedrop", "state", "active-passport.json");
    expect(existsSync(statePath)).toBe(false);
  });

  it("login with --force writes active-passport even when env points at the same target", async () => {
    const path = await makeAgentPassport("codex");
    process.env.SEEDROP_PASSPORT = path;
    const io = createIo();
    const code = await runCli(["login", "codex", "--force"], io, fakeRunner());
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("identity ready: codex");
    const statePath = join(process.env.HOME!, ".seedrop", "state", "active-passport.json");
    expect(existsSync(statePath)).toBe(true);
  });

  it("login warns when SEEDROP_PASSPORT pins a different passport, then proceeds", async () => {
    await makeAgentPassport("claude");
    const envPath = await makeAgentPassport("codex");
    process.env.SEEDROP_PASSPORT = envPath;
    const io = createIo();
    const code = await runCli(["login", "claude"], io, fakeRunner());
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("pinned to");
    expect(io.stdoutText()).toContain("SEEDROP_PASSPORT");
    expect(io.stdoutText()).toContain("identity ready: claude");
    const statePath = join(process.env.HOME!, ".seedrop", "state", "active-passport.json");
    expect(existsSync(statePath)).toBe(true);
  });

  it("login --json no-op returns structured payload when env matches", async () => {
    const path = await makeAgentPassport("codex");
    process.env.SEEDROP_PASSPORT = path;
    const io = createIo();
    const code = await runCli(["login", "codex", "--json"], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.ok).toBe(true);
    expect(parsed.no_op).toBe(true);
    expect(parsed.agent_id).toBe("codex");
  });
});

describe("seed install registry", () => {
  let scratch: string;
  let envSnapshot: { passport?: string; home?: string };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seed-install-test-"));
    envSnapshot = { passport: process.env.SEEDROP_PASSPORT, home: process.env.HOME };
    process.env.HOME = join(scratch, "home");
    await mkdir(process.env.HOME, { recursive: true });
    delete process.env.SEEDROP_PASSPORT;
    await makeAgentPassport("codex");
  });

  afterEach(async () => {
    if (envSnapshot.passport === undefined) delete process.env.SEEDROP_PASSPORT;
    else process.env.SEEDROP_PASSPORT = envSnapshot.passport;
    if (envSnapshot.home !== undefined) process.env.HOME = envSnapshot.home;
    await rm(scratch, { recursive: true, force: true });
  });

  async function makeAgentPassport(agent: string): Promise<string> {
    const dir = join(process.env.HOME!, ".seedrop", "id", "agents");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${agent}.json`);
    await writeFile(
      path,
      JSON.stringify({ schema_version: "1.0", agent_id: agent, name: agent, purpose: "test" }),
      "utf8",
    );
    return path;
  }

  it("prints manual JSON and TOML snippets for unknown clients", async () => {
    const io = createIo();
    const code = await runCli(["install", "codex", "--manual"], io, fakeRunner());
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain('"mcpServers"');
    expect(io.stdoutText()).toContain("[mcp_servers.seedrop]");
    expect(io.stdoutText()).toContain("SEEDROP_PASSPORT");
  });

  it("writes a registry-backed JSON client config", async () => {
    const config = join(scratch, "kimi-mcp.json");
    await writeFile(config, JSON.stringify({ mcpServers: { keep: { command: "x" } } }), "utf8");
    const io = createIo();
    const code = await runCli(["install", "codex", "--to", "kimi", "--config", config], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(await readFile(config, "utf8"));
    expect(parsed.mcpServers.keep.command).toBe("x");
    expect(parsed.mcpServers.seedrop.env.SEEDROP_PASSPORT).toContain("codex.json");
  });

  it("writes a Kilo-shaped JSON client config", async () => {
    const config = join(scratch, "kilo.jsonc");
    await writeFile(config, JSON.stringify({ mcp: { keep: { command: ["x"] } } }), "utf8");
    const io = createIo();
    const code = await runCli(["install", "codex", "--to", "kilo", "--config", config], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(await readFile(config, "utf8"));
    expect(parsed.mcp.keep.command[0]).toBe("x");
    expect(parsed.mcp.seedrop.type).toBe("local");
    expect(parsed.mcp.seedrop.command[0]).toContain("node");
    expect(parsed.mcp.seedrop.environment.SEEDROP_PASSPORT).toContain("codex.json");
    expect(parsed.mcp.seedrop.enabled).toBe(true);
  });

  it("writes a registry-backed TOML client config", async () => {
    const config = join(scratch, "config.toml");
    await writeFile(config, `model = "x"\n`, "utf8");
    const io = createIo();
    const code = await runCli(["install", "codex", "--to", "codex-cli", "--config", config], io, fakeRunner());
    expect(code).toBe(0);
    const raw = await readFile(config, "utf8");
    expect(raw).toContain("[mcp_servers.seedrop]");
    expect(raw).toContain("[mcp_servers.seedrop.env]");
    expect(raw).toContain("SEEDROP_PASSPORT");
  });

  it("lists registry verification status", async () => {
    const io = createIo();
    const code = await runCli(["install", "--list-clients"], io, fakeRunner());
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("codex-cli\tCodex CLI");
    expect(io.stdoutText()).toContain("\tverified\t");
  });

  it("scans supported clients", async () => {
    const codexDir = join(process.env.HOME!, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), `model = "x"\n`, "utf8");
    const io = createIo();
    const code = await runCli(["clients", "scan", "--json"], io, fakeRunner());
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutText());
    const codex = parsed.clients.find((client: { id: string }) => client.id === "codex-cli");
    expect(codex.status).toBe("detected");
    expect(codex.wired).toBe(false);
    expect(codex.next_command).toBe("seed install codex --to codex-cli");
  });

  it("wires all detected clients and creates missing agent passports", async () => {
    const codexDir = join(process.env.HOME!, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), `model = "x"\n`, "utf8");
    await rm(join(process.env.HOME!, ".seedrop", "id", "agents", "codex.json"), { force: true });
    const seen: CommandDispatch[] = [];
    const io = createIo();
    const code = await runCli(["install", "--all-detected"], io, fakeRunner(0, seen));
    expect(code).toBe(0);
    expect(seen[0]).toMatchObject({ command: "seed-id" });
    expect(seen[0]?.args).toContain("--autonomous");
    const raw = await readFile(join(codexDir, "config.toml"), "utf8");
    expect(raw).toContain("[mcp_servers.seedrop]");
    expect(io.stdoutText()).toContain("wired Codex CLI");
  });

  it("writes the codex skill (folder layout) on install", async () => {
    const config = join(scratch, "config.toml");
    await writeFile(config, `model = "x"\n`, "utf8");
    const io = createIo();
    const code = await runCli(["install", "codex", "--to", "codex-cli", "--config", config], io, fakeRunner());
    expect(code).toBe(0);
    const skillPath = join(process.env.HOME!, ".codex", "skills", "seedrop", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = await readFile(skillPath, "utf8");
    expect(skill).toContain("name: seedrop");
    expect(skill).toContain("seedrop_continuity");
    expect(skill).toContain("seedrop_capabilities");
  });

  it("writes the boot reflex into ~/.codex/AGENTS.md inside managed markers", async () => {
    const config = join(scratch, "config.toml");
    await writeFile(config, `model = "x"\n`, "utf8");
    const agentsPath = join(process.env.HOME!, ".codex", "AGENTS.md");
    await mkdir(join(process.env.HOME!, ".codex"), { recursive: true });
    await writeFile(agentsPath, "# Existing user content\n\nKeep me.\n", "utf8");
    const io = createIo();
    const code = await runCli(["install", "codex", "--to", "codex-cli", "--config", config], io, fakeRunner());
    expect(code).toBe(0);
    const content = await readFile(agentsPath, "utf8");
    expect(content).toContain("Keep me.");
    expect(content).toContain("<!-- seedrop:boot-reflex:start -->");
    expect(content).toContain("<!-- seedrop:boot-reflex:end -->");
    expect(content).toContain("Seedrop Boot Reflex");
  });

  it("creates a fresh AGENTS.md with the reflex when none exists", async () => {
    const config = join(scratch, "config.toml");
    await writeFile(config, `model = "x"\n`, "utf8");
    const agentsPath = join(process.env.HOME!, ".codex", "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(false);
    const io = createIo();
    const code = await runCli(["install", "codex", "--to", "codex-cli", "--config", config], io, fakeRunner());
    expect(code).toBe(0);
    expect(existsSync(agentsPath)).toBe(true);
    const content = await readFile(agentsPath, "utf8");
    expect(content.startsWith("<!-- seedrop:boot-reflex:start -->")).toBe(true);
  });

  it("is idempotent — re-running install does not duplicate the marker block", async () => {
    const config = join(scratch, "config.toml");
    await writeFile(config, `model = "x"\n`, "utf8");
    const io1 = createIo();
    await runCli(["install", "codex", "--to", "codex-cli", "--config", config], io1, fakeRunner());
    const io2 = createIo();
    await runCli(["install", "codex", "--to", "codex-cli", "--config", config], io2, fakeRunner());
    const agentsPath = join(process.env.HOME!, ".codex", "AGENTS.md");
    const content = await readFile(agentsPath, "utf8");
    const startCount = (content.match(/seedrop:boot-reflex:start/g) ?? []).length;
    const endCount = (content.match(/seedrop:boot-reflex:end/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it("backs up the prior AGENTS.md when hand-edits exist inside the markers", async () => {
    const config = join(scratch, "config.toml");
    await writeFile(config, `model = "x"\n`, "utf8");
    const agentsPath = join(process.env.HOME!, ".codex", "AGENTS.md");
    await mkdir(join(process.env.HOME!, ".codex"), { recursive: true });
    await writeFile(
      agentsPath,
      "<!-- seedrop:boot-reflex:start -->\nhand-edited content the user wrote\n<!-- seedrop:boot-reflex:end -->\n",
      "utf8",
    );
    const io = createIo();
    await runCli(["install", "codex", "--to", "codex-cli", "--config", config], io, fakeRunner());
    const codexDir = join(process.env.HOME!, ".codex");
    const entries = await readdir(codexDir);
    const backups = entries.filter((entry) => entry.startsWith("AGENTS.md.bak."));
    expect(backups.length).toBe(1);
    const backup = await readFile(join(codexDir, backups[0]!), "utf8");
    expect(backup).toContain("hand-edited content the user wrote");
  });

  it("writes the claude skill (flat layout) and boot reflex on install", async () => {
    await makeAgentPassport("claude");
    const config = join(scratch, "claude.json");
    await writeFile(config, JSON.stringify({}), "utf8");
    const io = createIo();
    const code = await runCli(["install", "claude", "--to", "claude-code", "--config", config], io, fakeRunner());
    expect(code).toBe(0);
    const skillPath = join(process.env.HOME!, ".claude", "skills", "seedrop.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = await readFile(skillPath, "utf8");
    expect(skill).toContain("Working with Seedrop");
    const claudemdPath = join(process.env.HOME!, ".claude", "CLAUDE.md");
    expect(existsSync(claudemdPath)).toBe(true);
    const claudemd = await readFile(claudemdPath, "utf8");
    expect(claudemd).toContain("<!-- seedrop:boot-reflex:start -->");
  });
});

describe("seed init / doctor", () => {
  let scratch: string;
  let envSnapshot: { passport?: string; home?: string; spaceUrl?: string };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seed-init-test-"));
    envSnapshot = { passport: process.env.SEEDROP_PASSPORT, home: process.env.HOME, spaceUrl: process.env.SEEDROP_SPACE_URL };
    process.env.HOME = join(scratch, "home");
    process.env.SEEDROP_SPACE_URL = "http://127.0.0.1:1";
    await mkdir(process.env.HOME, { recursive: true });
    delete process.env.SEEDROP_PASSPORT;
  });

  afterEach(async () => {
    if (envSnapshot.passport === undefined) delete process.env.SEEDROP_PASSPORT;
    else process.env.SEEDROP_PASSPORT = envSnapshot.passport;
    if (envSnapshot.home !== undefined) process.env.HOME = envSnapshot.home;
    if (envSnapshot.spaceUrl === undefined) delete process.env.SEEDROP_SPACE_URL;
    else process.env.SEEDROP_SPACE_URL = envSnapshot.spaceUrl;
    vi.unstubAllGlobals();
    await rm(scratch, { recursive: true, force: true });
  });

  it("init can run non-interactively without installing clients or daemon", async () => {
    const seen: CommandDispatch[] = [];
    const io = createIo();
    const code = await runCli(
      ["init", "--name", "mc", "--purpose", "test", "--yes", "--no-install", "--no-daemon"],
      io,
      fakeRunner(0, seen),
    );
    expect(code).toBe(0);
    expect(seen).toEqual([
      {
        command: "seed-id",
        args: ["init", "--name", "mc", "--purpose", "test", "--out", join(process.env.HOME!, ".seedrop", "id", "passport.json")],
      },
    ]);
    expect(io.stdoutText()).toContain("Boot reflex");
  });

  it("doctor reports exact next commands when setup is missing", async () => {
    const io = createIo();
    const code = await runCli(["doctor"], io, fakeRunner());
    expect(code).toBe(1);
    expect(io.stdoutText()).toContain("operator passport missing");
    expect(io.stdoutText()).toContain("→ run: seed init");
    expect(io.stdoutText()).toContain("Space daemon not reachable");
  });

  it("doctor --json emits schema checks and failing exit code", async () => {
    const io = createIo();
    const code = await runCli(["doctor", "--json"], io, fakeRunner());
    expect(code).toBe(1);
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.map((check: { id: string }) => check.id)).toContain("operator_passport");
    expect(parsed.checks.find((check: { id: string }) => check.id === "daemon_health").status).toBe("fail");
  });

  it("doctor reports sandbox-denied daemon checks as warnings", async () => {
    const cause = Object.assign(new Error("connect EPERM 127.0.0.1:18791"), {
      code: "EPERM",
      address: "127.0.0.1",
      port: 18791,
    });
    const error = new TypeError("fetch failed");
    Object.defineProperty(error, "cause", { value: cause });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    const io = createIo();
    const code = await runCli(["doctor", "--json"], io, fakeRunner());
    expect(code).toBe(1);
    const parsed = JSON.parse(io.stdoutText());
    const reachable = parsed.checks.find((check: { id: string }) => check.id === "daemon_reachable");
    const health = parsed.checks.find((check: { id: string }) => check.id === "daemon_health");
    expect(reachable.status).toBe("warn");
    expect(reachable.summary).toContain("runtime sandbox");
    expect(reachable.details.error_kind).toBe("sandbox_denied");
    expect(reachable.next_command).not.toBe("seed daemon install");
    expect(health.status).toBe("warn");
  });

  it("doctor --json warns when a client is wired to the operator passport", async () => {
    const operatorPath = join(process.env.HOME!, ".seedrop", "id", "passport.json");
    await mkdir(join(process.env.HOME!, ".seedrop", "id"), { recursive: true });
    await writeFile(operatorPath, JSON.stringify({ schema_version: "1.0", agent_id: "mc" }), "utf8");
    const codexConfig = join(process.env.HOME!, ".codex", "config.toml");
    await mkdir(join(process.env.HOME!, ".codex"), { recursive: true });
    await writeFile(
      codexConfig,
      `[mcp_servers.seedrop]\ncommand = "npx"\nargs = ["-y", "@seedrop/mcp"]\n\n[mcp_servers.seedrop.env]\nSEEDROP_PASSPORT = "${operatorPath}"\n`,
      "utf8",
    );

    const io = createIo();
    await runCli(["doctor", "--json"], io, fakeRunner());
    const parsed = JSON.parse(io.stdoutText());
    const clientConfigs = parsed.checks.find((check: { id: string }) => check.id === "client_configs");
    expect(clientConfigs.status).toBe("warn");
    expect(JSON.stringify(clientConfigs.details)).toContain("operator_passport");
  });

  it("doctor includes a seed_on_path check", async () => {
    const io = createIo();
    await runCli(["doctor", "--json"], io, fakeRunner());
    const parsed = JSON.parse(io.stdoutText());
    const check = parsed.checks.find((c: { id: string }) => c.id === "seed_on_path");
    expect(check).toBeDefined();
    expect(["pass", "warn"]).toContain(check.status);
    if (check.status === "warn") {
      expect(check.next_command).toMatch(/PATH|@seedrop\/cli/);
    }
  });

  it("doctor reports invalid user client registry entries", async () => {
    await mkdir(join(process.env.HOME!, ".seedrop"), { recursive: true });
    await writeFile(
      join(process.env.HOME!, ".seedrop", "clients.json"),
      JSON.stringify({ broken: { config: "~/x", format: "yaml", section: "mcpServers.seedrop" } }),
      "utf8",
    );

    const io = createIo();
    await runCli(["doctor", "--json"], io, fakeRunner());
    const parsed = JSON.parse(io.stdoutText());
    const registry = parsed.checks.find((check: { id: string }) => check.id === "client_registry");
    expect(registry.status).toBe("fail");
    expect(JSON.stringify(registry.details)).toContain("broken");
  });

  it("plain init detects an incomplete setup journal and suggests resume", async () => {
    await writeSetupJournal(process.env.HOME!, { status: "in_progress" });
    const io = createIo();
    const code = await runCli(["init", "--name", "mc", "--purpose", "test", "--yes", "--no-install", "--no-daemon"], io, fakeRunner());
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("seed init --resume");
  });

  it("init --resume skips completed steps", async () => {
    await writeSetupJournal(process.env.HOME!, {
      status: "failed",
      steps: [{ id: "operator_passport", status: "completed" }],
    });
    const seen: CommandDispatch[] = [];
    const io = createIo();
    const code = await runCli(["init", "--resume", "--yes", "--no-install", "--no-daemon"], io, fakeRunner(0, seen));
    expect(code).toBe(0);
    expect(seen).toEqual([]);
    const journal = JSON.parse(await readFile(join(process.env.HOME!, ".seedrop", "state", "setup.json"), "utf8"));
    expect(journal.status).toBe("completed");
  });
});

describe("runBootstrap", () => {
  let scratch: string;
  let envSnapshot: { passport?: string; spaceRoot?: string; home?: string };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seed-bootstrap-test-"));
    envSnapshot = {
      passport: process.env.SEEDROP_PASSPORT,
      spaceRoot: process.env.SEEDROP_SPACE_ROOT,
      home: process.env.HOME,
    };
    // Isolate $HOME so dev-machine active-passport doesn't leak into the
    // precedence chain.
    process.env.HOME = join(scratch, "home");
    await mkdir(process.env.HOME, { recursive: true });
    process.env.SEEDROP_PASSPORT = join(scratch, "passport.json");
    process.env.SEEDROP_SPACE_ROOT = join(scratch, "space");
  });

  afterEach(async () => {
    if (envSnapshot.passport === undefined) delete process.env.SEEDROP_PASSPORT;
    else process.env.SEEDROP_PASSPORT = envSnapshot.passport;
    if (envSnapshot.spaceRoot === undefined) delete process.env.SEEDROP_SPACE_ROOT;
    else process.env.SEEDROP_SPACE_ROOT = envSnapshot.spaceRoot;
    if (envSnapshot.home !== undefined) process.env.HOME = envSnapshot.home;
    await rm(scratch, { recursive: true, force: true });
  });

  it("errors when no passport exists and --name/--purpose are missing", async () => {
    const io = createIo();
    const seen: CommandDispatch[] = [];
    const code = await runCli(["bootstrap"], io, fakeRunner(0, seen));
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("Re-run with --name");
    expect(seen).toEqual([]);
  });

  it("dispatches id init and view init plan when passport is missing", async () => {
    const repo = join(scratch, "repo");
    await mkdir(repo, { recursive: true });
    const prior = process.cwd();
    process.chdir(repo);
    try {
      const seen: CommandDispatch[] = [];
      const code = await runCli(
        ["bootstrap", "--name", "claude", "--purpose", "test"],
        createIo(),
        fakeRunner(0, seen),
      );
      expect(code).toBe(0);
      expect(seen.map((d) => d.command)).toEqual(["seed-id", "seed-space", "seed-id"]);
      expect(seen[0]?.args.slice(0, 3)).toEqual(["init", "--name", "claude"]);
      expect(seen[1]?.args.slice(0, 2)).toEqual(["view", "init"]);
      expect(seen[2]?.args[0]).toBe("project");
    } finally {
      process.chdir(prior);
    }
  });

  it("skips id init when passport already exists; still links cwd", async () => {
    const passportPath = process.env.SEEDROP_PASSPORT as string;
    await writeFile(passportPath, JSON.stringify({ schema_version: "1.0" }), "utf8");
    const repo = join(scratch, "repo2");
    await mkdir(repo, { recursive: true });
    const prior = process.cwd();
    process.chdir(repo);
    try {
      const seen: CommandDispatch[] = [];
      const code = await runCli(["bootstrap"], createIo(), fakeRunner(0, seen));
      expect(code).toBe(0);
      // No id init dispatch; only view + project link.
      expect(seen.map((d) => d.command)).toEqual(["seed-space", "seed-id"]);
      expect(seen[0]?.args.slice(0, 2)).toEqual(["view", "init"]);
    } finally {
      process.chdir(prior);
    }
  });

  it("ensures ~/.seedrop/space root is created", async () => {
    const passportPath = process.env.SEEDROP_PASSPORT as string;
    await writeFile(passportPath, JSON.stringify({ schema_version: "1.0" }), "utf8");
    const repo = join(scratch, "repo3");
    await mkdir(repo, { recursive: true });
    const prior = process.cwd();
    process.chdir(repo);
    try {
      await runCli(["bootstrap", "--no-link"], createIo(), fakeRunner());
      expect(existsSync(process.env.SEEDROP_SPACE_ROOT as string)).toBe(true);
    } finally {
      process.chdir(prior);
    }
  });

  it("lists active projects when bootstrap skips linking from HOME", async () => {
    const projectRoot = join(process.env.HOME!, "Projects", "seedrop");
    await mkdir(projectRoot, { recursive: true });
    const passportPath = process.env.SEEDROP_PASSPORT as string;
    await writeFile(
      passportPath,
      JSON.stringify({
        schema_version: "1.0",
        agent_id: "codex",
        active_projects: [
          {
            id: "seedrop",
            root: projectRoot,
            last_seen_at: "2026-05-19T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const prior = process.cwd();
    process.chdir(process.env.HOME!);
    try {
      const io = createIo();
      const seen: CommandDispatch[] = [];
      const code = await runCli(["bootstrap"], io, fakeRunner(0, seen));
      expect(code).toBe(0);
      expect(seen).toEqual([]);
      expect(io.stdoutText()).toContain("cwd is $HOME; skipping repo link");
      expect(io.stdoutText()).toContain(`seedrop @ ${projectRoot}`);
      expect(io.stdoutText()).toContain(`try: cd ${projectRoot} && seed bootstrap`);
    } finally {
      process.chdir(prior);
    }
  });
});

describe("runCli", () => {
  it("prints help", async () => {
    const io = createIo();
    const code = await runCli(["--help"], io, fakeRunner());
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("seed id");
  });

  it("runs the resolved command", async () => {
    const seen: CommandDispatch[] = [];
    const code = await runCli(["view", "audit"], createIo(), fakeRunner(0, seen));
    expect(code).toBe(0);
    expect(seen).toEqual([{ command: "seed-space", args: ["view", "audit"] }]);
  });

  it("runs composed commands in order", async () => {
    const seen: CommandDispatch[] = [];
    const code = await runCli(
      ["view", "init", "--root", "/tmp/demo", "--passport", "passport.json"],
      createIo(),
      fakeRunner(0, seen),
    );

    expect(code).toBe(0);
    expect(seen.map((dispatch) => dispatch.command)).toEqual(["seed-space", "seed-id"]);
  });

  it("stops composed commands after a failure", async () => {
    const seen: CommandDispatch[] = [];
    const code = await runCli(
      ["view", "init", "--root", "/tmp/demo", "--passport", "passport.json"],
      createIo(),
      fakeRunner(3, seen),
    );

    expect(code).toBe(3);
    expect(seen).toHaveLength(1);
  });

  it("returns 1 for unknown domains", async () => {
    const io = createIo();
    const code = await runCli(["migrate"], io, fakeRunner());
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("Unknown seed domain");
  });
});

describe("whoami identity divergence (60733578)", () => {
  let scratch: string;
  let envSnapshot: { passport?: string; home?: string };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seed-whoami-test-"));
    envSnapshot = { passport: process.env.SEEDROP_PASSPORT, home: process.env.HOME };
    process.env.HOME = join(scratch, "home");
    await mkdir(join(process.env.HOME, ".seedrop", "state"), { recursive: true });
  });

  afterEach(async () => {
    if (envSnapshot.passport === undefined) delete process.env.SEEDROP_PASSPORT;
    else process.env.SEEDROP_PASSPORT = envSnapshot.passport;
    if (envSnapshot.home !== undefined) process.env.HOME = envSnapshot.home;
    await rm(scratch, { recursive: true, force: true });
  });

  async function writePassportFile(agent: string): Promise<string> {
    const p = join(scratch, `${agent}.json`);
    await writeFile(p, JSON.stringify({ schema_version: "1.0", agent_id: agent, name: agent, purpose: "t", active_projects: [] }), "utf8");
    return p;
  }

  async function writeActiveLogin(agent: string, passportPath: string): Promise<void> {
    await writeFile(
      join(process.env.HOME as string, ".seedrop", "state", "active-passport.json"),
      JSON.stringify({ schema_version: "1.0", agent_id: agent, passport_path: passportPath, set_at: "2026-06-09T00:00:00.000Z" }),
      "utf8",
    );
  }

  it("warns when SEEDROP_PASSPORT and seed login point at different agents", async () => {
    process.env.SEEDROP_PASSPORT = await writePassportFile("claude");
    await writeActiveLogin("codex", await writePassportFile("codex"));

    const io = createIo();
    const code = await runCli(["whoami"], io, fakeRunner());
    expect(code).toBe(0);
    const out = io.stdoutText();
    expect(out).toContain("agent: claude");
    expect(out).toContain("identity divergence");
    expect(out).toContain("codex");
    expect(out).toContain("seed login claude");
  });

  it("stays quiet when seed login matches the pinned identity", async () => {
    const claudePath = await writePassportFile("claude");
    process.env.SEEDROP_PASSPORT = claudePath;
    await writeActiveLogin("claude", claudePath);

    const io = createIo();
    await runCli(["whoami"], io, fakeRunner());
    expect(io.stdoutText()).not.toContain("identity divergence");
  });

  it("stays quiet when there is no active login state", async () => {
    process.env.SEEDROP_PASSPORT = await writePassportFile("claude");

    const io = createIo();
    await runCli(["whoami"], io, fakeRunner());
    expect(io.stdoutText()).not.toContain("identity divergence");
  });
});

describe("focus (token-economy 1 — 0102baf4)", () => {
  let scratch: string;
  let envSnapshot: { passport?: string; spaceUrl?: string; home?: string };

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seed-focus-test-"));
    envSnapshot = {
      passport: process.env.SEEDROP_PASSPORT,
      spaceUrl: process.env.SEEDROP_SPACE_URL,
      home: process.env.HOME,
    };
    process.env.HOME = join(scratch, "home");
    await mkdir(process.env.HOME, { recursive: true });
    process.env.SEEDROP_PASSPORT = join(scratch, "passport.json");
    process.env.SEEDROP_SPACE_URL = "http://127.0.0.1:1"; // unreachable: daemon calls fail fast
    await writeFile(
      process.env.SEEDROP_PASSPORT,
      JSON.stringify({ schema_version: "1.0", agent_id: "claude", name: "claude", purpose: "t", active_projects: [] }),
      "utf8",
    );
  });

  afterEach(async () => {
    if (envSnapshot.passport === undefined) delete process.env.SEEDROP_PASSPORT;
    else process.env.SEEDROP_PASSPORT = envSnapshot.passport;
    if (envSnapshot.spaceUrl === undefined) delete process.env.SEEDROP_SPACE_URL;
    else process.env.SEEDROP_SPACE_URL = envSnapshot.spaceUrl;
    if (envSnapshot.home !== undefined) process.env.HOME = envSnapshot.home;
    await rm(scratch, { recursive: true, force: true });
  });

  // Build a View with a claude-owned in_progress run touching README.md, plus
  // codex signals: one on the touched path, one unrelated, one lock. Uses the
  // real clock so signals don't read as expired when the CLI re-opens the View.
  async function seedView(): Promise<void> {
    await writeFile(join(scratch, "README.md"), "# Demo\n");
    const claude = WorkspaceView.open({ root: scratch, agent: "claude" });
    await claude.sync();
    await claude.startRun({ goal: "ship focus" });
    await claude.logRun({ summary: "edit", changedPaths: ["README.md"] });
    const codex = WorkspaceView.open({ root: scratch, agent: "codex" });
    await codex.claimSignal({ target: "README.md", intent: "codex editing readme" });
    await codex.claimSignal({ target: "docs/guide.md", intent: "codex docs" });
    await codex.claimSignal({ type: "lock", target: "infra/deploy.ts", intent: "codex deploy lock" });
  }

  it("renders a compact packet: identity, focus, and a single next line", async () => {
    await seedView();
    const io = createIo();
    const code = await runCli(["focus", "--cwd", scratch], io, fakeRunner());
    expect(code).toBe(0);
    const out = io.stdoutText();
    expect(out).toContain("# Focus — claude");
    expect(out).toContain("acting as: claude");
    expect(out).toContain("focus: ship focus");
    expect((out.match(/\n {2}next: {2}/g) ?? []).length).toBe(1);
  });

  it("scopes collisions to the current run's paths plus locks, tallying the rest", async () => {
    await seedView();
    const io = createIo();
    await runCli(["focus", "--cwd", scratch, "--json"], io, fakeRunner());
    const parsed = JSON.parse(io.stdoutText());
    const targets = parsed.collisions.map((c: { target: string }) => c.target);
    expect(targets).toContain("README.md"); // touches the run's changed path
    expect(targets).toContain("infra/deploy.ts"); // lock always surfaces
    expect(targets).not.toContain("docs/guide.md"); // unrelated → not listed
    expect(parsed.collisions_elsewhere).toBe(1); // the unrelated claim
  });

  it("does not advance the continuity watermark (peek pre-flight)", async () => {
    await seedView();
    const statePath = join(process.env.HOME as string, ".seedrop", "state", "continuity-claude.json");
    expect(existsSync(statePath)).toBe(false);
    const io = createIo();
    await runCli(["focus", "--cwd", scratch, "--json"], io, fakeRunner());
    const parsed = JSON.parse(io.stdoutText());
    expect(parsed.watermark_advanced).toBe(false);
    expect(existsSync(statePath)).toBe(false); // peek never writes the watermark file
  });
});

function fakeRunner(code = 0, seen: CommandDispatch[] = []): CommandRunner {
  return {
    async run(dispatch) {
      seen.push(dispatch);
      return code;
    },
  };
}

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function writeSetupJournal(
  home: string,
  input: {
    status: "in_progress" | "completed" | "failed";
    steps?: Array<{ id: string; status: string }>;
  },
): Promise<void> {
  const path = join(home, ".seedrop", "state", "setup.json");
  await mkdir(join(home, ".seedrop", "state"), { recursive: true });
  const ids = ["operator_passport", "detect_clients", "agent_passports", "client_configs", "daemon_install", "boot_protocol"];
  await writeFile(
    path,
    JSON.stringify({
      schema_version: "1.0",
      setup_id: "test-setup",
      started_at: "2026-05-16T00:00:00.000Z",
      updated_at: "2026-05-16T00:00:00.000Z",
      status: input.status,
      steps: ids.map((id) => ({
        id,
        status: input.steps?.find((step) => step.id === id)?.status ?? "pending",
        summary: id,
        next_command: "seed init --resume",
        error: null,
      })),
    }),
    "utf8",
  );
}
