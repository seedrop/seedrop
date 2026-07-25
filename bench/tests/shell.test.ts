import { describe, expect, it } from "vitest";
import { renderBenchShell } from "../src/shell.js";
import type { BenchProjectInspectors, BenchState } from "../src/state.js";

describe("renderBenchShell", () => {
  it("renders the Codex-style Bench workbench regions", () => {
    const html = renderBenchShell(fixtureState(), { selectedProjectId: "seedrop" });

    expect(html).toContain('data-bench-shell');
    expect(html).toContain('aria-label="Projects"');
    expect(html).toContain('aria-label="Selected project"');
    expect(html).toContain('aria-label="Sources"');
    expect(html).toContain('aria-label="Bench status"');
    expect(html).toContain("Seedrop");
    expect(html).toContain("Bench");
    expect(html).toContain("Next");
    expect(html).toContain("Sources");
    expect(html).toContain("Activity");
    expect(html).toContain("Agents");
    expect(html).toContain("Blocked By");
    expect(html).toContain("Resumption");
    expect(html).toContain("Evidence");
  });

  it("groups projects by status and selects the requested project", () => {
    const html = renderBenchShell(fixtureState(), { selectedProjectId: "broken-app" });

    expect(html).toContain('data-status="broken"');
    expect(html).toContain('data-status="attention"');
    expect(html).toContain('data-status="active"');
    expect(html).toContain('data-status="quiet"');
    expect(html).toContain('data-project-id="broken-app" aria-current="page"');
    expect(html).toContain("Project root missing");
    expect(html).not.toContain("Attention score");
  });

  it("renders primitive inspectors and the machine inbox without action buttons", () => {
    const html = renderBenchShell(fixtureState(), { selectedProjectId: "seedrop" });

    expect(html).toContain("Runs");
    expect(html).toContain("Tasks");
    expect(html).toContain("Signals");
    expect(html).toContain("Checks");
    expect(html).toContain("seed view preflight --json");
    expect(html).toContain("Seen in View");
    expect(html).toContain("claude");
    expect(html).toContain("Next repair");
    expect(html).toContain("View below policy");
    expect(html).toContain("Passport");
    expect(html).toContain("@codex review the Bench inspector");
    expect(html).not.toContain("<button");
  });

  it("escapes project content before rendering", () => {
    const state = fixtureState();
    state.projects[0]!.label = "<script>alert(1)</script>";
    state.projects[0]!.root = "/tmp/<seedrop>";

    const html = renderBenchShell(state);

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("/tmp/&lt;seedrop&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

function fixtureState(): BenchState {
  return {
    schema_version: "1.0",
    generated_at: "2026-06-12T14:00:00.000Z",
    passport: {
      agent_id: "codex",
      name: "Codex",
      path: "/Users/mc/.seedrop/id/agents/codex.json",
      active_projects: 4,
    },
    inventory: {
      scope: "machine",
      passports: 3,
      linked_projects: 5,
    },
    daemon: {
      url: "http://127.0.0.1:18791",
      reachable: true,
      service: "seed-space",
      version: "0.2.0-alpha.5",
      registeredPassports: 2,
    },
    summary: {
      total: 4,
      broken: 1,
      attention: 1,
      active: 1,
      quiet: 1,
    },
    inbox: {
      reachable: true,
      unread: 1,
      source: "http://127.0.0.1:18791/inbox/codex",
      items: [
        {
          id: "mention-one",
          sender: "claude",
          space: "seedrop-team",
          content: "@codex review the Bench inspector",
          createdAt: "2026-06-12T13:40:00.000Z",
        },
      ],
    },
    groups: [
      { status: "broken", label: "Missing", count: 1, projectIds: ["broken-app"] },
      { status: "attention", label: "Review", count: 1, projectIds: ["seedrop"] },
      { status: "active", label: "Active", count: 1, projectIds: ["outer"] },
      { status: "quiet", label: "Clear", count: 1, projectIds: ["loci"] },
    ],
    projects: [
      {
        id: "broken-app",
        label: "broken-app",
        root: "/tmp/missing",
        status: "broken",
        reasons: ["Project root missing"],
        view: { present: false, issueCodes: ["missing_root"] },
        counts: { activeRuns: 0, openTasks: 0, activeSignals: 0, dirtyFiles: 0 },
        attention: {
          score: 1000,
          primary: { kind: "missing_root", label: "Project root missing", score: 1000, severity: "critical" },
          factors: [{ kind: "missing_root", label: "Project root missing", score: 1000, severity: "critical" }],
        },
        inspectors: emptyInspectors(),
        agents: [fixtureAgent("codex")],
        situation: {
          summary: "1 blocker needs review before the project is clear.",
          resumption: fixtureResumption("blocked", "Blocked by project root missing.", [
            { kind: "missing_root", severity: "critical", source: "passport", scope: "project", label: "Project root missing" },
          ], { label: "Locate or unlink project", command: "seed id show" }),
          repo: fixtureRepo("missing", "clean", "0 open", "unknown"),
          agents: [fixtureContributor("codex", "linked", { linked: true })],
          tasks: { open: 0, active: 0, blocked: 0, unowned: 0, assigned: 0 },
          blockers: [{ label: "Project root missing", severity: "critical", source: "view" }],
        },
      },
      {
        id: "seedrop",
        label: "seedrop",
        root: "/Users/mc/Projects/seedrop",
        status: "attention",
        reasons: ["View is L1; policy requires L3."],
        currentFocus: "Build Seedrop Bench.",
        view: {
          present: true,
          successLevel: "L1",
          successRequired: "L3",
          successMeetsRequired: false,
          preflightOk: false,
          issueCodes: ["view_success_below_required"],
        },
        counts: { activeRuns: 0, openTasks: 7, activeSignals: 0, dirtyFiles: 23 },
        attention: {
          score: 510,
          primary: { kind: "view_success_below_required", label: "View is L1; policy requires L3.", score: 330, severity: "medium" },
          factors: [
            { kind: "view_success_below_required", label: "View is L1; policy requires L3.", score: 330, severity: "medium" },
            { kind: "open_task", label: "7 open tasks", score: 140, severity: "low" },
            { kind: "dirty_git", label: "23 dirty files", score: 40, severity: "low" },
          ],
        },
        agents: [fixtureAgent("codex"), fixtureAgent("kimi")],
        situation: {
          summary: "Next task is [cc26fde4] [bench 4] Read-only inspectors for tasks, runs, signals, inbox.",
          resumption: fixtureResumption("review", "Review view below policy before handoff.", [
            { kind: "view_success_below_required", severity: "medium", source: "view", scope: "project", label: "View below policy" },
            { kind: "dirty_git_tracked", severity: "medium", source: "git", scope: "project", label: "Tracked changes" },
            { kind: "agent_seen_not_linked", severity: "medium", source: "passport", scope: "project", label: "Agent seen, not linked" },
          ], { label: "Refresh View evidence", command: "seed view preflight --json" }),
          repo: fixtureRepo("present", "23 dirty", "7 open", "passed"),
          agents: [
            fixtureContributor("codex", "active", { linked: true, viewRuns: 12, openTasks: 1 }),
            fixtureContributor("kimi", "linked", { linked: true, viewRuns: 1 }),
            fixtureContributor("claude", "seen", { viewRuns: 8 }),
          ],
          tasks: {
            open: 7,
            active: 1,
            blocked: 0,
            unowned: 4,
            assigned: 3,
            next: {
              id: "cc26fde4-9a33-4cc3-baa6-784c4a2fb64a",
              title: "[bench 4] Read-only inspectors for tasks, runs, signals, inbox",
              status: "in_progress",
              owner: "codex",
              blockedByCount: 0,
              relatedRuns: ["bf940b42-1f78-4d70-befd-683f4700641e"],
            },
          },
          blockers: [],
          next: {
            kind: "command",
            command: "seed view preflight --json",
            risk: "low",
            requiresHuman: false,
            reason: "View is L1; policy requires L3.",
          },
        },
        nextAction: {
          kind: "command",
          command: "seed view preflight --json",
          risk: "low",
          requires_human: false,
          reason: "View is L1; policy requires L3.",
        },
        inspectors: {
          runs: {
            current: {
              id: "bf940b42-1f78-4d70-befd-683f4700641e",
              goal: "Implement Seedrop Bench read-only primitive inspectors",
              status: "in_progress",
              agent: "codex",
              startedAt: "2026-06-12T12:20:00.000Z",
              updatedAt: "2026-06-12T12:25:00.000Z",
              changedPaths: ["bench/src/state.ts", "bench/src/shell.ts"],
              validation: [
                {
                  command: "npm test -w @seedrop/bench",
                  status: "passed",
                  recordedAt: "2026-06-12T12:25:00.000Z",
                },
              ],
              latestValidation: {
                command: "npm test -w @seedrop/bench",
                status: "passed",
                recordedAt: "2026-06-12T12:25:00.000Z",
              },
            },
            active: [],
          },
          tasks: {
            openCount: 7,
            active: [
              {
                id: "cc26fde4-9a33-4cc3-baa6-784c4a2fb64a",
                title: "[bench 4] Read-only inspectors for tasks, runs, signals, inbox",
                status: "in_progress",
                owner: "codex",
                blockedByCount: 0,
                relatedRuns: ["bf940b42-1f78-4d70-befd-683f4700641e"],
              },
            ],
          },
          signals: [
            {
              id: "signal-one",
              type: "claim",
              target: "bench/src/state.ts",
              owner: "codex",
              intent: "Wire read-only inspectors",
              expiresAt: "2026-06-12T14:00:00.000Z",
            },
          ],
          validation: {
            status: "passed",
            latest: {
              command: "npm test -w @seedrop/bench",
              status: "passed",
              recordedAt: "2026-06-12T12:25:00.000Z",
            },
          },
          nextActions: [
            {
              kind: "command",
              command: "seed view preflight --json",
              risk: "low",
              requiresHuman: false,
              reason: "View is L1; policy requires L3.",
            },
          ],
        },
      },
      {
        id: "outer",
        label: "outer",
        root: "/Users/mc/Projects/outer",
        status: "active",
        reasons: ["active run exists"],
        view: { present: true, successMeetsRequired: true, issueCodes: [] },
        counts: { activeRuns: 1, openTasks: 2, activeSignals: 1, dirtyFiles: 0 },
        attention: {
          score: 1090,
          primary: { kind: "active_run", label: "active run exists", score: 500, severity: "high" },
          factors: [
            { kind: "active_run", label: "active run exists", score: 500, severity: "high" },
            { kind: "active_signal", label: "active signals exist", score: 430, severity: "high" },
            { kind: "open_task", label: "2 open tasks", score: 160, severity: "low" },
          ],
        },
        inspectors: emptyInspectors(),
        agents: [fixtureAgent("gemini")],
        situation: {
          summary: "Active work is present.",
          resumption: fixtureResumption("active", "Active work can be resumed."),
          repo: fixtureRepo("present", "clean", "2 open", "unknown"),
          agents: [fixtureContributor("gemini", "active", { linked: true, viewRuns: 3, openTasks: 2, claims: 1 })],
          tasks: { open: 2, active: 2, blocked: 0, unowned: 0, assigned: 2 },
          blockers: [],
        },
      },
      {
        id: "loci",
        label: "loci",
        root: "/Users/mc/Projects/loci",
        status: "quiet",
        reasons: ["no immediate attention"],
        view: { present: true, successMeetsRequired: true, issueCodes: [] },
        counts: { activeRuns: 0, openTasks: 0, activeSignals: 0, dirtyFiles: 0 },
        attention: { score: 0, factors: [] },
        inspectors: emptyInspectors(),
        agents: [fixtureAgent("codex")],
        situation: {
          summary: "No immediate action recorded.",
          resumption: fixtureResumption("ready", "Ready to resume."),
          repo: fixtureRepo("present", "clean", "0 open", "unknown"),
          agents: [fixtureContributor("codex", "linked", { linked: true })],
          tasks: { open: 0, active: 0, blocked: 0, unowned: 0, assigned: 0 },
          blockers: [],
        },
      },
    ],
  };
}

function fixtureRepo(view: string, git: string, tasks: string, validation: string) {
  return [
    { label: "View", value: view },
    { label: "Git", value: git },
    { label: "Tasks", value: tasks },
    { label: "Validation", value: validation },
  ];
}

function fixtureResumption(
  readiness: "ready" | "active" | "review" | "blocked" | "unknown",
  summary: string,
  degraded: Array<{
    kind: string;
    severity: "critical" | "high" | "medium" | "low";
    source: "passport" | "view" | "git" | "space" | "validation" | "bench";
    scope: "project" | "machine";
    label: string;
  }> = [],
  repair?: {
    label: string;
    command?: string;
  },
) {
  const labels = {
    ready: "Ready",
    active: "Active",
    review: "Review",
    blocked: "Blocked",
    unknown: "Unknown",
  } as const;
  return {
    readiness,
    label: labels[readiness],
    summary,
    degraded,
    ...(repair ? {
      recommendedRepair: {
        kind: degraded[0]?.kind ?? "repair",
        label: repair.label,
        reason: `${repair.label}.`,
        source: degraded[0]?.source ?? "bench",
        priority: 40,
        command: repair.command,
      },
    } : {}),
  };
}

function fixtureContributor(
  agentId: string,
  status: "active" | "linked" | "seen" | "legacy",
  overrides: Partial<{
    linked: boolean;
    legacy: boolean;
    viewRuns: number;
    activeRuns: number;
    openTasks: number;
    claims: number;
  }> = {},
) {
  return {
    agent_id: agentId,
    name: agentId,
    linked: overrides.linked ?? false,
    legacy: overrides.legacy ?? agentId === "agent",
    status,
    sources: overrides.linked ? ["linked" as const] : ["view" as const],
    viewRuns: overrides.viewRuns ?? 0,
    activeRuns: overrides.activeRuns ?? 0,
    openTasks: overrides.openTasks ?? 0,
    claims: overrides.claims ?? 0,
  };
}

function fixtureAgent(agentId: string) {
  return {
    agent_id: agentId,
    name: agentId[0]!.toUpperCase() + agentId.slice(1),
    passportPath: `/Users/mc/.seedrop/id/agents/${agentId}.json`,
  };
}

function emptyInspectors(): BenchProjectInspectors {
  return {
    runs: { active: [] },
    tasks: { openCount: 0, active: [] },
    signals: [],
    validation: { status: "unknown" },
    nextActions: [],
  };
}
