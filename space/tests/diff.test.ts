import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/view.js";
import { diffView } from "../src/diff.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-diff-"));
  now = new Date("2026-05-18T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(agent = "claude"): WorkspaceView {
  return WorkspaceView.open({ root, agent, now: () => now });
}

describe("diffView", () => {
  it("reports nothing notable when no state exists", async () => {
    await view().init("demo");
    const report = await diffView(view(), { since: "last-session" });
    expect(report.notable).toBe(false);
    expect(report.new_continuity_packets).toEqual([]);
    expect(report.runs_started).toEqual([]);
  });

  it("surfaces runs and tasks created after a timestamp", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().init("demo");
    const before = now.toISOString();
    // Advance time slightly so created_at > before
    now = new Date(now.getTime() + 1000);

    const task = await view().createTask({ title: "T1" });
    await view().claimTask(task.task_id);
    await view().startRun({ goal: "implement t1" });

    const report = await diffView(view(), { since: before });
    expect(report.notable).toBe(true);
    expect(report.runs_started).toHaveLength(1);
    expect(report.tasks_changed.length).toBeGreaterThan(0);
    expect(report.tasks_changed.some((t) => t.task_id === task.task_id)).toBe(true);
  });

  it("since=last-session uses the agent's most recent packet", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().init("demo");
    await view().log({ mission: "session 1", summary: "did stuff" });

    // Advance time so the next event is "after last session"
    now = new Date(now.getTime() + 60_000);
    const task = await view().createTask({ title: "after session 1" });

    const report = await diffView(view(), { since: "last-session", agentId: "claude" });
    expect(report.resolved_since).toBe("last-session");
    expect(report.tasks_changed.some((t) => t.task_id === task.task_id)).toBe(true);
  });

  it("rejects invalid --since values", async () => {
    await view().init("demo");
    await expect(diffView(view(), { since: "yesterday" })).rejects.toThrow(/must be an ISO-8601/);
  });
});
