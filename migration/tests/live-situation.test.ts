import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileLiveBoundedSituation, digestReadOnlyTree } from "../src/index.js";
import { compileAdapterSituation } from "@seedrop/situation";
import { freezePr15ReplayFromServed, servedSituationFromArm } from "../../id/benchmarks/resumption/replay.js";

const roots: string[] = [];
const AT = "2026-08-14T12:00:00.000Z";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live bounded Situation compile", () => {
  it("compiles a read-only 4 KiB Situation from a v1 View without mutating it", async () => {
    const fixture = await createFixture();
    const before = await digestReadOnlyTree(fixture.viewRoot);
    const first = await compileLiveBoundedSituation({
      repo_root: fixture.repoRoot,
      view_root: fixture.viewRoot,
      identity_root: fixture.identityRoot,
      principal_alias: "agent-a",
      outcome_report_path: fixture.outcomePath,
      requested_bytes: 4096,
    });
    const second = await compileLiveBoundedSituation({
      repo_root: fixture.repoRoot,
      view_root: fixture.viewRoot,
      identity_root: fixture.identityRoot,
      principal_alias: "agent-a",
      outcome_report_path: fixture.outcomePath,
      requested_bytes: 4096,
    });
    const after = await digestReadOnlyTree(fixture.viewRoot);
    expect(after).toBe(before);
    expect(first.view_unchanged).toBe(true);
    expect(first.bytes).toBeLessThanOrEqual(4096);
    expect(first.bounded.situation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.bounded.decision_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.bounded).toEqual(first.bounded);
    expect(first.bounded.orientation.next_action).toBeTruthy();
  });

  it("boot path does not spawn outcome-layer and stays deterministic without a report file", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.repoRoot, "scripts"), { recursive: true });
    await writeFile(join(fixture.repoRoot, "scripts", "outcome-layer.mjs"), "process.exit(99);\n");
    const before = await digestReadOnlyTree(fixture.viewRoot);
    const first = await compileLiveBoundedSituation({
      repo_root: fixture.repoRoot,
      view_root: fixture.viewRoot,
      identity_root: fixture.identityRoot,
      principal_alias: "agent-a",
      requested_bytes: 4096,
    });
    const second = await compileLiveBoundedSituation({
      repo_root: fixture.repoRoot,
      view_root: fixture.viewRoot,
      identity_root: fixture.identityRoot,
      principal_alias: "agent-a",
      requested_bytes: 4096,
    });
    expect(await digestReadOnlyTree(fixture.viewRoot)).toBe(before);
    expect(first.view_unchanged).toBe(true);
    expect(first.bytes).toBeLessThanOrEqual(4096);
    expect(first.bounded.orientation.next_action).toBeTruthy();
    expect(second.bounded).toEqual(first.bounded);
  });

  it("seals PR-15 packet_only from the live compile boot serves", async () => {
    const fixture = await createFixture();
    const live = await compileLiveBoundedSituation({
      repo_root: fixture.repoRoot,
      view_root: fixture.viewRoot,
      identity_root: fixture.identityRoot,
      principal_alias: "agent-a",
      requested_bytes: 4096,
    });
    const served = compileAdapterSituation(live.bounded);
    const replay = freezePr15ReplayFromServed({
      fixture_id: "live-boot",
      scenario: "live boot seal",
      project_name: "fixture",
      bounded: live.bounded,
      repository: {
        repo_id: "fixture",
        commit: "a".repeat(40),
        evidence_cutoff: live.observed_at,
        source_digest: live.source_tree_digest,
      },
      evidence: { repo_only: "repo at commit", current_v1: "current v1 orientation" },
      probes: [{ id: "intent", question: "What is current?", check: { kind: "regex", pattern: "resume", correct_when: "matches" },
        wave7: { probe_class: "current_intent", independence_key: "fixture:intent:1",
          ground_truth_source_digest: live.source_tree_digest, ground_truth_observed_at: live.observed_at,
          expected_behavior: "answer", safety_invariant_check: { kind: "regex", pattern: "resume", correct_when: "matches" } } }],
      sanitation: { reviewed_by: "fixture-reviewer", reviewed_at: live.observed_at, scanner: "gitleaks",
        command: "gitleaks detect --no-git", status: "passed", source_set_digest: live.source_tree_digest,
        excluded_secret_paths: [] },
    });
    expect(replay.wave7.situation_id).toBe(served.situation_id);
    expect(replay.wave7.decision_id).toBe(served.decision_id);
    expect(servedSituationFromArm(replay.arms.packet_only.content)).toEqual(served);
    expect(replay.arms.packet_only.content).not.toContain("repo at commit");
    expect(replay.arms.v2_situation.content).toContain("repo at commit");
    expect(servedSituationFromArm(replay.arms.v2_situation.content)).toEqual(served);
  });
});

async function createFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), "seedrop-live-situation-"));
  roots.push(repoRoot);
  const viewRoot = join(repoRoot, ".seedrop", "view");
  const identityRoot = join(repoRoot, "identity");
  await Promise.all([
    mkdir(join(viewRoot, "tasks"), { recursive: true }),
    mkdir(join(viewRoot, "runs"), { recursive: true }),
    mkdir(join(viewRoot, "continuity"), { recursive: true }),
    mkdir(identityRoot, { recursive: true }),
  ]);
  await writeJson(join(viewRoot, "tasks", `${TASK_ID}.json`), {
    schema_version: "1.0",
    task_id: TASK_ID,
    title: "Serve live Situation",
    status: "in_progress",
    owner: "agent-a",
    created_at: AT,
    updated_at: AT,
    related_runs: [RUN_ID],
  });
  await writeJson(join(viewRoot, "runs", `${RUN_ID}.json`), {
    schema_version: "1.0",
    run_id: RUN_ID,
    agent_id: "agent-a",
    goal: "Compile live Situation",
    status: "in_progress",
    started_at: AT,
    updated_at: AT,
    steps: [],
    decisions: [],
    assumptions: [],
    open_threads: [],
    changed_paths: ["cli/src/boot.ts"],
    validation: [],
    next_actions: [],
  });
  await writeJson(join(identityRoot, "passport.json"), {
    version: "1.0",
    agent_id: "agent-a",
    name: "Agent A",
    purpose: "Compile live Situation fixtures",
    core_commitments: ["Stay read-only"],
    value_anchors: [{ name: "truth", priority: 1 }],
    competencies: ["orientation"],
    limits: ["no spend"],
    learned_blocks: [],
    active_projects: [{ id: "fixture", root: repoRoot }],
    metadata: { created_at: AT, session_count: 1 },
  });
  const outcomePath = join(repoRoot, "outcome.json");
  await writeJson(outcomePath, {
    generated_at: AT,
    grace_days: 7,
    repos: [{
      root: repoRoot,
      head: "b".repeat(40),
      runs_total: 1,
      runs_labeled: 1,
      runs: [{ run_id: RUN_ID, agent_id: "agent-a", outcome: "uncommitted" }],
    }],
  });
  return { repoRoot, viewRoot, identityRoot, outcomePath };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
