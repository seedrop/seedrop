#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildCommandCommitReceipt,
  buildOutboxDeliveryReceipt,
  buildOutboxEffect,
  canonicalJson,
  canonicalJsonDigest,
  generateCanonicalId,
} from "../dist/index.js";

const mode = process.argv[2] ?? "--check";
if (mode !== "--write" && mode !== "--check") throw new Error("usage: generate-execution-golden.mjs [--write|--check]");

const makeId = (kind, seed) => generateCanonicalId(kind, {
  now: 1_723_379_696_000 + seed,
  entropy: Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff),
});
const commandId = makeId("command", 20);
const projectId = makeId("project", 21);
const principalId = makeId("principal", 22);
const effectInput = {
  effect_id: makeId("event", 23),
  effect_key: "execution-golden:notify",
  command_id: commandId,
  project_id: projectId,
  effect_type: "notification.execution.completed",
  declared_at: "2026-08-11T10:00:00.000Z",
  required: true,
  payload: { command_id: commandId, message: "Zażółć 🪴" },
};
const effect = buildOutboxEffect(effectInput);
const deliveryInput = {
  receipt_id: makeId("receipt", 24),
  effect_id: effect.effect_id,
  effect_key: effect.effect_key,
  command_id: commandId,
  project_id: projectId,
  state: "delivered",
  attempt: 1,
  recorded_at: "2026-08-11T10:00:01.000Z",
  evidence_digest: effect.payload_digest,
  error: null,
};
const delivery = buildOutboxDeliveryReceipt(deliveryInput);
const commitInput = {
  receipt_id: makeId("receipt", 25),
  command_id: commandId,
  principal_id: principalId,
  project_id: projectId,
  command_name: "intent.execution_golden",
  idempotency_key: "execution-golden-v1",
  input_digest: canonicalJsonDigest({ title: "golden" }),
  transaction_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  projection_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  outcome: "completed",
  outbox_effect_count: 1,
  outbox_delivered_count: 1,
  recorded_at: delivery.recorded_at,
  recovery: null,
  error: null,
};
const commit = buildCommandCommitReceipt(commitInput);
const outputs = { effect, delivery, commit };
const fixture = {
  fixture_version: "1.0.0",
  inputs: { effect: effectInput, delivery: deliveryInput, commit: commitInput },
  outputs,
  canonical_json: canonicalJson(outputs),
  digest: canonicalJsonDigest(outputs),
};
const contents = `${JSON.stringify(fixture, null, 2)}\n`;
const path = fileURLToPath(new URL("../fixtures/execution-v1.json", import.meta.url));

if (mode === "--write") {
  await writeFile(path, contents);
  console.log(JSON.stringify({ ok: true, mode, path, digest: fixture.digest }));
} else {
  const { readFile } = await import("node:fs/promises");
  if (await readFile(path, "utf8") !== contents) throw new Error("execution fixture drift");
  console.log(JSON.stringify({ ok: true, mode, digest: fixture.digest }));
}
