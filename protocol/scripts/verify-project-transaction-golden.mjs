#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildProjectTransaction,
  projectTransactionBytes,
  projectTransactionDigest,
} from "../dist/index.js";

const path = fileURLToPath(new URL("../fixtures/project-transaction-v1.json", import.meta.url));
const fixture = JSON.parse(await readFile(path, "utf8"));
const transaction = buildProjectTransaction(fixture.transaction);
const bytes = projectTransactionBytes(transaction);

assert.equal(new TextDecoder().decode(bytes), fixture.canonical_json);
assert.equal(Buffer.from(bytes).toString("hex"), fixture.utf8_hex);
assert.equal(projectTransactionDigest(transaction), fixture.digest);

console.log(JSON.stringify({
  ok: true,
  node: process.version,
  fixture_version: fixture.fixture_version,
  digest: fixture.digest,
}));
