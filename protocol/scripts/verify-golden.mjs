import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CURRENT_VERSION_ENVELOPE,
  CANONICAL_ID_KIND_CODES,
  ERROR_REGISTRY,
  PROTOCOL_ENVELOPE_MIGRATIONS,
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
  generateCanonicalId,
  migrationPlanMetadata,
} from "../dist/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/golden-v2-contract.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const entropy = Uint8Array.from(Buffer.from(fixture.canonical_id.entropy_hex, "hex"));

assert.equal(
  generateCanonicalId(fixture.canonical_id.kind, {
    now: fixture.canonical_id.timestamp_ms,
    entropy,
  }),
  fixture.canonical_id.value,
);
assert.deepEqual(CANONICAL_ID_KIND_CODES, fixture.id_kind_codes);
assert.equal(canonicalJson(fixture.canonical_json.value), fixture.canonical_json.text);
assert.equal(Buffer.from(canonicalJsonBytes(fixture.canonical_json.value)).toString("hex"), fixture.canonical_json.utf8_hex);
assert.equal(canonicalJsonDigest(fixture.canonical_json.value), fixture.canonical_json.sha256);
assert.deepEqual(ERROR_REGISTRY, fixture.error_registry);
assert.deepEqual(CURRENT_VERSION_ENVELOPE, fixture.versions);
assert.deepEqual(migrationPlanMetadata(PROTOCOL_ENVELOPE_MIGRATIONS), fixture.migration_plan);

console.log(JSON.stringify({
  ok: true,
  node: process.version,
  fixture_version: fixture.fixture_version,
  id: fixture.canonical_id.value,
  digest: fixture.canonical_json.sha256,
}));
