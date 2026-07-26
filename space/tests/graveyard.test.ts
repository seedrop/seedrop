import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceRunDirtyTreeError, WorkspaceRunMissingCauseError } from "../src/errors.js";
import { WorkspaceView } from "../src/view.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-graves-"));
  now = new Date("2026-05-14T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(agent = "codex"): WorkspaceView {
  return WorkspaceView.open({ root, agent, now: () => now });
}

describe("cause of death is the only gate on a non-completed finish", () => {
  it("refuses to record a failure with no cause", async () => {
    const v = view();
    await v.startRun({ goal: "try the sqlite backend" });
    await expect(v.finishRun({ status: "failed" })).rejects.toBeInstanceOf(WorkspaceRunMissingCauseError);
  });

  it("refuses a blocked finish with only whitespace as a cause", async () => {
    const v = view();
    await v.startRun({ goal: "try the sqlite backend" });
    await expect(v.finishRun({ status: "blocked", cause: "   " })).rejects.toBeInstanceOf(
      WorkspaceRunMissingCauseError,
    );
  });

  it("records a failure with one line and no other evidence", async () => {
    const v = view();
    await v.startRun({ goal: "try the sqlite backend" });
    const run = await v.finishRun({ status: "failed", cause: "native module ABI broke on every Node upgrade" });
    expect(run.status).toBe("failed");
    expect(run.cause).toBe("native module ABI broke on every Node upgrade");
    expect(run.finished_at).toBeTruthy();
    expect(run.swept).toBeUndefined();
  });

  it("does not apply the dirty-tree gate to failures — dying is cheaper than completing", async () => {
    const v = view();
    await v.startRun({ goal: "try the sqlite backend" });
    await v.logRun({ summary: "touched a file", changedPaths: ["src/a.ts"] });
    // No git repo, no commit, no validation. A failure still lands.
    const run = await v.finishRun({ status: "failed", cause: "approach abandoned" });
    expect(run.status).toBe("failed");
  });

  it("suggests the exact cause-carrying command in its recovery", () => {
    const err = new WorkspaceRunMissingCauseError("failed");
    const commands = err.recovery.map((r) => r.command);
    expect(commands.some((c) => c?.includes('--status failed --cause'))).toBe(true);
    expect(err.recovery[0]?.requires_human).toBe(false);
  });
});

describe("orphan sweeper", () => {
  it("marks runs abandoned past the threshold as failed and flags them swept", async () => {
    const v = view();
    await v.startRun({ goal: "half-finished migration" });
    const later = new Date("2026-05-20T10:00:00.000Z"); // 144h later
    const swept = await v.sweepOrphanedRuns({ olderThanHours: 72, now: later });
    expect(swept).toHaveLength(1);
    expect(swept[0]?.status).toBe("failed");
    expect(swept[0]?.swept).toBe(true);
    expect(swept[0]?.cause).toContain("abandoned");
    expect(swept[0]?.cause).toContain("144h");
  });

  it("leaves runs inside the threshold alone", async () => {
    const v = view();
    await v.startRun({ goal: "still working" });
    const soon = new Date("2026-05-14T20:00:00.000Z"); // 10h later
    expect(await v.sweepOrphanedRuns({ olderThanHours: 72, now: soon })).toHaveLength(0);
  });

  it("never touches runs that already reached a terminal status", async () => {
    const v = view();
    await v.startRun({ goal: "already dead" });
    await v.finishRun({ status: "failed", cause: "reported by the agent" });
    const later = new Date("2026-06-14T10:00:00.000Z");
    expect(await v.sweepOrphanedRuns({ olderThanHours: 72, now: later })).toHaveLength(0);
    const graves = await v.listGraves();
    expect(graves[0]?.swept).toBe(false);
    expect(graves[0]?.cause).toBe("reported by the agent");
  });
});

describe("graves are scoped to what the agent is about to touch", () => {
  async function bury(v: WorkspaceView, goal: string, changed: string[], cause: string): Promise<void> {
    await v.startRun({ goal, new: true });
    if (changed.length > 0) await v.logRun({ summary: "work", changedPaths: changed });
    await v.finishRun({ status: "failed", cause });
  }

  it("returns only graves overlapping the requested paths", async () => {
    const v = view();
    await bury(v, "rewrite the parser", ["src/parser.ts"], "grammar was ambiguous");
    now = new Date("2026-05-15T10:00:00.000Z");
    await bury(v, "swap the logger", ["src/log.ts"], "no structured output");

    const parser = await v.listGraves({ paths: ["src/parser.ts"] });
    expect(parser).toHaveLength(1);
    expect(parser[0]?.goal).toBe("rewrite the parser");
    expect(parser[0]?.overlapping_paths).toEqual(["src/parser.ts"]);

    expect(await v.listGraves({ paths: ["src/untouched.ts"] })).toHaveLength(0);
  });

  it("returns the most recent graves first when unscoped", async () => {
    const v = view();
    await bury(v, "first attempt", ["a.ts"], "wrong layer");
    now = new Date("2026-05-16T10:00:00.000Z");
    await bury(v, "second attempt", ["b.ts"], "same problem, new shape");

    const graves = await v.listGraves();
    expect(graves.map((g) => g.goal)).toEqual(["second attempt", "first attempt"]);
    expect(graves.every((g) => g.cause !== null)).toBe(true);
  });

  it("excludes completed runs — the graveyard is not a run log", async () => {
    const v = view();
    await v.startRun({ goal: "this one worked" });
    await v.finishRun({ status: "completed" });
    expect(await v.listGraves()).toHaveLength(0);
  });

  it("honours the limit", async () => {
    const v = view();
    for (let i = 0; i < 4; i += 1) {
      now = new Date(`2026-05-1${i + 4}T10:00:00.000Z`);
      await bury(v, `attempt ${i}`, [`f${i}.ts`], `cause ${i}`);
    }
    expect(await v.listGraves({ limit: 2 })).toHaveLength(2);
  });
});

describe("the dirty-tree gate covers claimed new files (root cause of 56 lost runs)", () => {
  function gitInit(dir: string): void {
    spawnSync("git", ["init", "-q", dir]);
    spawnSync("git", ["-C", dir, "config", "user.email", "t@t.test"]);
    spawnSync("git", ["-C", dir, "config", "user.name", "t"]);
    spawnSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  }

  it("refuses to complete when a logged changed_path is a new untracked file", async () => {
    gitInit(root);
    await writeFile(path.join(root, "seed.md"), "# seed\n");
    spawnSync("git", ["-C", root, "add", "-A"]);
    spawnSync("git", ["-C", root, "commit", "-q", "-m", "init"]);

    const v = view();
    await v.startRun({ goal: "write a brand new module" });
    // The run's entire output is a file git has never seen.
    await writeFile(path.join(root, "brand-new.ts"), "export const added = true;\n");
    await v.logRun({ summary: "created it", changedPaths: ["brand-new.ts"] });

    await expect(v.finishRun({ status: "completed" })).rejects.toBeInstanceOf(WorkspaceRunDirtyTreeError);
  });

  it("still ignores untracked files the run never claimed", async () => {
    gitInit(root);
    await writeFile(path.join(root, "seed.md"), "# seed\n");
    spawnSync("git", ["-C", root, "add", "-A"]);
    spawnSync("git", ["-C", root, "commit", "-q", "-m", "init"]);

    const v = view();
    await v.startRun({ goal: "validation-only run" });
    // Build output and scratch notes must not block a clean finish.
    await writeFile(path.join(root, "build.log"), "noise\n");
    await v.logRun({ summary: "ran checks", changedPaths: [] });

    const run = await v.finishRun({ status: "completed" });
    expect(run.status).toBe("completed");
  });

  it("completes once the claimed new file is committed", async () => {
    gitInit(root);
    await writeFile(path.join(root, "seed.md"), "# seed\n");
    spawnSync("git", ["-C", root, "add", "-A"]);
    spawnSync("git", ["-C", root, "commit", "-q", "-m", "init"]);

    const v = view();
    await v.startRun({ goal: "write a brand new module" });
    await writeFile(path.join(root, "brand-new.ts"), "export const added = true;\n");
    await v.logRun({ summary: "created it", changedPaths: ["brand-new.ts"] });
    spawnSync("git", ["-C", root, "add", "-A"]);
    spawnSync("git", ["-C", root, "commit", "-q", "-m", "add module"]);

    expect((await v.finishRun({ status: "completed" })).status).toBe("completed");
  });
});

describe("decision-density nudge", () => {
  it("suggests recording a decision when a run changed files but recorded none", async () => {
    const v = view();
    await v.startRun({ goal: "refactor the parser" });
    await v.logRun({ summary: "did work", changedPaths: ["src/parser.ts"] });
    const run = await v.finishRun({ status: "completed", force: true });
    expect(run.next_actions.some((a) => a.command === 'seed run decision "..."')).toBe(true);
  });

  it("stays silent when the run already recorded a decision", async () => {
    const v = view();
    await v.startRun({ goal: "refactor the parser" });
    await v.logRun({ summary: "did work", changedPaths: ["src/parser.ts"] });
    await v.decideRun("kept recursive descent; PEG backtracking blew the stack");
    const run = await v.finishRun({ status: "completed", force: true });
    expect(run.next_actions.some((a) => a.command === 'seed run decision "..."')).toBe(false);
  });

  it("stays silent for a run that changed nothing", async () => {
    const v = view();
    await v.startRun({ goal: "read-only investigation" });
    const run = await v.finishRun({ status: "completed", force: true });
    expect(run.next_actions.some((a) => a.command === 'seed run decision "..."')).toBe(false);
  });
});
