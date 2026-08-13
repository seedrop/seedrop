import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "@seedrop/space";
import {
  compileAdapterSituation,
  type BoundedSituationProjection,
  type ProjectTransactionDigest,
} from "@seedrop/situation";
import { collectBenchState } from "../src/index.js";
import type { Passport } from "@seedrop/id";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-bench-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("collectBenchState", () => {
  it("returns an empty workbench for a passport with no active projects", async () => {
    const passportPath = await writePassport({ active_projects: [] });

    const state = await collectBenchState({
      passportPath,
      spaceUrl: null,
      now: () => new Date("2026-06-12T12:00:00.000Z"),
    });

    expect(state.passport).toMatchObject({ agent_id: "codex", active_projects: 0 });
    expect(state.inventory).toEqual({ scope: "machine", passports: 1, linked_projects: 0 });
    expect(state.summary).toEqual({ total: 0, broken: 0, attention: 0, active: 0, quiet: 0 });
    expect(state.groups.map((group) => group.projectIds)).toEqual([[], [], [], []]);
    expect(state.daemon).toMatchObject({ reachable: false, error: "daemon check skipped" });
  });

  it("attaches one canonical adapter projection to its matching project", async () => {
    const projectRoot = await createHealthyProject("shared-situation");
    const passportPath = await writePassport({
      active_projects: [{ id: "shared-situation", root: projectRoot, view: ".seedrop/view" }],
    });
    const shared = compileAdapterSituation(adapterFixture());

    const state = await collectBenchState({
      passportPath,
      spaceUrl: null,
      sharedSituation: {
        feature: true,
        projectRoot,
        projection: shared,
        expected: { semantic_digest: shared.semantic_digest },
      },
    });

    expect(state.adapter_contract).toEqual({
      version: "1.0.0",
      enabled: true,
      v2_projects: 1,
      fallback_projects: 0,
    });
    expect(project(state, "shared-situation").adapter_situation).toEqual({
      mode: "v2",
      reason: null,
      warning: null,
      served: { kind: "v2_situation", payload: shared },
    });
  });

  it("builds machine inventory from local Seedrop passports and dedupes shared projects", async () => {
    const idRoot = path.join(root, "id");
    const seedropRoot = await createHealthyProject("seedrop");
    const outerRoot = await createHealthyProject("outer-v2");
    const codexPath = await writePassportAt(path.join(idRoot, "agents", "codex.json"), {
      agent_id: "codex",
      name: "Codex",
      active_projects: [
        { id: "seedrop", root: seedropRoot, view: ".seedrop/view" },
        { id: "legacy", root: path.join(root, "legacy"), view: ".acorn/view" },
      ],
    });
    await writePassportAt(path.join(idRoot, "agents", "kimi.json"), {
      agent_id: "kimi",
      name: "Kimi",
      active_projects: [{ id: "seedrop", root: seedropRoot, view: ".seedrop/view" }],
    });
    await writePassportAt(path.join(idRoot, "agents", "claude.json"), {
      agent_id: "claude",
      name: "Claude",
      active_projects: [{ id: "outer-v2", root: outerRoot, view: ".seedrop/view" }],
    });
    await writePassportAt(path.join(idRoot, "passport.json"), {
      agent_id: "operator",
      name: "Operator",
      active_projects: [{ id: "old-acorn", root: path.join(root, "old-acorn"), view: ".acorn/view" }],
    });

    const state = await collectBenchState({
      passportPath: codexPath,
      passportSearchRoots: [idRoot],
      spaceUrl: null,
    });

    expect(state.inventory).toEqual({ scope: "machine", passports: 4, linked_projects: 3 });
    expect(state.projects.map((entry) => entry.id).sort()).toEqual(["outer-v2", "seedrop"]);
    expect(project(state, "seedrop").agents.map((agent) => agent.agent_id)).toEqual(["codex", "kimi"]);
    expect(project(state, "outer-v2").agents.map((agent) => agent.agent_id)).toEqual(["claude"]);
  });

  it("shows agents seen in a project View even when their passport is not linked there", async () => {
    const idRoot = path.join(root, "id");
    const seedropRoot = await createHealthyProject("seedrop");
    const claudeView = WorkspaceView.open({ root: seedropRoot, agent: "claude" });
    const { run } = await claudeView.startRun({ goal: "Historical Claude work" });
    await claudeView.finishRun({ runId: run.run_id, status: "completed" });
    const codexPath = await writePassportAt(path.join(idRoot, "agents", "codex.json"), {
      agent_id: "codex",
      name: "Codex",
      active_projects: [{ id: "seedrop", root: seedropRoot, view: ".seedrop/view" }],
    });
    await writePassportAt(path.join(idRoot, "agents", "claude.json"), {
      agent_id: "claude",
      name: "Claude",
      active_projects: [{ id: "outer-v2", root: await createHealthyProject("outer-v2"), view: ".seedrop/view" }],
    });

    const state = await collectBenchState({
      passportPath: codexPath,
      passportSearchRoots: [idRoot],
      preferredRoot: seedropRoot,
      spaceUrl: null,
    });
    const seedrop = project(state, "seedrop");
    const claude = seedrop.situation.agents.find((agent) => agent.agent_id === "claude");

    expect(state.selection?.preferred_project_id).toBe("seedrop");
    expect(seedrop.agents.map((agent) => agent.agent_id)).toEqual(["codex"]);
    expect(claude).toMatchObject({
      agent_id: "claude",
      linked: false,
      status: "seen",
      viewRuns: 1,
    });
    expect(seedrop.situation.resumption.degraded).toContainEqual(expect.objectContaining({
      kind: "agent_seen_not_linked",
      source: "passport",
      severity: "medium",
    }));
  });

  it("models a clean validated project as ready to resume", async () => {
    const projectRoot = await createHealthyProject("ready");
    const view = WorkspaceView.open({ root: projectRoot, agent: "codex" });
    const { run } = await view.startRun({ goal: "Validate ready state" });
    await view.verifyRun({ runId: run.run_id, command: "npm test", status: "passed" });
    await view.finishRun({ runId: run.run_id, status: "completed", force: true });
    const passportPath = await writePassport({
      active_projects: [{ id: "ready", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });

    expect(project(state, "ready").situation.resumption).toMatchObject({
      readiness: "ready",
      label: "Ready",
      summary: "Ready to resume.",
      degraded: [],
    });
  });

  it("marks missing substrate as blocked with one concrete repair", async () => {
    const passportPath = await writePassport({
      active_projects: [{ id: "missing-root", root: path.join(root, "gone"), view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });
    const resumption = project(state, "missing-root").situation.resumption;

    expect(resumption.readiness).toBe("blocked");
    expect(resumption.degraded).toContainEqual(expect.objectContaining({
      kind: "missing_root",
      source: "passport",
      severity: "critical",
    }));
    expect(resumption.recommendedRepair).toMatchObject({
      kind: "missing_root",
      label: "Locate or unlink project",
      priority: 10,
    });
  });

  it("splits tracked and untracked dirty-state evidence when preflight provides it", async () => {
    const projectRoot = await createHealthyProject("dirty");
    runGit(projectRoot, ["init"]);
    runGit(projectRoot, ["add", "."]);
    runGit(projectRoot, ["-c", "user.name=Seedrop Test", "-c", "user.email=test@seedrop.local", "commit", "-m", "fixture"]);
    await writeFile(path.join(projectRoot, "README.md"), "# dirty\nchanged\n");
    await writeFile(path.join(projectRoot, "scratch.txt"), "scratch\n");
    const passportPath = await writePassport({
      active_projects: [{ id: "dirty", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });
    const fact = project(state, "dirty").situation.resumption.degraded.find((entry) => entry.kind === "dirty_git_tracked");

    expect(fact).toMatchObject({
      severity: "medium",
      source: "git",
      detail: "1 tracked change, 1 untracked.",
    });
  });

  it("treats a blocked next task as blocked resumption", async () => {
    const projectRoot = await createHealthyProject("blocked-next");
    await WorkspaceView.open({ root: projectRoot, agent: "codex" }).createTask({
      title: "Wait for upstream decision",
      blockedBy: ["00000000-0000-0000-0000-000000000000"],
    });
    const passportPath = await writePassport({
      active_projects: [{ id: "blocked-next", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });
    const resumption = project(state, "blocked-next").situation.resumption;

    expect(resumption.readiness).toBe("blocked");
    expect(resumption.degraded).toContainEqual(expect.objectContaining({
      kind: "next_task_blocked",
      source: "view",
      severity: "high",
    }));
    expect(resumption.recommendedRepair).toMatchObject({ label: "Inspect blockers" });
  });

  it("surfaces legacy agent identity as non-canonical provenance", async () => {
    const projectRoot = await createHealthyProject("legacy-agent");
    const legacyView = WorkspaceView.open({ root: projectRoot, agent: "agent" });
    const { run } = await legacyView.startRun({ goal: "Old agent work" });
    await legacyView.finishRun({ runId: run.run_id, status: "completed", force: true });
    const passportPath = await writePassport({
      active_projects: [{ id: "legacy-agent", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });

    expect(project(state, "legacy-agent").situation.resumption.degraded).toContainEqual(expect.objectContaining({
      kind: "legacy_agent_identity",
      label: "Legacy agent identity",
      severity: "medium",
    }));
  });

  it("classifies healthy, missing-root, and missing-view projects", async () => {
    const healthyRoot = await createHealthyProject("healthy");
    const missingViewRoot = path.join(root, "missing-view");
    await mkdir(missingViewRoot);
    const passportPath = await writePassport({
      active_projects: [
        { id: "healthy", root: healthyRoot, view: ".seedrop/view" },
        { id: "missing-view", root: missingViewRoot, view: ".seedrop/view" },
        { id: "missing-root", root: path.join(root, "gone"), view: ".seedrop/view" },
      ],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });

    expect(project(state, "healthy")).toMatchObject({
      status: "quiet",
      view: { present: true, successMeetsRequired: true },
    });
    expect(project(state, "missing-view")).toMatchObject({
      status: "broken",
      view: { present: false, issueCodes: ["missing_view"] },
      attention: { score: 900 },
    });
    expect(project(state, "missing-root")).toMatchObject({
      status: "broken",
      view: { present: false, issueCodes: ["missing_root"] },
      attention: { score: 1000 },
    });
    expect(state.summary).toMatchObject({ total: 3, broken: 2, quiet: 1 });
    expect(state.groups.find((group) => group.status === "broken")?.projectIds).toEqual(["missing-root", "missing-view"]);
  });

  it("marks below-policy View success as attention without calling it broken", async () => {
    const projectRoot = await createAttentionProject("needs-attention");
    const passportPath = await writePassport({
      active_projects: [{ id: "needs-attention", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });

    expect(project(state, "needs-attention")).toMatchObject({
      status: "attention",
      view: {
        present: true,
        successLevel: "L1",
        successRequired: "L3",
        successMeetsRequired: false,
        issueCodes: ["view_success_below_required"],
      },
    });
    expect(project(state, "needs-attention").attention.primary?.kind).toBe("view_success_below_required");
  });

  it("marks projects with active runs as active", async () => {
    const projectRoot = await createHealthyProject("active");
    await WorkspaceView.open({ root: projectRoot, agent: "codex" }).startRun({ goal: "Build Bench state model" });
    const passportPath = await writePassport({
      active_projects: [{ id: "active", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });

    expect(project(state, "active")).toMatchObject({
      status: "active",
      counts: { activeRuns: 1 },
      reasons: ["active run exists"],
      attention: { score: 500 },
      situation: {
        resumption: {
          readiness: "active",
          label: "Active",
        },
      },
    });
  });

  it("reports malformed critical View state as broken", async () => {
    const projectRoot = path.join(root, "malformed");
    await mkdir(path.join(projectRoot, ".seedrop", "view"), { recursive: true });
    await writeFile(path.join(projectRoot, ".seedrop", "view", "manifest.json"), "{bad json");
    const passportPath = await writePassport({
      active_projects: [{ id: "malformed", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });

    expect(project(state, "malformed").status).toBe("broken");
    expect(project(state, "malformed").view.issueCodes).toContain("manifest_invalid");
  });

  it("ranks projects inside groups by attention score", async () => {
    const missingRoot = path.join(root, "gone");
    const missingViewRoot = path.join(root, "missing-view");
    await mkdir(missingViewRoot);
    const activeRoot = await createHealthyProject("active");
    await WorkspaceView.open({ root: activeRoot, agent: "codex" }).startRun({ goal: "Build active thing" });
    const attentionRoot = await createAttentionProject("attention");
    const quietRoot = await createHealthyProject("quiet");
    const passportPath = await writePassport({
      active_projects: [
        { id: "quiet", root: quietRoot, view: ".seedrop/view" },
        { id: "missing-view", root: missingViewRoot, view: ".seedrop/view" },
        { id: "active", root: activeRoot, view: ".seedrop/view" },
        { id: "missing-root", root: missingRoot, view: ".seedrop/view" },
        { id: "attention", root: attentionRoot, view: ".seedrop/view" },
      ],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });

    expect(state.projects.map((entry) => entry.id)).toEqual([
      "missing-root",
      "missing-view",
      "attention",
      "active",
      "quiet",
    ]);
    expect(state.groups.map((group) => [group.status, group.projectIds])).toEqual([
      ["broken", ["missing-root", "missing-view"]],
      ["attention", ["attention"]],
      ["active", ["active"]],
      ["quiet", ["quiet"]],
    ]);
  });

  it("promotes space-linked quiet projects to attention when the daemon is unreachable", async () => {
    const projectRoot = await createHealthyProject("space-app");
    const passportPath = await writePassport({
      active_projects: [{ id: "space-app", root: projectRoot, view: ".seedrop/view", space: "seedrop-team" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: "http://127.0.0.1:9" });

    expect(project(state, "space-app")).toMatchObject({
      status: "attention",
      attention: {
        primary: { kind: "daemon_unreachable" },
      },
    });
    expect(project(state, "space-app").situation.resumption.degraded).toContainEqual(expect.objectContaining({
      kind: "daemon_unreachable",
      source: "space",
      scope: "machine",
    }));
  });

  it("exposes read-only inspectors for runs, tasks, signals, validation, and next actions", async () => {
    const projectRoot = await createAttentionProject("inspect");
    const view = WorkspaceView.open({ root: projectRoot, agent: "codex" });
    const { run } = await view.startRun({ goal: "Inspect View primitives" });
    await view.verifyRun({ runId: run.run_id, command: "npm test", status: "passed" });
    await view.createTask({ title: "Review inspector rows" });
    await view.claimSignal({ target: "README.md", intent: "Keep fixture stable", ttlMs: 60_000 });
    const passportPath = await writePassport({
      active_projects: [{ id: "inspect", root: projectRoot, view: ".seedrop/view" }],
    });

    const state = await collectBenchState({ passportPath, spaceUrl: null });
    const inspectors = project(state, "inspect").inspectors;

    expect(inspectors.runs.current).toMatchObject({
      goal: "Inspect View primitives",
      latestValidation: { command: "npm test", status: "passed" },
    });
    expect(inspectors.tasks.openCount).toBe(1);
    expect(inspectors.tasks.active[0]).toMatchObject({ title: "Review inspector rows", status: "open" });
    expect(inspectors.signals[0]).toMatchObject({ target: "README.md", intent: "Keep fixture stable" });
    expect(inspectors.validation).toMatchObject({ status: "passed" });
    expect(inspectors.nextActions.map((action) => action.command)).toContain("seed view preflight --json");
  });

  it("reads a daemon inbox summary when health is reachable", async () => {
    const passportPath = await writePassport({ active_projects: [] });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return Response.json({ service: "seed-space", registered_passports: [{}] });
      }
      if (url.includes("/inbox/codex")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-seedrop-passport")).toBe("codex");
        return Response.json({
          mentions: [
            {
              id: "mention-one",
              sender_passport_id: "claude",
              content: "@codex please review",
              created_at: "2026-06-12T12:05:00.000Z",
              space_name: "seedrop-team",
            },
          ],
        });
      }
      return new Response("missing", { status: 404 });
    };

    const state = await collectBenchState({
      passportPath,
      spaceUrl: "http://seedrop-space.test",
      fetch: fetchImpl,
    });

    expect(state.inbox).toMatchObject({
      reachable: true,
      unread: 1,
      items: [{ id: "mention-one", sender: "claude", space: "seedrop-team" }],
    });
  });
});

async function createHealthyProject(id: string): Promise<string> {
  const projectRoot = path.join(root, id);
  await mkdir(path.join(projectRoot, ".seedrop", "view"), { recursive: true });
  await writeFile(path.join(projectRoot, "README.md"), `# ${id}\n`);
  await writeFile(
    path.join(projectRoot, ".seedrop", "view", "policy.json"),
    JSON.stringify({
      purpose: `${id} fixture.`,
      current_focus: "Keep orientation clear.",
      required_success_level: "L1",
    }),
  );
  await WorkspaceView.open({ root: projectRoot, agent: "codex" }).sync({ workspaceId: id });
  return projectRoot;
}

async function createAttentionProject(id: string): Promise<string> {
  const projectRoot = path.join(root, id);
  await mkdir(path.join(projectRoot, ".seedrop", "view"), { recursive: true });
  await writeFile(path.join(projectRoot, "README.md"), `# ${id}\n`);
  await writeFile(
    path.join(projectRoot, ".seedrop", "view", "policy.json"),
    JSON.stringify({
      purpose: `${id} fixture.`,
      current_focus: "Needs stronger orientation.",
      required_success_level: "L3",
    }),
  );
  await WorkspaceView.open({ root: projectRoot, agent: "codex" }).sync({ workspaceId: id });
  return projectRoot;
}

async function writePassport(overrides: Partial<Passport>): Promise<string> {
  return writePassportAt(path.join(root, "passport.json"), overrides);
}

async function writePassportAt(passportPath: string, overrides: Partial<Passport>): Promise<string> {
  const passport: Passport = {
    version: "1.0",
    agent_id: "codex",
    name: "Codex",
    purpose: "Test Seedrop Bench",
    core_commitments: [],
    value_anchors: [],
    competencies: [],
    limits: [],
    learned_blocks: [],
    active_projects: [],
    metadata: {
      created_at: "2026-06-12T12:00:00.000Z",
      session_count: 0,
    },
    ...overrides,
  };
  await mkdir(path.dirname(passportPath), { recursive: true });
  await writeFile(passportPath, JSON.stringify(passport, null, 2));
  return passportPath;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function project(state: Awaited<ReturnType<typeof collectBenchState>>, id: string) {
  const found = state.projects.find((candidate) => candidate.id === id);
  expect(found).toBeTruthy();
  return found!;
}

function adapterFixture(): BoundedSituationProjection {
  const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;
  return {
    schema_version: "1.0.0",
    situation_id: digest("a"),
    decision_id: digest("b"),
    budget: {
      requested_bytes: 4096,
      actual_bytes: 1200,
      complete: true,
      candidate_count: 10,
      indexed_count: 10,
      scanned_count: 0,
      event_count: 10,
      file_count: 20,
      omitted_categories: [],
    },
    orientation: {
      intent: { intent_id: "sd_int_fixture", state: "active" },
      risk: [],
      delivery: null,
      grave: null,
      source_health: {
        substrate: "healthy",
        degraded_source_ids: [],
        quarantine_count: 0,
        unresolved_disagreement_count: 0,
      },
      next_action: { disposition: "recommend", action: "resume_intent" },
    },
    trust: Object.fromEntries(["intent", "risk", "delivery", "grave", "source_health", "next_action"].map((name) =>
      [name, { freshness: "current", completeness: "complete", source_ids: ["project"], missing: [] }],
    )),
  };
}
