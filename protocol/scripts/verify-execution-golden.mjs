#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildCommandCommitReceipt,
  buildOutboxDeliveryReceipt,
  buildOutboxEffect,
  canonicalJson,
  canonicalJsonDigest,
} from "../dist/index.js";

const path = fileURLToPath(new URL("../fixtures/execution-v1.json", import.meta.url));
const fixture = JSON.parse(await readFile(path, "utf8"));
const outputs = {
  effect: buildOutboxEffect(fixture.inputs.effect),
  delivery: buildOutboxDeliveryReceipt(fixture.inputs.delivery),
  commit: buildCommandCommitReceipt(fixture.inputs.commit),
};
assert.deepEqual(outputs, fixture.outputs);
assert.equal(canonicalJson(outputs), fixture.canonical_json);
assert.equal(canonicalJsonDigest(outputs), fixture.digest);

console.log(JSON.stringify({
  ok: true,
  node: process.version,
  fixture_version: fixture.fixture_version,
  digest: fixture.digest,
}));
