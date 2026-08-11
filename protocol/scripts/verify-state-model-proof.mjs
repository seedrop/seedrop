#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(packageRoot, "scripts/generate-state-model-proof.mjs"), "--check"], {
  cwd: packageRoot,
  stdio: "inherit",
});

const protocol = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
const proofBytes = await readFile(join(packageRoot, "generated/state-model-proof.json"));
const proof = JSON.parse(proofBytes.toString("utf8"));
const fixture = JSON.parse(await readFile(join(packageRoot, "fixtures/state-model-proof-v1.json"), "utf8"));
const catalogBytes = await readFile(join(packageRoot, "generated/protocol-catalog.json"));

if (sha256(proofBytes) !== fixture.proof_sha256) throw new Error("state-model proof digest mismatch");
if (sha256(catalogBytes) !== fixture.source_catalog_sha256) throw new Error("state-model source catalog digest mismatch");
if (protocol.canonicalJson(proof.counts) !== protocol.canonicalJson(fixture.counts)) throw new Error("state-model proof count mismatch");

for (const model of proof.lifecycle_matrices) {
  if (model.reachable_states.length !== model.states.length) throw new Error(`unreachable lifecycle state: ${model.name}`);
  for (const row of model.matrix) {
    const permitted = protocol.canLifecycleTransition(model.name, row.from, row.to);
    if (permitted !== row.permitted) throw new Error(`transition disagreement: ${model.name} ${row.from} -> ${row.to}`);
    if (permitted) protocol.assertLifecycleTransition(model.name, row.from, row.to);
    else assertProtocolError(
      () => protocol.assertLifecycleTransition(model.name, row.from, row.to),
      "seedrop.protocol.lifecycle_transition_invalid",
    );
  }
}

const uniqueTrustStates = new Set();
for (const state of proof.trust_state_space.combinations) {
  const built = protocol.buildOrthogonalTrustState(state);
  uniqueTrustStates.add(protocol.canonicalJson(built));
}
if (uniqueTrustStates.size !== proof.trust_state_space.combination_count) throw new Error("trust state combinations collapsed");
for (const witness of proof.trust_state_space.pair_witnesses) {
  const state = proof.trust_state_space.combinations[witness.witness_index];
  if (state[witness.left_axis] !== witness.left_value || state[witness.right_axis] !== witness.right_value) {
    throw new Error(`invalid trust pair witness: ${witness.left_axis}/${witness.right_axis}`);
  }
}

for (const witness of proof.forbidden_implication_witnesses) {
  if (!holds(witness.antecedent, witness.counterexample)) throw new Error(`antecedent not witnessed: ${witness.id}`);
  if (holds(witness.consequent, witness.counterexample)) throw new Error(`forbidden implication not refuted: ${witness.id}`);
}
if (protocol.canonicalJson(proof.observed_state_classes) !== protocol.canonicalJson(protocol.OBSERVED_STATE_CLASSES)) {
  throw new Error("observed state classes drifted from runtime contract");
}
for (const stateClass of proof.observed_state_classes) {
  if (!protocol.isLifecycleState(stateClass.lifecycle, stateClass.lifecycle_state)) {
    throw new Error(`observed class has unknown lifecycle state: ${stateClass.id}`);
  }
  protocol.buildOrthogonalTrustState(stateClass.trust);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  node: process.version,
  suite: "state-model-proof-v1",
  counts: proof.counts,
  proof_sha256: fixture.proof_sha256,
})}\n`);

function holds(proposition, counterexample) {
  if (proposition.axis.endsWith("_lifecycle")) {
    return proposition.axis === `${counterexample.lifecycle}_lifecycle`
      && counterexample.lifecycle_state === proposition.value;
  }
  return counterexample.trust[proposition.axis] === proposition.value;
}

function assertProtocolError(action, code) {
  try {
    action();
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error(`expected ${code}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
