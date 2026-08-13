import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileAdapterSituation } from "@seedrop/situation";
import type { BoundedSituationProjection, ProjectTransactionDigest } from "@seedrop/situation";
import { tools } from "../src/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;

describe("MCP shared Situation binding", () => {
  it("returns the exact CLI-bound semantic payload", async () => {
    const shared = compileAdapterSituation(fixture()), root = await mkdtemp(join(tmpdir(), "seedrop-mcp-situation-"));
    const path = join(root, "situation.json"); await writeFile(path, JSON.stringify(shared));
    const prior = process.env.SEEDROP_PASSPORT; process.env.SEEDROP_PASSPORT = "/nonexistent/__seed-mcp-v2-test__.json";
    try {
      const tool = tools.find((item) => item.name === "seedrop_boot")!;
      const result = await tool.handler({ v2_situation: true, situation_file: path,
        expect_situation: shared.situation_id, expect_decision: shared.decision_id, expect_semantic: shared.semantic_digest });
      expect(result.isError).not.toBe(true);
      const binding = JSON.parse(result.content[0]!.text);
      expect(binding.selection).toMatchObject({ mode: "v2", served: { kind: "v2_situation", payload: shared } });
      expect(binding.selection.served.payload.semantic_digest).toBe(shared.semantic_digest);
    } finally { if (prior === undefined) delete process.env.SEEDROP_PASSPORT; else process.env.SEEDROP_PASSPORT = prior; }
  }, 20_000);
});

function fixture(): BoundedSituationProjection {
  return { schema_version: "1.0.0", situation_id: digest("a"), decision_id: digest("b"),
    budget: { requested_bytes: 4096, actual_bytes: 1000, complete: true, candidate_count: 1, indexed_count: 1, scanned_count: 0, event_count: 1, file_count: 1, omitted_categories: [] },
    orientation: { intent: { intent_id: "sd_int_fixture", state: "active" }, risk: [], delivery: { evidence: "passed", delivery: "committed" }, grave: null,
      source_health: { substrate: "healthy", degraded_source_ids: [], quarantine_count: 0, unresolved_disagreement_count: 0 }, next_action: { disposition: "recommend", action: "resume_intent" } },
    trust: { source_health: { freshness: "current", completeness: "complete", source_ids: ["project"], missing: [] } } };
}
