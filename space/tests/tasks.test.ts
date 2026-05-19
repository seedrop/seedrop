import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TaskBlockedError,
  TaskConflictError,
  TaskNotFoundError,
  WorkspaceView,
} from "../src/view.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-tasks-"));
  now = new Date("2026-05-18T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(agent = "claude"): WorkspaceView {
  return WorkspaceView.open({ root, agent, now: () => now });
}

describe("WorkspaceView tasks", () => {
  it("creates a task with status=open and no owner", async () => {
    const task = await view().createTask({ title: "Auth refactor" });
    expect(task.task_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.title).toBe("Auth refactor");
    expect(task.status).toBe("open");
    expect(task.owner).toBeUndefined();
    expect(task.related_runs).toEqual([]);
  });

  it("persists tasks under .seedrop/view/tasks/<id>.json", async () => {
    const task = await view().createTask({ title: "Demo" });
    const filePath = path.join(root, ".seedrop", "view", "tasks", `${task.task_id}.json`);
    expect(existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.task_id).toBe(task.task_id);
  });

  it("claim sets owner + status=claimed; second claim refuses", async () => {
    const task = await view("claude").createTask({ title: "T1" });
    const claimed = await view("claude").claimTask(task.task_id);
    expect(claimed.owner).toBe("claude");
    expect(claimed.status).toBe("claimed");

    await expect(view("codex").claimTask(task.task_id)).rejects.toThrow(TaskConflictError);
  });

  it("assign records assigned_by; accept clears it; decline returns to open", async () => {
    const task = await view("claude").createTask({ title: "T2" });
    const assigned = await view("claude").assignTask({ taskId: task.task_id, to: "codex", note: "you're the right person" });
    expect(assigned.owner).toBe("codex");
    expect(assigned.assigned_by).toBe("claude");
    expect(assigned.assigned_note).toBe("you're the right person");
    expect(assigned.status).toBe("claimed");

    const accepted = await view("codex").acceptTask(task.task_id);
    expect(accepted.owner).toBe("codex");
    expect(accepted.assigned_by).toBeUndefined();
    expect(accepted.assigned_note).toBeUndefined();
    expect(accepted.status).toBe("claimed");

    // Re-assign and decline:
    await view("claude").assignTask({ taskId: task.task_id, to: "codex" });
    const declined = await view("codex").declineTask({ taskId: task.task_id, reason: "not my area" });
    expect(declined.owner).toBeUndefined();
    expect(declined.status).toBe("open");
    expect(declined.decline_reason).toBe("not my area");
  });

  it("start sets status=in_progress; cannot start someone else's task", async () => {
    const task = await view("claude").createTask({ title: "T3" });
    await view("claude").claimTask(task.task_id);
    const started = await view("claude").startTask(task.task_id);
    expect(started.status).toBe("in_progress");

    await expect(view("codex").startTask(task.task_id)).rejects.toThrow(TaskConflictError);
  });

  it("pause sets status to blocked or open; done marks done; drop marks dropped", async () => {
    const t = await view().createTask({ title: "T4" });
    await view().claimTask(t.task_id);
    await view().startTask(t.task_id);
    const paused = await view().pauseTask({ taskId: t.task_id });
    expect(paused.status).toBe("blocked");
    const unpaused = await view().pauseTask({ taskId: t.task_id, status: "open" });
    expect(unpaused.status).toBe("open");

    // Re-claim + start to reach in_progress, then done:
    await view().claimTask(t.task_id);
    await view().startTask(t.task_id);
    const done = await view().doneTask(t.task_id);
    expect(done.status).toBe("done");

    const t2 = await view().createTask({ title: "T5" });
    const dropped = await view().dropTask({ taskId: t2.task_id, reason: "duplicate" });
    expect(dropped.status).toBe("dropped");
    expect(dropped.drop_reason).toBe("duplicate");
  });

  it("blocked_by prevents start and done while any blocker is open", async () => {
    const v = view();
    const blocker = await v.createTask({ title: "blocker" });
    const dependent = await v.createTask({ title: "dependent", blockedBy: [blocker.task_id] });
    await v.claimTask(dependent.task_id);

    await expect(v.startTask(dependent.task_id)).rejects.toThrow(TaskBlockedError);

    // Finish the blocker; dependent unblocks.
    await v.claimTask(blocker.task_id);
    await v.startTask(blocker.task_id);
    await v.doneTask(blocker.task_id);

    const started = await v.startTask(dependent.task_id);
    expect(started.status).toBe("in_progress");
  });

  it("from_knowledge field roundtrips through filesystem", async () => {
    const task = await view().createTask({
      title: "auth implementation",
      fromKnowledge: "knowledge/sprint-2026-05.md#auth",
    });
    const reread = await view().getTask(task.task_id);
    expect(reread.from_knowledge).toBe("knowledge/sprint-2026-05.md#auth");
  });

  it("returns the existing task for the same dedup key and title", async () => {
    const v = view();
    const first = await v.createTask({ title: "stable task", dedupKey: "seedrop:test:stable" });
    now = new Date("2026-05-18T11:00:00.000Z");
    const second = await v.createTask({
      title: "stable task",
      description: "retry should not replace the original task",
      dedupKey: "seedrop:test:stable",
    });

    expect(second.task_id).toBe(first.task_id);
    expect(second.description).toBeUndefined();
    expect(await v.listTasks()).toHaveLength(1);
  });

  it("allows a reused dedup key when the title is different", async () => {
    const v = view();
    const first = await v.createTask({ title: "first", dedupKey: "seedrop:test:shared" });
    const second = await v.createTask({ title: "second", dedupKey: "seedrop:test:shared" });

    expect(second.task_id).not.toBe(first.task_id);
    expect(await v.listTasks()).toHaveLength(2);
  });

  it("listTasks filters by status and owner", async () => {
    const v = view();
    const a = await v.createTask({ title: "A" });
    const b = await v.createTask({ title: "B" });
    await v.claimTask(a.task_id);
    expect((await v.listTasks({ status: "open" })).map((t) => t.title)).toEqual(["B"]);
    expect((await v.listTasks({ status: "claimed", owner: "claude" })).map((t) => t.title)).toEqual(["A"]);
    expect(b.title).toBe("B"); // sanity
  });

  it("getTask throws TaskNotFoundError for missing ids", async () => {
    await expect(view().getTask("00000000-0000-0000-0000-000000000000")).rejects.toThrow(TaskNotFoundError);
  });

  it("seed run start --task links the run to the task in related_runs", async () => {
    const v = view();
    const task = await v.createTask({ title: "linked" });
    await v.claimTask(task.task_id);
    const { run } = await v.startRun({ goal: "implement linked task", taskId: task.task_id });
    const reread = await v.getTask(task.task_id);
    expect(reread.related_runs).toContain(run.run_id);
  });
});
