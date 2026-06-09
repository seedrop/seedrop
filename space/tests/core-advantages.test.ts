import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/view.js";

let root: string;
let now: Date;

function gitInit(dir: string): void {
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "config", "user.email", "t@t.test"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "t"]);
  spawnSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

function gitCommitAll(dir: string, message: string): void {
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, "commit", "-q", "-m", message]);
}

function view(agent = "codex"): WorkspaceView {
  return WorkspaceView.open({
    root,
    agent,
    now: () => now,
  });
}

async function seedRepo(): Promise<void> {
  gitInit(root);
  await writeFile(path.join(root, ".gitignore"), ".seedrop/\n");
  await writeFile(path.join(root, "README.md"), "# Demo\n");
  await writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
  await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
  await writeFile(
    path.join(root, ".seedrop", "view", "policy.json"),
    JSON.stringify({
      purpose: "Benchmark Seedrop orientation advantages.",
      current_focus: "Keep cold-start state deterministic.",
      required_success_level: "L4",
      preferred_verification_commands: ["npm test"],
      path_purposes: {
        "README.md": {
          purpose: "Project overview.",
          confidence: 0.95,
        },
      },
    }),
  );
  gitCommitAll(root, "init");
  await view().sync({ workspaceId: "benchmark" });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-advantage-"));
  now = new Date("2026-06-04T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("core advantage benchmarks", () => {
  it("cold start: one context fetch contains purpose, manifest, continuity, and L4 resume proof", async () => {
    await seedRepo();
    await view().log({
      mission: "benchmark cold start",
      summary: "Captured validated state for a fresh agent session.",
      validation: { status: "passed", commands: ["npm test"] },
      changedPaths: ["README.md"],
    });

    const context = await view().context();

    expect(context.brief.success).toMatchObject({ level: "L4", meets_required: true });
    expect(context.manifest?.workspace_id).toBe("benchmark");
    expect(context.latest_continuity?.mission).toBe("benchmark cold start");
    expect(context.next_actions ?? []).toEqual([]);
  });

  it("interruption recovery: active run evidence survives and is selected as current work", async () => {
    await seedRepo();
    const started = await view().startRun({ goal: "resume interrupted edit", claim: ["README.md"] });
    await view().logRun({
      summary: "Changed the overview, still needs validation.",
      changedPaths: ["README.md"],
      nextActions: [
        {
          kind: "verify",
          command: "npm test",
          risk: "low",
          requires_human: false,
          reason: "Validate the interrupted edit before finishing.",
        },
      ],
    });

    const context = await view().context();

    expect(context.current_run?.run_id).toBe(started.run.run_id);
    expect(context.current_run?.changed_paths).toEqual(["README.md"]);
    expect(context.current_run?.next_actions.map((action) => action.command)).toContain("npm test");
    expect(context.brief.success.level).toBe("L3");
  });

  it("multi-agent awareness: another agent's active claim is visible without shared prose", async () => {
    await seedRepo();
    const claim = await view("claude").claimSignal({
      target: "space/src/view.ts",
      intent: "Review View context behavior.",
      ttlMs: 60_000,
    });

    const context = await view("codex").context();

    expect(context.other_agents).toEqual([
      {
        agent_id: "claude",
        active_runs: [],
        claims: [
          {
            signal_id: claim.id,
            target: "space/src/view.ts",
            intent: "Review View context behavior.",
            expires_at: claim.expires_at,
          },
        ],
        in_progress_tasks: [],
      },
    ]);
  });

  it("weakness guardrail: stale knowledge is audit-visible before it can drive decisions", async () => {
    await seedRepo();
    await writeFile(
      path.join(root, ".seedrop", "view", "knowledge", "old-note.md"),
      [
        "---",
        "status: stale",
        "updated_at: 2026-05-01T00:00:00.000Z",
        "---",
        "# Old note",
        "",
      ].join("\n"),
    );

    const audit = await view().audit();

    expect(audit.ok).toBe(true);
    expect(audit.issues.map((issue) => issue.code)).toContain("knowledge_stale");
    expect(audit.checks?.find((check) => check.id === "knowledge_freshness")?.status).toBe("warn");
  });
});
