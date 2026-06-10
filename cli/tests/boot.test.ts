import { describe, expect, it } from "vitest";
import { applyBootBudget, buildBootReportFromContinuity, renderBoot, resolveBootNextAction, scoreBootOutcome } from "../src/boot.js";
import { selectNextAction } from "../src/continuity.js";
import type { ContinuityReport } from "../src/continuity.js";

function continuity(overrides: Partial<ContinuityReport> = {}): ContinuityReport {
  const base: ContinuityReport = {
    passportPath: "/tmp/codex.json",
    passportSource: "env",
    passport: { agent_id: "codex", continuity: {}, active_projects: [] },
    cwd: "/repo",
    root: "/repo",
    rootKind: "git",
    watermarkAdvanced: false,
    view: {
      present: true,
      manifest: { workspace_id: "demo", root: ".", files: [], updated_at: "2026-06-04T10:00:00.000Z" },
      brief: {
        success: { level: "L4", label: "Handoff-ready", summary: "ready", required_level: "L4", meets_required: true },
        git_status: { is_repo: true, is_dirty: false, uncommitted_count: 0 },
      },
      signals: [],
      activeTasks: [],
      blockerTasks: [],
      openTasksCount: 0,
      openThreads: [],
      otherAgents: [],
    },
    daemon: { url: "http://127.0.0.1:18791", reachable: true, presence: [] },
    inbox: { unacked: [], fetched: true },
    joinedSpaces: [],
    warnings: [],
    orientation: {
      schema_version: "1.0",
      identity: { present: true, agent_id: "codex", passport_path: "/tmp/codex.json", source: "passport" },
      place: { cwd: "/repo", root: "/repo", root_kind: "git", view_present: true, workspace_id: "demo" },
      traces: { latest_continuity_at: null, current_run_id: null, current_run_goal: null, latest_run_status: null, open_signals: 0 },
      coordination: { daemon_reachable: true, inbox_unacked: 0, joined_spaces: [], online_sessions: 0 },
      health: { warnings: [], view_preflight_failed: false, view_success_level: "L4", view_success_required: "L4", view_success_meets_required: true },
      next_action: { kind: "focus", command: "seed run start --goal \"...\"", reason: "fallback", source: "view", risk: "low", requires_human: false },
    },
  };
  return { ...base, ...overrides, view: { ...base.view, ...(overrides.view ?? {}) } };
}

describe("BootReport next-action resolver", () => {
  it("derives next_action from the selected decision trace candidate", () => {
    const report = buildBootReportFromContinuity(continuity(), null, "2026-06-04T10:00:00.000Z");

    expect(report.decision_trace.policy_version).toBe("boot-next-action-v1");
    expect(report.decision_trace.objective_version).toBe("boot-objective-v1");
    expect(report.decision_trace.winner).toBe(report.next_action.candidate_id);
    expect(report.decision_trace.candidates.find((candidate) => candidate.selected)?.candidate_id).toBe(report.next_action.candidate_id);
    expect(report.decision_trace.candidates.find((candidate) => candidate.selected)?.objectives).not.toHaveLength(0);
  });

  it("adds an evidence-bound Situation packet to the boot report", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        view: {
          ...continuity().view,
          brief: {
            ...continuity().view.brief,
            workspace: {
              id: "demo",
              root: ".",
              purpose: "Seedrop lets agents recover repo context from durable local state.",
              current_focus: "Improve cold-start attention.",
            },
            manifest: {
              present: true,
              file_count: 2,
              recommended_reads: [{ path: "cli/src/boot.ts", reason: "Boot contract", priority: 1 }],
              important_paths: ["cli/src/boot.ts"],
              freshness: "fresh",
            },
          } as ContinuityReport["view"]["brief"],
          latestPacket: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            created_at: "2026-06-04T09:00:00.000Z",
            agent: "codex",
            mission: "Previous mission",
            summary: "Captured the last useful state.",
            decisions: [],
            assumptions: [],
            open_threads: ["Decide whether Situation should be persisted."],
            validation: { status: "passed", commands: ["npm test"] },
            changed_paths: ["cli/src/boot.ts"],
          },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.situation).toMatchObject({
      schema_version: "1.0",
      purpose: {
        summary: "Seedrop lets agents recover repo context from durable local state.",
        current_focus: "Improve cold-start attention.",
      },
      last_work: {
        kind: "continuity",
        ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        validation_status: "passed",
      },
      current_state: {
        identity: "codex",
        workspace: "demo",
        git: "clean",
        confidence: { level: "high" },
      },
      next_move: {
        category: "focus",
        command: "seed run start --goal \"...\"",
      },
    });
    expect(report.situation.attention.recommended_reads[0]).toMatchObject({ path: "cli/src/boot.ts" });
    expect(report.situation.attention.open_threads[0]?.summary).toContain("Situation");
  });

  it("renders bare seed as the five-part Situation brief", () => {
    const report = buildBootReportFromContinuity(continuity(), null, "2026-06-04T10:00:00.000Z");
    const out = renderBoot(report);

    expect(out).toContain("Seedrop Situation");
    expect(out).toContain("What this is:");
    expect(out).toContain("Last work:");
    expect(out).toContain("Current state:");
    expect(out).toContain("Next move:");
    expect(out).toContain("Evidence / confidence:");
  });

  it("truncates a long current_focus in the text render but keeps JSON lossless", () => {
    const longFocus = `Improve cold-start attention ${"and reduce token waste ".repeat(20)}`.trim();
    const report = buildBootReportFromContinuity(
      continuity({
        view: {
          ...continuity().view,
          brief: {
            ...continuity().view.brief,
            workspace: { id: "demo", root: ".", purpose: "Repo context recovery.", current_focus: longFocus },
          } as ContinuityReport["view"]["brief"],
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    // JSON surface is lossless
    expect(report.situation.purpose.current_focus).toBe(longFocus);

    // Text render is capped on a single line with an ellipsis
    const focusLine = renderBoot(report).split("\n").find((line) => line.startsWith("  Focus:"));
    expect(focusLine).toBeDefined();
    expect(focusLine!.length).toBeLessThan("  Focus: ".length + 122);
    expect(focusLine!.endsWith("…")).toBe(true);
  });

  it("puts identity setup before any repo work", () => {
    const report = buildBootReportFromContinuity(
      continuity({ passport: null, view: { ...continuity().view, currentRun: { run_id: "r1", agent_id: "codex", goal: "work", status: "in_progress" } } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(resolveBootNextAction(report)).toMatchObject({ kind: "setup", source: "identity", priority: 10 });
    const runCandidate = report.decision_trace.candidates.find((candidate) => candidate.candidate_id.startsWith("active_run:"));
    expect(runCandidate?.modifiers).toContainEqual(expect.objectContaining({ rule: "identity_required", effect: "suppress" }));
  });

  it("puts inbox before the active run for a stateless agent", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        inbox: {
          fetched: true,
          unacked: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", message_id: "m", space_id: "s", sender_passport_id: "claude", content: "ping", created_at: "2026-06-04T10:00:00.000Z" }],
        },
        view: {
          ...continuity().view,
          currentRun: { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agent_id: "codex", goal: "work", status: "in_progress" },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(resolveBootNextAction(report)).toMatchObject({ kind: "inbox", source: "inbox", priority: 30 });
    expect(report.alternate_actions.map((action) => action.kind)).toEqual(expect.arrayContaining(["run"]));
  });

  it("puts active run before stale audit and dirty git safety work", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        view: {
          ...continuity().view,
          currentRun: { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agent_id: "codex", goal: "work", status: "in_progress" },
          brief: {
            success: { level: "L3", label: "Active", summary: "active", required_level: "L3", meets_required: true },
            git_status: { is_repo: true, is_dirty: true, uncommitted_count: 1, uncommitted_paths: ["README.md"] },
          },
        },
      }),
      { ok: true, issues: [{ severity: "warning", code: "knowledge_stale", message: "stale note" }] },
      "2026-06-04T10:00:00.000Z",
    );

    expect(resolveBootNextAction(report)).toMatchObject({ kind: "run", source: "run", priority: 50 });
    expect(report.alternate_actions.map((action) => action.source)).toEqual(expect.arrayContaining(["audit", "git"]));
  });

  it("protects dirty active run before processing inbox", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        inbox: {
          fetched: true,
          unacked: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", message_id: "m", space_id: "s", sender_passport_id: "claude", content: "ping", created_at: "2026-06-04T10:00:00.000Z" }],
        },
        view: {
          ...continuity().view,
          currentRun: { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agent_id: "codex", goal: "work", status: "in_progress", changed_paths: ["README.md"] },
          brief: {
            success: { level: "L3", label: "Active", summary: "active", required_level: "L3", meets_required: true },
            git_status: { is_repo: true, is_dirty: true, uncommitted_count: 1, uncommitted_paths: ["README.md"] },
          },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(resolveBootNextAction(report)).toMatchObject({ candidate_id: "active_run:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", priority: 20 });
    expect(report.decision_trace.candidates.find((candidate) => candidate.candidate_id.startsWith("active_run:"))?.modifiers).toContainEqual(
      expect.objectContaining({ rule: "protect_dirty_active_run", effect: "promote", delta: -30 }),
    );
    expect(report.decision_trace.candidates.find((candidate) => candidate.candidate_id.startsWith("inbox:"))?.rejected_because).toContain("higher safety obligation");
  });

  it("puts failed validation before inbox", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        inbox: {
          fetched: true,
          unacked: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", message_id: "m", space_id: "s", sender_passport_id: "claude", content: "ping", created_at: "2026-06-04T10:00:00.000Z" }],
        },
        view: {
          ...continuity().view,
          latestRun: {
            run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            agent_id: "codex",
            goal: "work",
            status: "failed",
            validation: [{ command: "npm test", status: "failed", recorded_at: "2026-06-04T10:00:00.000Z" }],
          },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(resolveBootNextAction(report)).toMatchObject({ kind: "verify", command: "npm test", priority: 25 });
    expect(report.alternate_actions[0]).toMatchObject({ kind: "inbox" });
  });

  it("scores a protected dirty active run as reduced loss when work is preserved", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        inbox: {
          fetched: true,
          unacked: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", message_id: "m", space_id: "s", sender_passport_id: "claude", content: "ping", created_at: "2026-06-04T10:00:00.000Z" }],
        },
        view: {
          ...continuity().view,
          currentRun: { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agent_id: "codex", goal: "work", status: "in_progress", changed_paths: ["README.md"] },
          brief: {
            success: { level: "L3", label: "Active", summary: "active", required_level: "L3", meets_required: true },
            git_status: { is_repo: true, is_dirty: true, uncommitted_count: 1, uncommitted_paths: ["README.md"] },
          },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    const score = scoreBootOutcome(report, [
      { kind: "work_preserved", summary: "Tracked dirty path was kept in the active run." },
      { kind: "run_completed", ref: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ], "2026-06-04T10:30:00.000Z");

    expect(score).toMatchObject({
      policy_version: "boot-outcome-v1",
      selected_candidate_id: "active_run:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "reduced_loss",
      confidence: "high",
    });
    expect(score.loss_terms).toEqual(expect.arrayContaining([
      expect.objectContaining({ term: "lost_work", observed: "reduced" }),
      expect.objectContaining({ term: "unsafe_context_switch", observed: "reduced" }),
    ]));
    expect(score.total.net_weight).toBeGreaterThan(0);
  });

  it("scores failed-validation recovery as reduced unverified-change loss", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        view: {
          ...continuity().view,
          latestRun: {
            run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            agent_id: "codex",
            goal: "work",
            status: "failed",
            validation: [{ command: "npm test", status: "failed", recorded_at: "2026-06-04T10:00:00.000Z" }],
          },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    const score = scoreBootOutcome(report, [{ kind: "validation_passed", ref: "npm test" }], "2026-06-04T10:30:00.000Z");

    expect(score).toMatchObject({ status: "reduced_loss", confidence: "high" });
    expect(score.loss_terms).toContainEqual(expect.objectContaining({ term: "unverified_changes", observed: "reduced", weight: 5 }));
  });

  it("scores context switching away from a dirty active run as increased loss", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        view: {
          ...continuity().view,
          currentRun: { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agent_id: "codex", goal: "work", status: "in_progress", changed_paths: ["README.md"] },
          brief: {
            success: { level: "L3", label: "Active", summary: "active", required_level: "L3", meets_required: true },
            git_status: { is_repo: true, is_dirty: true, uncommitted_count: 1, uncommitted_paths: ["README.md"] },
          },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    const score = scoreBootOutcome(report, [{ kind: "context_switched", summary: "Agent processed unrelated inbox work first." }], "2026-06-04T10:30:00.000Z");

    expect(score).toMatchObject({ status: "increased_loss", confidence: "high" });
    expect(score.loss_terms).toEqual(expect.arrayContaining([
      expect.objectContaining({ term: "lost_work", observed: "increased" }),
      expect.objectContaining({ term: "unsafe_context_switch", observed: "increased" }),
    ]));
    expect(score.total.net_weight).toBeLessThan(0);
  });

  it("keeps outcome scoring inconclusive without observations", () => {
    const report = buildBootReportFromContinuity(continuity(), null, "2026-06-04T10:00:00.000Z");
    const score = scoreBootOutcome(report, [], "2026-06-04T10:30:00.000Z");

    expect(score).toMatchObject({ status: "inconclusive", confidence: "low" });
    expect(score.total.unknown_weight).toBeGreaterThan(0);
  });
});

describe("boot task-queue routing (134c647c)", () => {
  const openTask = { task_id: "11111111-1111-4111-8111-111111111111", title: "Budget-aware deep surfaces", status: "open" as const };
  const blocker = { task_id: "33333333-3333-4333-8333-333333333333", title: "Ontology ADR", status: "open" as const };
  const blockedTask = {
    task_id: "22222222-2222-4222-8222-222222222222",
    title: "Ship v0.2",
    status: "open" as const,
    blocked_by: [blocker.task_id],
  };

  it("proposes claiming an unclaimed, unblocked task instead of the focus fallback", () => {
    const report = buildBootReportFromContinuity(
      continuity({ view: { ...continuity().view, activeTasks: [openTask], openTasksCount: 1 } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.next_action.candidate_id).toBe(`task:${openTask.task_id}`);
    expect(report.next_action.command).toBe("seed task claim 11111111");
    expect(report.next_action.reason).toContain("unclaimed task(s) queued");
  });

  it("keeps blocked open tasks visible in the trace as suppressed, rejected candidates", () => {
    const report = buildBootReportFromContinuity(
      continuity({ view: { ...continuity().view, activeTasks: [blockedTask, blocker], openTasksCount: 2 } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.next_action.candidate_id).toBe(`task:${blocker.task_id}`);
    const blockedEntry = report.decision_trace.candidates.find(
      (candidate) => candidate.candidate_id === `task:blocked:${blockedTask.task_id}`,
    );
    expect(blockedEntry).toBeDefined();
    expect(blockedEntry?.selected).toBe(false);
    expect(blockedEntry?.modifiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "task_blocked", effect: "suppress" }),
    ]));
    expect(blockedEntry?.rejected_because).toBeTruthy();
    expect(report.alternate_actions.map((action) => action.candidate_id)).not.toContain(
      `task:blocked:${blockedTask.task_id}`,
    );
  });

  it("falls back to focus when every open task is blocked", () => {
    const report = buildBootReportFromContinuity(
      continuity({ view: { ...continuity().view, activeTasks: [blockedTask], openTasksCount: 1 } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.next_action.candidate_id).toBe("focus:start");
    expect(
      report.decision_trace.candidates.some(
        (candidate) => candidate.candidate_id === `task:blocked:${blockedTask.task_id}`,
      ),
    ).toBe(true);
  });

  it("prefers my claimed task over the unclaimed queue", () => {
    const claimed = {
      task_id: "44444444-4444-4444-8444-444444444444",
      title: "Claimed by me",
      status: "claimed" as const,
      owner: "codex",
    };
    const report = buildBootReportFromContinuity(
      continuity({ view: { ...continuity().view, activeTasks: [openTask, claimed], openTasksCount: 2 } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.next_action.candidate_id).toBe(`task:${claimed.task_id}`);
    expect(report.next_action.command).toBe(`seed task start ${claimed.task_id}`);
  });
});

describe("continuity next-move task queue (134c647c)", () => {
  const openTask = { task_id: "11111111-1111-4111-8111-111111111111", title: "Budget-aware deep surfaces", status: "open" as const };
  const blockedTask = {
    task_id: "22222222-2222-4222-8222-222222222222",
    title: "Ship v0.2",
    status: "open" as const,
    blocked_by: ["33333333-3333-4333-8333-333333333333"],
  };

  it("claims from the unclaimed queue instead of reporting no queued work", () => {
    const action = selectNextAction(
      continuity({ view: { ...continuity().view, activeTasks: [openTask], openTasksCount: 1 } }),
    );

    expect(action.command).toBe("seed task claim 11111111");
    expect(action.reason).toContain("1 unclaimed task(s) queued");
  });

  it("still falls back to focus when open tasks are all blocked", () => {
    const action = selectNextAction(
      continuity({ view: { ...continuity().view, activeTasks: [blockedTask], openTasksCount: 1 } }),
    );

    expect(action.reason).toContain("No queued work");
  });
});

describe("boot byte budget (fc8b8b30)", () => {
  it("annotates within-budget reports without trimming", () => {
    const report = buildBootReportFromContinuity(continuity(), null, "2026-06-04T10:00:00.000Z");
    const budgeted = applyBootBudget(report, 1_000_000);

    expect(budgeted.budget).toMatchObject({ limit_bytes: 1_000_000, exceeded: false, stages_applied: [] });
    expect(budgeted.decision_trace).toEqual(report.decision_trace);
  });

  it("compacts rejected trace candidates and caps alternates under a tight budget", () => {
    const report = buildBootReportFromContinuity(
      continuity({
        view: {
          ...continuity().view,
          activeTasks: [
            { task_id: "11111111-1111-4111-8111-111111111111", title: "Task A", status: "open" as const },
          ],
          currentRun: { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agent_id: "codex", goal: "work", status: "in_progress" },
        },
      }),
      null,
      "2026-06-04T10:00:00.000Z",
    );
    const budgeted = applyBootBudget(report, 64);

    expect(budgeted.budget?.stages_applied).toContain("rejected_candidates_compacted");
    for (const candidate of budgeted.decision_trace.candidates) {
      if (!candidate.selected) {
        expect(candidate.evidence).toEqual([]);
        expect(candidate.objectives).toEqual([]);
      }
    }
    const winner = budgeted.decision_trace.candidates.find((candidate) => candidate.selected);
    expect(winner?.objectives.length).toBeGreaterThan(0);
    expect(budgeted.budget?.exceeded).toBe(true);
  });
});

describe("stale-thread escalation (1eeadcf3)", () => {
  const staleThread = {
    id: "abcdef123456",
    thread: "Validate MCP config paths against official docs.",
    packet_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    created_at: "2026-05-01T10:00:00.000Z", // >14d before generated_at
    source: "legacy_continuity",
  };

  it("boot escalates threads stale for more than 14 days", () => {
    const report = buildBootReportFromContinuity(
      continuity({ view: { ...continuity().view, openThreads: [staleThread] } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.next_action.candidate_id).toBe(`thread:stale:${staleThread.id}`);
    expect(report.next_action.command).toBe("seed view threads");
  });

  it("boot lets queued tasks outrank stale threads", () => {
    const openTask = { task_id: "11111111-1111-4111-8111-111111111111", title: "Real work", status: "open" as const };
    const report = buildBootReportFromContinuity(
      continuity({ view: { ...continuity().view, openThreads: [staleThread], activeTasks: [openTask] } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.next_action.candidate_id).toBe(`task:${openTask.task_id}`);
    expect(report.decision_trace.candidates.some((c) => c.candidate_id === `thread:stale:${staleThread.id}`)).toBe(true);
  });

  it("boot ignores threads younger than 14 days", () => {
    const fresh = { ...staleThread, created_at: "2026-06-01T10:00:00.000Z" };
    const report = buildBootReportFromContinuity(
      continuity({ view: { ...continuity().view, openThreads: [fresh] } }),
      null,
      "2026-06-04T10:00:00.000Z",
    );

    expect(report.next_action.candidate_id).toBe("focus:start");
  });

  it("continuity next-move escalates stale threads ahead of the focus fallback", () => {
    const action = selectNextAction(
      continuity({ view: { ...continuity().view, openThreads: [{ ...staleThread, created_at: "2020-01-01T00:00:00.000Z" }] } }),
    );

    expect(action.command).toBe("seed view threads");
    expect(action.reason).toContain("stale >14d");
  });

  it("continuity next-move ranks the unclaimed task queue above stale threads", () => {
    const openTask = { task_id: "11111111-1111-4111-8111-111111111111", title: "Real work", status: "open" as const };
    const action = selectNextAction(
      continuity({
        view: {
          ...continuity().view,
          activeTasks: [openTask],
          openThreads: [{ ...staleThread, created_at: "2020-01-01T00:00:00.000Z" }],
        },
      }),
    );

    expect(action.command).toBe("seed task claim 11111111");
  });
});
