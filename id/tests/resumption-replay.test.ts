import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFrozenPr15Replay,
  freezePr15Replay,
  freezePr15ReplayFile,
  freezePr15ReplayFromServed,
  loadFrozenPr15Replays,
  servedSituationFromArm,
} from "../benchmarks/resumption/replay.js";
import { boundedSituation, brochureReplayInput, servedAdapter, servedReplayInput } from "./pr15-served-fixture.js";

describe("PR-15 frozen replays", () => {
  it("freezes four complete immutable arms with identity and sanitation bindings", () => {
    const first = freezePr15Replay(servedReplayInput());
    const second = freezePr15Replay(servedReplayInput());
    expect(first).toEqual(second);
    expect(first.arms.repo_only.content).toContain("repo at commit");
    expect(first.arms.repo_only.content).not.toContain("current v1");
    expect(first.arms.current_v1.content).toContain("current v1");
    expect(first.arms.current_v1.content).toContain("repo at commit");
    expect(first.arms.packet_only.content).toContain('"adapter_version":"1.0.0"');
    expect(first.arms.packet_only.content).not.toContain("repo at commit");
    expect(servedSituationFromArm(first.arms.packet_only.content)).toEqual(servedAdapter());
    expect(servedSituationFromArm(first.arms.v2_situation.content)).toEqual(servedAdapter());
    expect(first.arms.v2_situation.content).toContain("repo at commit");
    expect(first.wave7.situation_outcome).toBe("served");
    expect(first.wave7.sanitation_receipt).toMatch(/^sha256:/);
    expect(() => assertFrozenPr15Replay(JSON.parse(JSON.stringify(first)))).not.toThrow();
    expect(Object.isFrozen(first.arms.v2_situation)).toBe(true);
  });

  it("rejects a brochure that boot would not serve", () => {
    expect(() => freezePr15Replay(brochureReplayInput())).toThrow(/health_invalid|orientation_invalid|budget_invalid|semantic_digest_mismatch/);
  });

  it("seals packet_only and v2_situation from the compiled bounded Situation", () => {
    const bounded = boundedSituation();
    const replay = freezePr15ReplayFromServed({ ...servedReplayInput({}, bounded), bounded });
    const served = servedAdapter();
    expect(replay.wave7.situation_id).toBe(served.situation_id);
    expect(replay.wave7.decision_id).toBe(served.decision_id);
    expect(servedSituationFromArm(replay.arms.packet_only.content)).toEqual(served);
    expect(replay.arms.packet_only.content).not.toContain("repo at commit");
    expect(replay.arms.v2_situation.content).toContain("repo at commit");
    expect(servedSituationFromArm(replay.arms.v2_situation.content)).toEqual(served);
  });

  it("rejects future ground truth relative to the evidence cutoff", () => {
    const value = servedReplayInput();
    value.probes[0]!.wave7!.ground_truth_observed_at = "2026-08-14T00:00:00.000Z";
    expect(() => freezePr15Replay(value)).toThrow(/future_ground_truth/);
  });

  it("rejects a semantic identity mismatch or writable adapter envelope", () => {
    const mismatch = servedReplayInput();
    mismatch.projection.decision_id = `sha256:${"f".repeat(64)}`;
    expect(() => freezePr15Replay(mismatch)).toThrow(/projection_identity_mismatch:decision_id/);
    const writable = servedReplayInput();
    writable.projection.adapter_situation_json = writable.projection.adapter_situation_json.replace("read_only", "write");
    expect(() => freezePr15Replay(writable)).toThrow(/projection_version_or_capability|version_or_capability/);
  });

  it("rejects sanitation that is not passed and source-bound", () => {
    const value = servedReplayInput();
    value.sanitation.source_set_digest = `sha256:${"e".repeat(64)}`;
    expect(() => freezePr15Replay(value)).toThrow(/sanitation_evidence_invalid/);
  });

  it("detects a changed frozen arm even when its top-level shape remains valid", () => {
    const value = JSON.parse(JSON.stringify(freezePr15Replay(servedReplayInput()))) as Record<string, unknown>;
    (value.arms as Record<string, { content: string }>).repo_only!.content += " changed";
    expect(() => assertFrozenPr15Replay(value)).toThrow(/arm_invalid:repo_only/);
  });

  it("loads only validated immutable replay JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "seedrop-pr15-replays-"));
    const replay = freezePr15Replay(servedReplayInput());
    await writeFile(join(root, "fixture.json"), JSON.stringify(replay));
    expect(await loadFrozenPr15Replays(root)).toEqual([replay]);
    await writeFile(join(root, "changed.json"), JSON.stringify({ ...replay, fixture_digest: `sha256:${"f".repeat(64)}` }));
    await expect(loadFrozenPr15Replays(root)).rejects.toThrow(/fixture_digest_mismatch/);
  });

  it("freezes a reviewed candidate file without overwriting an existing receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "seedrop-pr15-freeze-"));
    const fixtures = join(root, "fixtures");
    await mkdir(fixtures);
    const candidate = join(root, "candidate.json"), output = join(fixtures, "frozen.json");
    await writeFile(candidate, JSON.stringify(servedReplayInput()));
    const frozen = await freezePr15ReplayFile(candidate, output);
    expect(await loadFrozenPr15Replays(fixtures)).toEqual([frozen]);
    await expect(freezePr15ReplayFile(candidate, output)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
