#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") {
  throw new Error("usage: generate-state-model-proof.mjs [--check|--write]");
}

const catalogBytes = await readFile(join(packageRoot, "generated/protocol-catalog.json"));
const catalog = JSON.parse(catalogBytes.toString("utf8"));
const protocol = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
const lifecycleMatrices = Object.entries(catalog.core.lifecycles).map(([name, lifecycle]) => {
  const matrix = lifecycle.states.flatMap((from) => lifecycle.states.map((to) => ({
    from,
    to,
    permitted: lifecycle.transitions[from].includes(to),
  })));
  const reachable = reachableStates(lifecycle);
  return {
    name,
    states: lifecycle.states,
    initial: lifecycle.initial,
    terminal: lifecycle.terminal,
    pair_count: matrix.length,
    permitted_count: matrix.filter((row) => row.permitted).length,
    rejected_count: matrix.filter((row) => !row.permitted).length,
    reachable_states: reachable,
    matrix,
  };
});

const trustCombinations = cartesianTrustStates(catalog.core.trust_axes);
const axisNames = Object.keys(catalog.core.trust_axes);
const pairWitnesses = [];
for (let leftIndex = 0; leftIndex < axisNames.length; leftIndex += 1) {
  for (let rightIndex = leftIndex + 1; rightIndex < axisNames.length; rightIndex += 1) {
    const leftAxis = axisNames[leftIndex];
    const rightAxis = axisNames[rightIndex];
    for (const leftValue of catalog.core.trust_axes[leftAxis]) {
      for (const rightValue of catalog.core.trust_axes[rightAxis]) {
        const witnessIndex = trustCombinations.findIndex((state) => (
          state[leftAxis] === leftValue && state[rightAxis] === rightValue
        ));
        if (witnessIndex < 0) throw new Error(`missing pair witness ${leftAxis}/${rightAxis}`);
        pairWitnesses.push({ left_axis: leftAxis, left_value: leftValue, right_axis: rightAxis, right_value: rightValue, witness_index: witnessIndex });
      }
    }
  }
}

const forbiddenWitnesses = protocol.FORBIDDEN_CROSS_AXIS_IMPLICATIONS.map((implication) => {
  const lifecycleAxis = [implication.antecedent.axis, implication.consequent.axis]
    .find((axis) => axis.endsWith("_lifecycle"));
  const lifecycle = lifecycleAxis ? lifecycleAxis.replace("_lifecycle", "") : "intent";
  const lifecycleStates = catalog.core.lifecycles[lifecycle].states;
  const lifecycleState = implication.antecedent.axis === `${lifecycle}_lifecycle`
    ? implication.antecedent.value
    : lifecycleStates.find((state) => state !== implication.consequent.value) ?? lifecycleStates[0];
  const trust = trustCombinations.find((state) => (
    propositionHolds(implication.antecedent, lifecycle, lifecycleState, state)
    && !propositionHolds(implication.consequent, lifecycle, lifecycleState, state)
  ));
  if (!trust) throw new Error(`missing forbidden implication witness: ${implication.id}`);
  return {
    id: implication.id,
    antecedent: implication.antecedent,
    consequent: implication.consequent,
    counterexample: { lifecycle, lifecycle_state: lifecycleState, trust },
  };
});

const proof = {
  artifact: "seedrop-v2-state-model-proof",
  proof_version: "1.0.0",
  inventory_version: catalog.core.inventory_version,
  source_catalog_sha256: sha256(catalogBytes),
  lifecycle_matrices: lifecycleMatrices,
  trust_state_space: {
    axes: catalog.core.trust_axes,
    combination_count: trustCombinations.length,
    combinations: trustCombinations,
    axis_pair_count: axisNames.length * (axisNames.length - 1) / 2,
    pair_witness_count: pairWitnesses.length,
    pair_witnesses: pairWitnesses,
  },
  forbidden_implication_witnesses: forbiddenWitnesses,
  observed_state_classes: protocol.OBSERVED_STATE_CLASSES,
  counts: {
    lifecycle_count: lifecycleMatrices.length,
    lifecycle_state_count: lifecycleMatrices.reduce((sum, model) => sum + model.states.length, 0),
    lifecycle_pair_count: lifecycleMatrices.reduce((sum, model) => sum + model.pair_count, 0),
    permitted_transition_count: lifecycleMatrices.reduce((sum, model) => sum + model.permitted_count, 0),
    rejected_transition_count: lifecycleMatrices.reduce((sum, model) => sum + model.rejected_count, 0),
    trust_combination_count: trustCombinations.length,
    lifecycle_trust_combination_count: lifecycleMatrices.reduce((sum, model) => sum + model.states.length, 0) * trustCombinations.length,
    trust_pair_witness_count: pairWitnesses.length,
    forbidden_implication_count: forbiddenWitnesses.length,
    observed_state_class_count: protocol.OBSERVED_STATE_CLASSES.length,
  },
};

const proofContents = stableJson(proof);
const fixture = {
  fixture_version: "1.0.0",
  artifact: "seedrop-v2-state-model-proof",
  inventory_version: catalog.core.inventory_version,
  source_catalog_sha256: proof.source_catalog_sha256,
  proof_sha256: sha256(proofContents),
  counts: proof.counts,
};
const outputs = new Map([
  ["generated/state-model-proof.json", proofContents],
  ["fixtures/state-model-proof-v1.json", stableJson(fixture)],
]);

if (mode === "--write") {
  for (const [path, contents] of outputs) {
    await mkdir(dirname(join(packageRoot, path)), { recursive: true });
    await writeFile(join(packageRoot, path), contents);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode, files: [...outputs.keys()], counts: proof.counts })}\n`);
} else {
  const drift = [];
  for (const [path, expected] of outputs) {
    let actual;
    try {
      actual = await readFile(join(packageRoot, path), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      drift.push({ path, reason: "missing" });
      continue;
    }
    if (actual !== expected) drift.push({ path, reason: "content_mismatch" });
  }
  if (drift.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, mode, drift })}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, mode, files: [...outputs.keys()], counts: proof.counts })}\n`);
  }
}

function reachableStates(lifecycle) {
  const seen = new Set([lifecycle.initial]);
  const queue = [lifecycle.initial];
  while (queue.length > 0) {
    const from = queue.shift();
    for (const to of lifecycle.transitions[from]) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return lifecycle.states.filter((state) => seen.has(state));
}

function cartesianTrustStates(axes) {
  let states = [{}];
  for (const [axis, values] of Object.entries(axes)) {
    states = states.flatMap((state) => values.map((value) => ({ ...state, [axis]: value })));
  }
  return states;
}

function propositionHolds(proposition, lifecycle, lifecycleState, trust) {
  if (proposition.axis.endsWith("_lifecycle")) {
    return proposition.axis === `${lifecycle}_lifecycle` && lifecycleState === proposition.value;
  }
  return trust[proposition.axis] === proposition.value;
}

function stableJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
