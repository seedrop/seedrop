#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
} from "../dist/index.js";

const path = fileURLToPath(new URL("../fixtures/work-v1.json", import.meta.url));
const fixture = JSON.parse(await readFile(path, "utf8"));
const outputs = {
  intent: buildIntentRecord(fixture.inputs.intent),
  intent_transition: buildWorkLifecycleTransition(fixture.inputs.intent_transition),
  episode: buildEpisodeRecord(fixture.inputs.episode),
  claim: buildClaimRecord(fixture.inputs.claim),
  lease: buildLeaseRecord(fixture.inputs.lease),
  receipt: buildWorkReceipt(fixture.inputs.receipt),
  lease_expiry: buildLeaseTransition(fixture.inputs.lease_expiry),
  correction: buildWorkCorrection(fixture.inputs.correction),
};
assert.deepEqual(outputs, fixture.outputs);
assert.equal(canonicalJson(outputs), fixture.canonical_json);
assert.equal(canonicalJsonDigest(outputs), fixture.digest);
console.log(JSON.stringify({ ok: true, node: process.version, fixture_version: fixture.fixture_version, digest: fixture.digest }));
