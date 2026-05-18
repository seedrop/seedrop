import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskNotFoundError, WorkspaceView } from "../src/view.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-idux-"));
  now = new Date("2026-05-18T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(agent = "claude"): WorkspaceView {
  return WorkspaceView.open({ root, agent, now: () => now });
}

describe("resolveTaskId — short ID prefixes (fix #3)", () => {
  it("accepts the full UUID unchanged", async () => {
    const task = await view().createTask({ title: "demo" });
    const resolved = await view().resolveTaskId(task.task_id);
    expect(resolved).toBe(task.task_id);
  });

  it("accepts a unique 8-char prefix (what `seed task list` displays)", async () => {
    const task = await view().createTask({ title: "demo" });
    const prefix = task.task_id.slice(0, 8);
    const resolved = await view().resolveTaskId(prefix);
    expect(resolved).toBe(task.task_id);
  });

  it("accepts a unique 4-char prefix as the minimum", async () => {
    const task = await view().createTask({ title: "demo" });
    const prefix = task.task_id.slice(0, 4);
    // Note: with one task in the workspace, even 4 chars is unique.
    const resolved = await view().resolveTaskId(prefix);
    expect(resolved).toBe(task.task_id);
  });

  it("rejects a prefix shorter than 4 chars", async () => {
    await view().createTask({ title: "demo" });
    await expect(view().resolveTaskId("ab")).rejects.toThrow(/prefix too short/);
  });

  it("rejects an ambiguous prefix that matches multiple tasks", async () => {
    // Synthesize two task files with a known shared prefix to force ambiguity.
    // We can't control UUIDs from outside, so create two tasks and rename
    // their files to share a prefix.
    await view().createTask({ title: "first" });
    await view().createTask({ title: "second" });
    const { writeFile: wf, readdir, readFile } = await import("node:fs/promises");
    const tasksDir = path.join(root, ".seedrop", "view", "tasks");
    const entries = await readdir(tasksDir);
    // Write two tasks with the same prefix:
    const sharedPrefix = "ffffffff-1111-4111-8111-";
    for (let i = 0; i < 2; i += 1) {
      const original = path.join(tasksDir, entries[i]!);
      const raw = JSON.parse(await readFile(original, "utf8"));
      const suffix = `${i}`.padStart(12, "0");
      raw.task_id = `${sharedPrefix}${suffix}`;
      await wf(path.join(tasksDir, `${raw.task_id}.json`), JSON.stringify(raw));
      await rm(original);
    }
    await expect(view().resolveTaskId("ffffffff")).rejects.toThrow(/ambiguous/);
  });

  it("rejects a prefix that matches nothing", async () => {
    await view().createTask({ title: "demo" });
    await expect(view().resolveTaskId("0000abcd")).rejects.toThrow(TaskNotFoundError);
  });
});
