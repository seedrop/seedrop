import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidRunTransitionError,
  InvalidTaskTransitionError,
  RUN_TRANSITION_TABLE,
  TASK_TRANSITION_TABLE,
  TaskConflictError,
  TaskNotFoundError,
  WorkspaceView,
  type RunJournal,
  type TaskStatus,
} from "../src/view.js";

const TASK_STATUSES: TaskStatus[] = ["open", "claimed", "in_progress", "blocked", "done", "dropped"];
const RUN_STATUSES: RunJournal["status"][] = ["in_progress", "completed", "blocked", "failed"];
const TASK_TARGETS: TaskStatus[] = ["open", "claimed", "in_progress", "blocked", "done", "dropped"];
const RUN_TARGETS: Array<"completed" | "blocked" | "failed"> = ["completed", "blocked", "failed"];

const EXPECTED_TASK_EDGES = new Set([
  "open->claimed", "open->in_progress", "open->dropped",
  "claimed->open", "claimed->in_progress", "claimed->done", "claimed->dropped",
  "in_progress->open", "in_progress->blocked", "in_progress->done", "in_progress->dropped",
  "blocked->open", "blocked->in_progress", "blocked->done", "blocked->dropped",
]);
const EXPECTED_RUN_EDGES = new Set([
  "in_progress->completed", "in_progress->blocked", "in_progress->failed",
]);

describe("canonical lifecycle transitions", () => {
  let root: string;
  let view: WorkspaceView;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seedrop-transitions-"));
    view = WorkspaceView.open({ root, agent: "codex", now: () => new Date("2026-08-09T06:00:00.000Z") });
    await view.init("transition-test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("declares the complete Task transition table", () => {
    const actual = new Set(
      TASK_STATUSES.flatMap((from) => TASK_TRANSITION_TABLE[from].map((to) => `${from}->${to}`)),
    );
    expect(actual).toEqual(EXPECTED_TASK_EDGES);
    expect(TASK_TRANSITION_TABLE.done).toEqual([]);
    expect(TASK_TRANSITION_TABLE.dropped).toEqual([]);
  });

  it("enforces every allowed and forbidden Task edge through public mutators", async () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_TARGETS) {
        if (from === to) continue;
        const id = randomUUID();
        await writeTask(root, id, from);
        const edge = `${from}->${to}`;
        if (EXPECTED_TASK_EDGES.has(edge)) {
          expect((await transitionTask(view, id, to)).status, edge).toBe(to);
        } else {
          await expect(transitionTask(view, id, to), edge).rejects.toBeInstanceOf(InvalidTaskTransitionError);
          expect((await view.getTask(id)).status, edge).toBe(from);
        }
      }
    }
  });

  it("rejects same-state Task transition attempts and terminal metadata mutation", async () => {
    const started = randomUUID();
    await writeTask(root, started, "in_progress");
    await expect(view.startTask(started)).rejects.toBeInstanceOf(InvalidTaskTransitionError);

    const done = randomUUID();
    await writeTask(root, done, "done");
    await expect(view.updateTask({ taskId: done, description: "reopen by metadata" })).rejects.toBeInstanceOf(TaskConflictError);
    await expect(view.acceptTask(done)).rejects.toBeInstanceOf(TaskConflictError);
  });

  it("declares and enforces the complete Run transition table", async () => {
    const actual = new Set(
      RUN_STATUSES.flatMap((from) => RUN_TRANSITION_TABLE[from].map((to) => `${from}->${to}`)),
    );
    expect(actual).toEqual(EXPECTED_RUN_EDGES);
    expect(RUN_TRANSITION_TABLE.completed).toEqual([]);
    expect(RUN_TRANSITION_TABLE.blocked).toEqual([]);
    expect(RUN_TRANSITION_TABLE.failed).toEqual([]);

    for (const from of RUN_STATUSES) {
      for (const to of RUN_TARGETS) {
        const id = randomUUID();
        await writeRun(root, id, from);
        const edge = `${from}->${to}`;
        if (EXPECTED_RUN_EDGES.has(edge)) {
          expect((await view.finishRun({ runId: id.slice(0, 8), status: to, cause: to === "completed" ? undefined : "test terminal cause", force: true })).status, edge).toBe(to);
        } else {
          await expect(
            view.finishRun({ runId: id.slice(0, 8), status: to, cause: to === "completed" ? undefined : "test terminal cause", force: true }),
            edge,
          ).rejects.toBeInstanceOf(InvalidRunTransitionError);
          expect((await view.readRuns()).records.find((run) => run.run_id === id)?.status, edge).toBe(from);
        }
      }
    }
  });

  it("resolves prefixes at input and persists only canonical UUID references", async () => {
    const first = await view.createTask({ title: "first blocker" });
    const second = await view.createTask({ title: "second blocker" });
    const dependent = await view.createTask({
      title: "dependent",
      blockedBy: [first.task_id.slice(0, 8).toUpperCase()],
    });
    await view.claimTask(dependent.task_id.slice(0, 8));
    const updated = await view.updateTask({
      taskId: dependent.task_id.slice(0, 8),
      blockedBy: [second.task_id.slice(0, 8)],
    });
    expect(updated.blocked_by).toEqual([first.task_id, second.task_id]);

    const { run } = await view.startRun({ goal: "canonical relation", newRun: true });
    const linked = await view.linkTaskRun(dependent.task_id.slice(0, 8), run.run_id.slice(0, 8).toUpperCase());
    expect(linked.task_id).toBe(dependent.task_id);
    expect(linked.related_runs).toEqual([run.run_id]);
    expect((await view.getTask(dependent.task_id.toUpperCase())).task_id).toBe(dependent.task_id);

    const persisted = JSON.parse(await readFile(path.join(root, ".seedrop", "view", "tasks", `${dependent.task_id}.json`), "utf8"));
    expect(persisted.blocked_by).toEqual([first.task_id, second.task_id]);
    expect(persisted.related_runs).toEqual([run.run_id]);
    expect(existsSync(path.join(root, ".seedrop", "view", "tasks", `${dependent.task_id.slice(0, 8)}.json`))).toBe(false);
    expect((await view.readTasks()).completeness).toBe("complete");
  });

  it("rejects ambiguous Task and Run prefixes before any write", async () => {
    const taskA = "abcd0000-0000-4000-8000-000000000001";
    const taskB = "abcd1111-0000-4000-8000-000000000002";
    await writeTask(root, taskA, "open");
    await writeTask(root, taskB, "open");
    await expect(view.claimTask("abcd")).rejects.toThrow(TaskNotFoundError);
    expect((await view.getTask(taskA)).status).toBe("open");
    expect((await view.getTask(taskB)).status).toBe("open");

    const runA = "dcba0000-0000-4000-8000-000000000001";
    const runB = "dcba1111-0000-4000-8000-000000000002";
    await writeRun(root, runA, "in_progress");
    await writeRun(root, runB, "in_progress");
    await expect(view.finishRun({ runId: "dcba", status: "failed", cause: "must stay ambiguous", force: true })).rejects.toThrow(/ambiguous/);
    const runs = await view.readRuns();
    expect(runs.records.find((run) => run.run_id === runA)?.status).toBe("in_progress");
    expect(runs.records.find((run) => run.run_id === runB)?.status).toBe("in_progress");
  });
});

async function transitionTask(view: WorkspaceView, id: string, to: TaskStatus) {
  if (to === "claimed") return view.claimTask(id);
  if (to === "in_progress") return view.startTask(id);
  if (to === "open") return view.pauseTask({ taskId: id, status: "open" });
  if (to === "blocked") return view.pauseTask({ taskId: id, status: "blocked" });
  if (to === "done") return view.doneTask(id);
  return view.dropTask({ taskId: id, reason: "transition table probe" });
}

async function writeTask(root: string, id: string, status: TaskStatus): Promise<void> {
  const dir = path.join(root, ".seedrop", "view", "tasks");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({
    schema_version: "1.0",
    task_id: id,
    title: `${status} task`,
    status,
    owner: "codex",
    created_at: "2026-08-09T05:00:00.000Z",
    updated_at: "2026-08-09T05:00:00.000Z",
    related_runs: [],
  }), "utf8");
}

async function writeRun(root: string, id: string, status: RunJournal["status"]): Promise<void> {
  const dir = path.join(root, ".seedrop", "view", "runs");
  await mkdir(dir, { recursive: true });
  const terminal = status !== "in_progress";
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({
    schema_version: "1.0",
    run_id: id,
    agent_id: "codex",
    goal: `${status} run`,
    status,
    started_at: "2026-08-09T05:00:00.000Z",
    updated_at: "2026-08-09T05:30:00.000Z",
    ...(terminal ? { finished_at: "2026-08-09T05:30:00.000Z" } : {}),
    ...(status === "blocked" || status === "failed" ? { cause: "fixture terminal cause" } : {}),
    steps: [],
    decisions: [],
    assumptions: [],
    open_threads: [],
    changed_paths: [],
    validation: [],
    next_actions: [],
  }), "utf8");
}
