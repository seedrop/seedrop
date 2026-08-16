import { describe, expect, it } from "vitest";
import {
  continuityWarningReferent,
  renderContinuity,
  splitContinuityClaims,
  type ContinuityReport,
} from "../src/continuity.js";

function report(): ContinuityReport {
  return {
    passportPath: "/tmp/passports/codex.json",
    passport: { agent_id: "codex" },
    cwd: "/repo",
    root: "/repo",
    rootKind: "git",
    watermarkAdvanced: false,
    view: {
      present: true,
      manifest: { workspace_id: "ledgerd" },
      signals: [],
      latestPacket: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        mission: "WireFormat soak review",
        decisions: ["Soak review supersedes ADR 0007; schema changes require normal review."],
      },
      activeTasks: [],
      blockerTasks: [],
      openTasksCount: 0,
      otherAgents: [],
    },
    cachedAudit: null,
    graves: [],
    daemon: { url: "http://127.0.0.1:18791", reachable: false, presence: [] },
    inbox: { unacked: [], fetched: true },
    joinedSpaces: [],
    warnings: ["No passport at /tmp/passports/codex.json. Run `seed bootstrap` first."],
    orientation: {
      schema_version: "1.0",
      identity: { present: true, agent_id: "codex", passport_path: "/tmp/passports/codex.json", source: "passport" },
      place: { cwd: "/repo", root: "/repo", root_kind: "git", view_present: true, workspace_id: "ledgerd" },
      traces: { latest_continuity_at: null, current_run_id: null, current_run_goal: null, latest_run_status: null, open_signals: 0 },
      coordination: { daemon_reachable: false, inbox_unacked: 0, joined_spaces: [], online_sessions: 0 },
      health: { warnings: [], view_preflight_failed: false, view_success_level: null, view_success_required: null, view_success_meets_required: null },
      next_action: { kind: "focus", reason: "Resume the recorded focus.", source: "view", risk: "low", requires_human: false },
    },
  };
}

describe("weak-reader continuity rendering", () => {
  it("renders one governing claim per line with the record first", () => {
    const rendered = renderContinuity(report());
    const governing = rendered.split("\n").filter((line) => line.includes("Governing record:"));

    expect(governing).toEqual([
      "  Governing record: continuity aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa — Soak review supersedes ADR 0007",
      "  Governing record: continuity aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa — schema changes require normal review.",
    ]);
    expect(governing.every((line) => !line.includes(";"))).toBe(true);
  });

  it("names warning referents before the warning claim", () => {
    const rendered = renderContinuity(report());
    expect(rendered).toContain("Warning about /tmp/passports/codex.json: No passport at /tmp/passports/codex.json.");
    expect(continuityWarningReferent("View preflight has 2 failed checks.")).toBe("View preflight");
    expect(splitContinuityClaims("First claim; second claim.")).toEqual(["First claim", "second claim."]);
  });

  it("marks joined spaces whose newest message is a month old as stale", () => {
    const base = report();
    const ageDays = 90;
    const oldest = new Date(Date.now() - ageDays * 86_400_000).toISOString();
    const withStaleSpace = {
      ...base,
      joinedSpaces: [{
        name: "seedrop-team",
        presence: [],
        recentMessages: [{ author_passport_id: "claude", content: "old handoff", created_at: oldest }],
        unreachable: false,
      }],
    };
    const rendered = renderContinuity(withStaleSpace, "full");
    expect(rendered).toContain("stale — newest message is 90d old; do not treat this channel as live coordination");
  });
});
