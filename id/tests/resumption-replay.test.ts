import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFrozenPr15Replay,
  freezePr15Replay,
  loadFrozenPr15Replays,
  type Pr15ReplayInput,
} from "../benchmarks/resumption/replay.js";

describe("PR-15 frozen replays", () => {
  it("freezes four complete immutable arms with identity and sanitation bindings", () => {
    const first = freezePr15Replay(input());
    const second = freezePr15Replay(input());
    expect(first).toEqual(second);
    expect(first.arms.repo_only.content).toContain("repo at commit");
    expect(first.arms.repo_only.content).not.toContain("current v1");
    expect(first.arms.current_v1.content).toContain("current v1");
    expect(first.arms.current_v1.content).toContain("repo at commit");
    expect(first.arms.packet_only.content).toContain('"adapter_version":"1.0.0"');
    expect(first.arms.packet_only.content).not.toContain("repo at commit");
    expect(first.arms.v2_situation.content).toContain("repo at commit");
    expect(first.wave7.situation_outcome).toBe("served");
    expect(first.wave7.sanitation_receipt).toMatch(/^sha256:/);
    expect(() => assertFrozenPr15Replay(JSON.parse(JSON.stringify(first)))).not.toThrow();
    expect(Object.isFrozen(first.arms.v2_situation)).toBe(true);
  });

  it("rejects future ground truth relative to the evidence cutoff", () => {
    const value = input();
    value.probes[0]!.wave7!.ground_truth_observed_at = "2026-08-14T00:00:00.000Z";
    expect(() => freezePr15Replay(value)).toThrow(/future_ground_truth/);
  });

  it("rejects a semantic identity mismatch or writable adapter envelope", () => {
    const mismatch = input();
    mismatch.projection.decision_id = digest("f");
    expect(() => freezePr15Replay(mismatch)).toThrow(/projection_identity_mismatch:decision_id/);
    const writable = input();
    writable.projection.adapter_situation_json = writable.projection.adapter_situation_json.replace("read_only", "write");
    expect(() => freezePr15Replay(writable)).toThrow(/projection_version_or_capability/);
  });

  it("rejects sanitation that is not passed and source-bound", () => {
    const value = input();
    value.sanitation.source_set_digest = digest("e");
    expect(() => freezePr15Replay(value)).toThrow(/sanitation_evidence_invalid/);
  });

  it("detects a changed frozen arm even when its top-level shape remains valid", () => {
    const value = JSON.parse(JSON.stringify(freezePr15Replay(input()))) as Record<string, unknown>;
    (value.arms as Record<string, { content: string }>).repo_only!.content += " changed";
    expect(() => assertFrozenPr15Replay(value)).toThrow(/arm_invalid:repo_only/);
  });

  it("loads only validated immutable replay JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "seedrop-pr15-replays-"));
    const replay = freezePr15Replay(input());
    await writeFile(join(root, "fixture.json"), JSON.stringify(replay));
    expect(await loadFrozenPr15Replays(root)).toEqual([replay]);
    await writeFile(join(root, "changed.json"), JSON.stringify({ ...replay, fixture_digest: digest("f") }));
    await expect(loadFrozenPr15Replays(root)).rejects.toThrow(/fixture_digest_mismatch/);
  });
});

function input(): Pr15ReplayInput {
  const semanticBody = {
    adapter_version: "1.0.0",
    situation_id: digest("a"),
    decision_id: digest("b"),
    bucket: "up_next",
    readiness: "ready",
    health: { state: "healthy" },
    decision: { disposition: "recommend", action: "resume_intent", reason: null, smallest_repair: null, display: "resume_intent" },
    orientation: {}, trust: {}, budget: {}, warnings: [], mutation_capability: "read_only",
  };
  const adapter = { ...semanticBody, semantic_digest: sha256(canonicalJson(semanticBody)) };
  return {
    fixture_id: "fixture-one",
    scenario: "safe resumption",
    project_name: "seedrop",
    repository: { repo_id: "seedrop", commit: "a".repeat(40), evidence_cutoff: "2026-08-13T00:00:00.000Z", source_digest: digest("d") },
    projection: { adapter_situation_json: JSON.stringify(adapter), situation_id: adapter.situation_id,
      decision_id: adapter.decision_id, semantic_digest: adapter.semantic_digest, projection_version: "1.0.0",
      policy_version: "1.0.0", situation_outcome: "served" },
    evidence: { repo_only: "repo at commit", current_v1: "current v1 orientation" },
    probes: [{ id: "intent", question: "What is current?", check: { kind: "regex", pattern: "resume", correct_when: "matches" },
      wave7: { probe_class: "current_intent", independence_key: "seedrop:intent:1", ground_truth_source_digest: digest("d"),
        ground_truth_observed_at: "2026-08-12T00:00:00.000Z" } }],
    sanitation: { reviewed_by: "fixture-reviewer", reviewed_at: "2026-08-13T01:00:00.000Z", scanner: "gitleaks",
      command: "gitleaks detect --no-git", status: "passed", source_set_digest: digest("d"), excluded_secret_paths: [] },
  };
}

function digest(letter: string): string {
  return `sha256:${letter.repeat(64)}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
