import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/view.js";

const AUDITED_FAMILIES = [
  "manifest",
  "policy",
  "continuity",
  "runs",
  "tasks",
  "handoffs",
  "signals",
  "signals_archive",
  "knowledge",
  "resolved_threads",
] as const;

describe("complete durable artifact audit", () => {
  let root: string;
  let view: WorkspaceView;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seedrop-artifact-audit-"));
    view = WorkspaceView.open({ root, agent: "codex", now: () => new Date("2026-08-09T06:00:00.000Z") });
    await view.init("artifact-audit-test");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits a check for every family even when optional families are empty", async () => {
    const report = await view.audit({ writeCache: false });
    const checkIds = new Set(report.checks?.map((check) => check.id));

    for (const family of AUDITED_FAMILIES) expect(checkIds.has(family)).toBe(true);
    expect(report.checks?.find((check) => check.id === "manifest")).toMatchObject({
      status: "pass",
      details: { completeness: "complete", records_count: 1, diagnostics_count: 0 },
    });
    expect(report.checks?.find((check) => check.id === "policy")).toMatchObject({
      status: "skipped",
      details: { completeness: "complete", records_count: 0, diagnostics_count: 0 },
    });
  });

  it("reports every malformed family with exact path and reason while preserving valid counts", async () => {
    const dataDir = path.join(root, ".seedrop", "view");
    await view.log({ mission: "valid packet", summary: "valid packet sibling" });
    await view.startRun({ goal: "valid run", newRun: true });
    await view.createTask({ title: "valid task" });
    await view.claimSignal({ target: "space/src/view.ts", intent: "valid signal" });

    await writeFile(path.join(dataDir, "continuity", "malformed.json"), "{bad", "utf8");
    await writeFile(path.join(dataDir, "runs", "malformed.json"), "{bad", "utf8");
    await writeFile(path.join(dataDir, "tasks", "malformed-a.json"), "{bad", "utf8");
    await writeFile(
      path.join(dataDir, "tasks", "malformed-b.json"),
      JSON.stringify({ schema_version: "1.0", task_id: randomUUID(), blocked_by: ["short-id"] }),
      "utf8",
    );
    await writeFile(path.join(dataDir, "signals", "malformed.json"), "{bad", "utf8");
    await writeFile(path.join(dataDir, "handoffs", "malformed.json"), "{bad", "utf8");

    const archived = {
      id: randomUUID(),
      type: "claim",
      target: "space/src/view.ts",
      owner: "codex",
      created_at: "2026-08-09T05:00:00.000Z",
      expires_at: "2026-08-09T05:30:00.000Z",
      intent: "valid archived signal",
      archived_at: "2026-08-09T05:45:00.000Z",
    };
    await writeFile(
      path.join(dataDir, "signals-archive.json"),
      JSON.stringify([archived, { ...archived, id: "not-a-uuid" }]),
      "utf8",
    );
    await writeFile(
      path.join(dataDir, "knowledge", "malformed.md"),
      "---\nstatus: stale\n# delimiter never closes\n",
      "utf8",
    );
    await writeFile(
      path.join(dataDir, "resolved-threads.json"),
      JSON.stringify({
        schema_version: "1.0",
        resolved: [
          {
            id: "valid-thread",
            packet_id: randomUUID(),
            thread: "valid resolved thread",
            resolved_at: "2026-08-09T05:00:00.000Z",
          },
          { id: "missing-required-fields" },
        ],
      }),
      "utf8",
    );
    await writeFile(path.join(dataDir, "policy.json"), JSON.stringify({ ignore: ["/absolute"] }), "utf8");
    await writeFile(path.join(dataDir, "manifest.json"), "{bad", "utf8");

    const report = await view.audit({ writeCache: false });
    expect(report.ok).toBe(false);

    const expectedPaths = [
      ".seedrop/view/manifest.json",
      ".seedrop/view/policy.json",
      ".seedrop/view/continuity/malformed.json",
      ".seedrop/view/runs/malformed.json",
      ".seedrop/view/tasks/malformed-a.json",
      ".seedrop/view/tasks/malformed-b.json",
      ".seedrop/view/handoffs/malformed.json",
      ".seedrop/view/signals/malformed.json",
      ".seedrop/view/signals-archive.json#/1",
      ".seedrop/view/knowledge/malformed.md",
      ".seedrop/view/resolved-threads.json#/resolved/1",
    ];
    for (const artifactPath of expectedPaths) {
      const issue = report.issues.find((candidate) => candidate.path === artifactPath);
      expect(issue, artifactPath).toBeDefined();
      expect(issue?.message.length, artifactPath).toBeGreaterThan(0);
    }

    const taskIssues = report.issues.filter((issue) => issue.code === "tasks_malformed");
    expect(taskIssues).toHaveLength(2);
    expect(taskIssues[0]?.message).not.toEqual(taskIssues[1]?.message);
    expect(report.checks?.find((check) => check.id === "tasks")).toMatchObject({
      status: "fail",
      details: { completeness: "partial", records_count: 1, diagnostics_count: 2 },
    });

    for (const family of AUDITED_FAMILIES) {
      expect(report.checks?.find((check) => check.id === family)?.status, family).toBe("fail");
    }
  });
});
