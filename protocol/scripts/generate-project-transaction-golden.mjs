#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildProjectTransaction,
  generateCanonicalId,
  projectTransactionBytes,
  projectTransactionDigest,
} from "../dist/index.js";

const mode = process.argv[2] ?? "--check";
if (mode !== "--write" && mode !== "--check") throw new Error("usage: generate-project-transaction-golden.mjs [--write|--check]");

const makeId = (kind, seed) => generateCanonicalId(kind, {
  now: 1_723_379_696_000 + seed,
  entropy: Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff),
});

const transaction = buildProjectTransaction({
  command_id: makeId("command", 1),
  command_version: "1.0.0",
  command_name: "project.record_golden_event",
  principal_id: makeId("principal", 2),
  project_id: makeId("project", 3),
  idempotency_key: "project-transaction-golden-v1",
  input_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  previous_transaction_digest: null,
  recorded_at: "2026-08-11T06:30:00.000Z",
  events: [{
    event_id: makeId("event", 4),
    event_type: "project.golden_recorded",
    subject_id: makeId("intent", 5),
    occurred_at: "2026-08-11T06:29:59.000Z",
    payload: { alpha: 1, nested: [true, null, "Zażółć 🪴"] },
  }],
});
const bytes = projectTransactionBytes(transaction);
const fixture = {
  fixture_version: "1.0.0",
  transaction,
  canonical_json: new TextDecoder().decode(bytes),
  utf8_hex: Buffer.from(bytes).toString("hex"),
  digest: projectTransactionDigest(transaction),
};
const contents = `${JSON.stringify(fixture, null, 2)}\n`;
const path = fileURLToPath(new URL("../fixtures/project-transaction-v1.json", import.meta.url));

if (mode === "--write") {
  await writeFile(path, contents);
  console.log(JSON.stringify({ ok: true, mode, path, digest: fixture.digest }));
} else {
  const { readFile } = await import("node:fs/promises");
  const actual = await readFile(path, "utf8");
  if (actual !== contents) throw new Error("project transaction fixture drift");
  console.log(JSON.stringify({ ok: true, mode, digest: fixture.digest }));
}
