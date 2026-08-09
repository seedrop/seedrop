import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertHealthEnvelope,
  buildHealthEnvelope,
  canonicalJsonDigest,
} from "../dist/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/health-envelope-v1.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const results = [];

for (const testCase of fixture.cases) {
  const input = applyMutation(fixture.base, testCase.mutation);
  const envelope = buildHealthEnvelope(input);
  assertHealthEnvelope(envelope);
  const reasonCodes = envelope.reasons.map((reason) => reason.code);
  const digest = canonicalJsonDigest(envelope);
  assert.equal(envelope.substrate, testCase.expected.substrate, testCase.name);
  assert.deepEqual(reasonCodes, testCase.expected.reason_codes, testCase.name);
  if (testCase.expected.canonical_digest !== "pending") {
    assert.equal(digest, testCase.expected.canonical_digest, testCase.name);
  }
  results.push({ name: testCase.name, substrate: envelope.substrate, reason_codes: reasonCodes, canonical_digest: digest });
}

console.log(JSON.stringify({
  ok: true,
  node: process.version,
  fixture_version: fixture.fixture_version,
  cases: results,
}));

function applyMutation(base, mutation) {
  const input = structuredClone(base);
  if (mutation.projection_version) input.projection_version = mutation.projection_version;
  if (mutation.remove_source_ids) {
    const removed = new Set(mutation.remove_source_ids);
    input.sources = input.sources.filter((source) => !removed.has(source.source_id));
  }
  if (mutation.source_status) {
    input.sources = input.sources.map((source) => source.source_id === mutation.source_status.source_id
      ? { ...source, status: mutation.source_status.status }
      : source);
  }
  if (mutation.add_sources) input.sources.push(...structuredClone(mutation.add_sources));
  for (const field of ["quarantined", "stale_projections", "pending_commands", "disagreements", "budget"]) {
    if (mutation[field] !== undefined) input[field] = structuredClone(mutation[field]);
  }
  return input;
}
