#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildClaimRecord,
  buildEpisodeRecord,
  buildIntentRecord,
  buildLeaseRecord,
  buildLeaseTransition,
  buildWorkCorrection,
  buildWorkLifecycleTransition,
  buildWorkReceipt,
  canonicalJson,
  canonicalJsonDigest,
  generateCanonicalId,
} from "../dist/index.js";

const mode = process.argv[2] ?? "--check";
if (mode !== "--write" && mode !== "--check") throw new Error("usage: generate-work-golden.mjs [--write|--check]");
const makeId = (kind, seed) => generateCanonicalId(kind, {
  now: 1_723_379_696_000 + seed,
  entropy: Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff),
});
const at = "2026-08-11T14:00:00.000Z";
const ids = {
  project: makeId("project", 40), principal: makeId("principal", 41), command: makeId("command", 42),
  intent: makeId("intent", 43), episode: makeId("episode", 44), claim: makeId("claim", 45),
  receipt: makeId("receipt", 46), lease: makeId("lease", 47), event: makeId("event", 48),
};
const inputs = {
  intent: { intent_id: ids.intent, project_id: ids.project, title: "Native vertical slice", state: "queued", created_by: ids.principal, created_at: at },
  intent_transition: { lifecycle: "intent", subject_id: ids.intent, from: "queued", to: "active", reason: "episode_started", actor_principal_id: ids.principal, recorded_at: at },
  episode: { episode_id: ids.episode, project_id: ids.project, intent_id: ids.intent, goal: "Prove work truth", state: "active", started_by: ids.principal, started_at: at },
  claim: { claim_id: ids.claim, project_id: ids.project, intent_id: ids.intent, episode_id: ids.episode, claim_kind: "scope", statement: "Own protocol/src/work.ts", evidence_digests: [], corrects_claim_id: null, recorded_by: ids.principal, recorded_at: at },
  lease: { lease_id: ids.lease, project_id: ids.project, target: "protocol/src/work.ts", holder_principal_id: ids.principal, intent_id: ids.intent, episode_id: ids.episode, state: "active", acquired_at: at, expires_at: "2026-08-11T14:01:00.000Z" },
  receipt: { receipt_id: ids.receipt, receipt_kind: "episode_started", command_id: ids.command, principal_id: ids.principal, project_id: ids.project, subject_id: ids.episode, issued_at: at, summary: "Episode started", evidence_digest: null },
  lease_expiry: { lease_id: ids.lease, from: "active", to: "expired", reason: "ttl_elapsed", actor_principal_id: ids.principal, recorded_at: "2026-08-11T14:01:00.000Z" },
  correction: { lifecycle: "episode", subject_id: ids.episode, corrects_event_id: ids.event, from: "reported_complete", to: "active", reason: "wrong build", actor_principal_id: ids.principal, recorded_at: "2026-08-11T14:02:00.000Z" },
};
const outputs = {
  intent: buildIntentRecord(inputs.intent),
  intent_transition: buildWorkLifecycleTransition(inputs.intent_transition),
  episode: buildEpisodeRecord(inputs.episode),
  claim: buildClaimRecord(inputs.claim),
  lease: buildLeaseRecord(inputs.lease),
  receipt: buildWorkReceipt(inputs.receipt),
  lease_expiry: buildLeaseTransition(inputs.lease_expiry),
  correction: buildWorkCorrection(inputs.correction),
};
const fixture = {
  fixture_version: "1.0.0",
  inputs,
  outputs,
  canonical_json: canonicalJson(outputs),
  digest: canonicalJsonDigest(outputs),
};
const contents = `${JSON.stringify(fixture, null, 2)}\n`;
const path = fileURLToPath(new URL("../fixtures/work-v1.json", import.meta.url));
if (mode === "--write") {
  await writeFile(path, contents);
  console.log(JSON.stringify({ ok: true, mode, path, digest: fixture.digest }));
} else {
  const { readFile } = await import("node:fs/promises");
  if (await readFile(path, "utf8") !== contents) throw new Error("work fixture drift");
  console.log(JSON.stringify({ ok: true, mode, digest: fixture.digest }));
}
