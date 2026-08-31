import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterSituationBytes,
  compileAdapterSituation,
  type AdapterSituationProjection,
  type AdapterSituationSelection,
  type BoundedSituationProjection,
  type ProjectTransactionDigest,
} from "@seedrop/situation";
import { bindCliSituation } from "../cli/src/situation-binding.ts";
import { tools as mcpTools } from "../mcp/src/index.ts";
import { bindObserverSituation } from "../observer/src/situation-binding.ts";

const scenarios = ["healthy", "degraded", "contradictory", "refusal"] as const;

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "seedrop-adapter-parity-"));
  const results: Array<Record<string, unknown>> = [];
  try {
  for (const scenario of scenarios) {
    const shared = compileAdapterSituation(fixture(scenario));
    const projectionFile = join(temporaryRoot, `${scenario}.json`);
    await writeFile(projectionFile, JSON.stringify(shared));
    const expected = {
      situation_id: shared.situation_id,
      decision_id: shared.decision_id,
      semantic_digest: shared.semantic_digest,
    };

    const cli = await bindCliSituation({ feature: true, projection_file: projectionFile, legacy: { surface: "v1" }, expected });
    const mcp = await invokeMcp({ situation_file: projectionFile, ...mcpExpected(expected) });
    const observer = bindObserverSituation({ feature: true, projection: shared, legacy: { surface: "v1" }, expected });
    const selections = [cli.selection, mcp.selection, observer];
    for (const selection of selections) assertV2(selection, shared);

    results.push({ scenario, situation_id: shared.situation_id, decision_id: shared.decision_id,
      semantic_digest: shared.semantic_digest, bucket: shared.bucket, readiness: shared.readiness,
      health: shared.health.state, decision: shared.decision.display,
      semantic_bytes: adapterSituationBytes(shared).byteLength });
  }

  const shared = compileAdapterSituation(fixture("healthy"));
  const projectionFile = join(temporaryRoot, "mismatch.json");
  await writeFile(projectionFile, JSON.stringify(shared));
  const mismatch = { decision_id: digest("f") };
  const cli = await bindCliSituation({ feature: true, projection_file: projectionFile, legacy: { surface: "v1" }, expected: mismatch });
  const mcp = await invokeMcp({ situation_file: projectionFile, expect_decision: mismatch.decision_id });
  const observer = bindObserverSituation({ feature: true, projection: shared, legacy: { surface: "v1" }, expected: mismatch });
  for (const selection of [cli.selection, mcp.selection, observer]) {
    assert.equal(selection.mode, "v1_fallback");
    assert.equal(selection.reason, "projection_mismatch");
    assert.equal(selection.warning, "projection_mismatch: v1 remains served");
  }

  process.stdout.write(`${JSON.stringify({ schema_version: "1.0.0", ok: true,
    adapters: ["cli", "mcp", "observer"], scenarios: results,
    mismatch: { mode: "v1_fallback", reason: "projection_mismatch", v1_remained_served: true } })}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function invokeMcp(input: Record<string, unknown>): Promise<{ selection: AdapterSituationSelection }> {
  const tool = mcpTools.find((candidate) => candidate.name === "seedrop_boot");
  assert.ok(tool, "seedrop_boot MCP tool must exist");
  const result = await tool.handler({
    v2_situation: true,
    passport: "/nonexistent/__seedrop-wave6-parity__.json",
    ...input,
  });
  assert.notEqual(result.isError, true, "MCP adapter invocation failed");
  const first = result.content[0];
  assert.ok(first && first.type === "text", "MCP adapter must return text JSON");
  return JSON.parse(first.text) as { selection: AdapterSituationSelection };
}

function assertV2(selection: AdapterSituationSelection, shared: AdapterSituationProjection): void {
  assert.equal(selection.mode, "v2");
  assert.equal(selection.reason, null);
  assert.equal(selection.warning, null);
  assert.equal(selection.served.kind, "v2_situation");
  assert.deepEqual(selection.served.payload, shared);
  assert.deepEqual(adapterSituationBytes(selection.served.payload), adapterSituationBytes(shared));
}

function mcpExpected(expected: { situation_id: string; decision_id: string; semantic_digest: string }): Record<string, string> {
  return { expect_situation: expected.situation_id, expect_decision: expected.decision_id, expect_semantic: expected.semantic_digest };
}

function fixture(scenario: typeof scenarios[number]): BoundedSituationProjection {
  const sourceHealth: Record<string, unknown> = { substrate: "healthy", degraded_source_ids: [], quarantine_count: 0,
    unresolved_disagreement_count: scenario === "contradictory" ? 1 : 0 };
  const stale = scenario === "degraded";
  if (stale) sourceHealth.degraded_source_ids = ["git"];
  const nextAction = scenario === "refusal"
    ? { disposition: "refuse", reason: "Required source is incomplete", smallest_repair: "refresh_project_projection" }
    : { disposition: "recommend", action: "resume_intent", reason: "Current evidence permits continuation" };
  return {
    schema_version: "1.0.0",
    situation_id: digest(({ healthy: "a", degraded: "c", contradictory: "e", refusal: "1" } as const)[scenario]),
    decision_id: digest(({ healthy: "b", degraded: "d", contradictory: "0", refusal: "2" } as const)[scenario]),
    budget: { requested_bytes: 4096, actual_bytes: 1200, complete: true, candidate_count: 10,
      indexed_count: 10, scanned_count: 0, event_count: 10, file_count: 20, omitted_categories: [] },
    orientation: {
      intent: { intent_id: `sd_int_${scenario}`, state: scenario === "healthy" ? "active" : "queued", title: `${scenario} parity` },
      risk: [], delivery: { evidence: "passed", delivery: "committed" }, grave: null,
      source_health: sourceHealth, next_action: nextAction,
    },
    trust: { source_health: { freshness: stale ? "stale" : "current", completeness: "complete", source_ids: ["project"], missing: [] } },
  };
}

function digest(letter: string): ProjectTransactionDigest {
  return `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;
}
