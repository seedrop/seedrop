#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FROZEN_REPO_SECTION,
  loadFrozenPr15Replays,
  servedSituationFromArm,
} from "../id/benchmarks/resumption/replay.ts";

const directory = resolve(process.argv[2] ?? "");
if (!directory || process.argv[2] === undefined) {
  throw new Error("Usage: node --import tsx scripts/verify-pr15-served-corpus.mjs <frozen-directory>");
}

const replays = await loadFrozenPr15Replays(directory);
assert.ok(replays.length > 0, `no frozen replays in ${directory}`);

const repoHeader = `=== ${FROZEN_REPO_SECTION} ===`;
for (const replay of replays) {
  const packet = servedSituationFromArm(replay.arms.packet_only.content);
  assert.equal(packet.situation_id, replay.wave7.situation_id, replay.id);
  assert.equal(packet.decision_id, replay.wave7.decision_id, replay.id);
  assert.equal(packet.semantic_digest, replay.wave7.semantic_digest, replay.id);
  assert.equal(
    replay.arms.packet_only.content.includes(repoHeader),
    false,
    `${replay.id} packet_only must not include repository evidence`,
  );
  assert.equal(
    replay.arms.v2_situation.content.includes(repoHeader),
    true,
    `${replay.id} v2_situation must include repository evidence`,
  );
  assert.deepEqual(servedSituationFromArm(replay.arms.v2_situation.content), packet, replay.id);
}

const manifestPath = join(directory, "..", "review-manifest.json");
assert.ok(existsSync(manifestPath), `missing review-manifest.json next to ${directory}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.compiler, "compileLiveBoundedSituation", "corpus must be sealed through the live boot compiler");

console.log(JSON.stringify({
  ok: true,
  frozen_directory: directory,
  fixtures: replays.length,
  packet_only_is_served_adapter: true,
  v2_situation_adds_repo: true,
}));
