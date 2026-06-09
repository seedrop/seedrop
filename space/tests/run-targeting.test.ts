import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/view.js";
import { WorkspaceRunOwnershipError } from "../src/errors.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-run-target-"));
  now = new Date("2026-05-19T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(agent: string): WorkspaceView {
  return WorkspaceView.open({ root, agent, now: () => now });
}

describe("run targeting via runId (cross-agent confusion fix)", () => {
  it("resolveRunId accepts the full UUID and a unique prefix", async () => {
    const v = view("claude");
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await v.sync();
    const { run } = await v.startRun({ goal: "first" });

    expect(await v.resolveRunId(run.run_id)).toBe(run.run_id);
    expect(await v.resolveRunId(run.run_id.slice(0, 8))).toBe(run.run_id);
  });

  it("rejects an ambiguous run id prefix", async () => {
    const v = view("claude");
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await v.sync();
    // Synthesize two runs sharing a prefix on disk.
    const a = (await v.startRun({ goal: "first" })).run;
    now = new Date(now.getTime() + 1000);
    const b = (await v.startRun({ goal: "second", newRun: true })).run;
    const sharedPrefix = "deadbeef-1111-4111-8111-";
    const { readdir, readFile: rf, writeFile: wf } = await import("node:fs/promises");
    const runsDir = path.join(root, ".seedrop", "view", "runs");
    const entries = await readdir(runsDir);
    let i = 0;
    for (const entry of entries) {
      const raw = JSON.parse(await rf(path.join(runsDir, entry), "utf8"));
      raw.run_id = `${sharedPrefix}${String(i).padStart(12, "0")}`;
      await wf(path.join(runsDir, `${raw.run_id}.json`), JSON.stringify(raw));
      await rm(path.join(runsDir, entry));
      i += 1;
    }
    await expect(v.resolveRunId("deadbeef")).rejects.toThrow(/ambiguous/);
    expect(a.run_id).toBeTruthy();
    expect(b.run_id).toBeTruthy();
  });

  it("logRun --runId targets a specific run owned by the resolving agent", async () => {
    const claude = view("claude");
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await claude.sync();

    // claude starts two runs; "latest active" returns B.
    const a = (await claude.startRun({ goal: "claude A" })).run;
    now = new Date(now.getTime() + 1000);
    await claude.startRun({ goal: "claude B", newRun: true });

    // Without --runId, log lands on the latest active (B). With --runId, it
    // targets the older run A even though it isn't the latest active one.
    const loggedToA = await claude.logRun({ runId: a.run_id, summary: "into run A by id" });
    expect(loggedToA.run_id).toBe(a.run_id);
    expect(loggedToA.steps.at(-1)?.summary).toBe("into run A by id");
  });

  it("logRun --runId refuses to mutate another agent's run (ownership guard)", async () => {
    const claude = view("claude");
    const codex = view("codex");
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await claude.sync();

    await claude.startRun({ goal: "claude work" });
    const b = (await codex.startRun({ goal: "codex work" })).run;

    // claude targeting codex's run by id is a silent cross-owner takeover —
    // now refused. (Replaces the deferred "tomorrow" ownership check.)
    await expect(claude.logRun({ runId: b.run_id, summary: "into codex's run" })).rejects.toBeInstanceOf(
      WorkspaceRunOwnershipError,
    );

    // The supported path: act explicitly as the owner via --agent.
    const loggedAsCodex = await claude.logRun({ runId: b.run_id, agent: "codex", summary: "as codex" });
    expect(loggedAsCodex.run_id).toBe(b.run_id);
    expect(loggedAsCodex.steps.at(-1)?.summary).toBe("as codex");
  });

  it("finishRun --runId targets a specific run", async () => {
    const v = view("claude");
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
    // git init so the dirty-tree gate has a context
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init", "-q", root]);
    spawnSync("git", ["-C", root, "config", "user.email", "t@t.test"]);
    spawnSync("git", ["-C", root, "config", "user.name", "t"]);
    spawnSync("git", ["-C", root, "add", "-A"]);
    spawnSync("git", ["-C", root, "commit", "-qm", "init"]);
    await v.sync();
    const a = (await v.startRun({ goal: "first" })).run;
    now = new Date(now.getTime() + 1000);
    const b = (await v.startRun({ goal: "second", newRun: true })).run;

    const finished = await v.finishRun({ runId: a.run_id, status: "completed" });
    expect(finished.run_id).toBe(a.run_id);
    expect(finished.status).toBe("completed");
    // b is still in_progress.
    const remaining = await v.listRuns();
    expect(remaining.find((r) => r.run_id === b.run_id)?.status).toBe("in_progress");
  });
});
