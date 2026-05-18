import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceRunClaimConflictError,
  WorkspaceRunTaskConflictError,
  WorkspaceView,
} from "../src/view.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-collision-"));
  now = new Date("2026-05-18T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(agent: string): WorkspaceView {
  return WorkspaceView.open({ root, agent, now: () => now });
}

describe("cross-agent collision detection", () => {
  it("startRun refuses --claim path that another agent has claimed", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view("claude").sync({ workspaceId: "demo" });
    await view("claude").startRun({ goal: "claude's work", claim: ["README.md"] });

    await expect(
      view("codex").startRun({ goal: "codex tries the same file", claim: ["README.md"] }),
    ).rejects.toThrow(WorkspaceRunClaimConflictError);
  });

  it("startRun accepts --claim when no other agent has a conflicting signal", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view("claude").sync({ workspaceId: "demo" });

    const { run } = await view("claude").startRun({ goal: "first claim", claim: ["README.md"] });
    expect(run.status).toBe("in_progress");
  });

  it("startRun --force bypasses the claim conflict gate", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view("claude").sync({ workspaceId: "demo" });
    await view("claude").startRun({ goal: "claude's work", claim: ["README.md"] });

    const { run } = await view("codex").startRun({
      goal: "codex overrides",
      claim: ["README.md"],
      force: true,
    });
    expect(run.status).toBe("in_progress");
  });

  it("startRun --task refuses when task is owned by another agent and in progress", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view("claude").sync({ workspaceId: "demo" });
    const task = await view("claude").createTask({ title: "Claude's task" });
    await view("claude").claimTask(task.task_id);
    await view("claude").startTask(task.task_id);

    await expect(
      view("codex").startRun({ goal: "codex tries claude's task", taskId: task.task_id }),
    ).rejects.toThrow(WorkspaceRunTaskConflictError);
  });

  it("context.other_agents surfaces other agents' active runs and claims", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view("claude").sync({ workspaceId: "demo" });
    await view("claude").startRun({ goal: "claude is working", claim: ["README.md"] });

    const ctx = await view("codex").context();
    expect(ctx.other_agents).toBeDefined();
    expect(ctx.other_agents).toHaveLength(1);
    expect(ctx.other_agents?.[0]?.agent_id).toBe("claude");
    expect(ctx.other_agents?.[0]?.active_runs).toHaveLength(1);
    expect(ctx.other_agents?.[0]?.claims.some((c) => c.target === "README.md")).toBe(true);
  });
});
