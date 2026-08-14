#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJsonDigest } from "@seedrop/protocol";
import { freezePr15ReplayFromServed } from "../id/benchmarks/resumption/replay.ts";
import { boundedSituation, servedReplayInput } from "../id/tests/pr15-served-fixture.ts";
import { deriveProbeCandidates, sanitizeEvidence } from "./pr15-corpus.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("derives independently bound candidates across all six PR-15 classes", () => {
  const adapter = fixture();
  const probes = deriveProbeCandidates(adapter, "2026-08-13T00:00:00.000Z", "project:test");
  assert.deepEqual(new Set(probes.map((item) => item.wave7.probe_class)), new Set([
    "current_intent", "unsafe_condition", "delivery_state", "relevant_failed_attempt", "evidence_gap", "safest_next_action",
  ]));
  assert.equal(new Set(probes.map((item) => item.wave7.independence_key)).size, probes.length);
  const next = probes.find((item) => item.wave7.probe_class === "safest_next_action");
  assert.equal(next.wave7.task_linked, true);
  assert.equal(next.wave7.expected_behavior, "refuse");
  assert.ok(next.wave7.repeated_dead_work_check);
  assert.ok(next.wave7.missed_uncommitted_work_check);
});

test("redacts secret-shaped material and records the sanitation class", () => {
  const result = sanitizeEvidence("v1", "token=sk-abcdefghijklmnopqrstuvwxyz012345 and safe text");
  assert.doesNotMatch(result.value, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(result.value, /REDACTED:openai_style_key/);
  assert.deepEqual(result.redactions, ["v1:openai_style_key"]);
});

test("verify gate refuses a corpus not sealed through the live boot compiler", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr15-verify-"));
  const frozen = join(root, "frozen");
  await mkdir(frozen);
  const bounded = boundedSituation();
  const replay = freezePr15ReplayFromServed({ ...servedReplayInput({}, bounded), bounded });
  await writeFile(join(frozen, "one.json"), `${JSON.stringify(replay)}\n`);
  await writeFile(join(root, "review-manifest.json"), `${JSON.stringify({ pipeline_version: "1.0.0" })}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-pr15-served-corpus.mjs", frozen], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /compileLiveBoundedSituation/);
});

function fixture() {
  const orientation = {
    intent: { intent_id: "intent:1", title: "Resume proof", state: "blocked", episode_id: "episode:1", goal: "Prove value" },
    risk: [{ code: "uncommitted", severity: "high", summary: "Work is local", source_ids: ["project"] }],
    delivery: { subject_id: "episode:1", reported_lifecycle: "reported_complete", evidence: "passed",
      delivery: "uncommitted", contradictions: ["reported_complete_but_uncommitted"] },
    grave: { subject_id: "episode:0", kind: "failed", cause: "unsafe retry", retry_status: "blocked",
      retry_condition: "new evidence", completeness: "complete" },
    source_health: { substrate: "healthy", degraded_source_ids: [], quarantine_count: 0, unresolved_disagreement_count: 0 },
    next_action: { disposition: "refuse", reason: "evidence missing", blocking_unknowns: ["delivery"],
      evidence_requests: ["commit receipt"], smallest_repair: "inspect git" },
  };
  const trust = Object.fromEntries(Object.keys(orientation).map((key) => [key,
    { freshness: key === "delivery" ? "stale" : "current", completeness: "complete", source_ids: ["project"],
      missing: key === "delivery" ? ["commit receipt"] : [] }]));
  const body = { adapter_version: "1.0.0", situation_id: digest("a"), decision_id: digest("b"), bucket: "needs_attention",
    readiness: "blocked", health: { state: "degraded", substrate: "healthy", freshness: "stale", completeness: "complete",
      degraded_source_ids: [], quarantine_count: 0, unresolved_disagreement_count: 0 },
    decision: { disposition: "refuse", action: null, reason: "evidence missing", smallest_repair: "inspect git", display: "inspect git" },
    orientation, trust, budget: { requested_bytes: 4096, actual_bytes: 2000, complete: true, candidate_count: 10,
      indexed_count: 10, scanned_count: 0, event_count: 10, file_count: 5, omitted_categories: [] },
    warnings: ["freshness:stale"], mutation_capability: "read_only" };
  return { ...body, semantic_digest: canonicalJsonDigest(body) };
}
function digest(letter) { return `sha256:${letter.repeat(64)}`; }
