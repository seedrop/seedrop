import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileAdapterSituation } from "@seedrop/situation";
import type { BoundedSituationProjection, ProjectTransactionDigest } from "@seedrop/situation";
import { bindCliSituation, renderCliSituationBinding } from "../src/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;

describe("CLI shared Situation binding", () => {
  it("loads and serves the canonical projection without changing semantics", async () => {
    const shared = compileAdapterSituation(fixture()), root = await mkdtemp(join(tmpdir(), "seedrop-cli-situation-"));
    const path = join(root, "situation.json"); await writeFile(path, JSON.stringify(shared));
    const binding = await bindCliSituation({ feature: true, projection_file: path, legacy: { source: "v1" },
      expected: { situation_id: shared.situation_id, decision_id: shared.decision_id, semantic_digest: shared.semantic_digest } });
    expect(binding).toMatchObject({ adapter: "cli", selection: { mode: "v2", served: { payload: shared } } });
    expect(renderCliSituationBinding(binding)).toContain(shared.decision_id);
  });

  it("serves v1 with projection_mismatch for invalid serialized input", async () => {
    const root = await mkdtemp(join(tmpdir(), "seedrop-cli-situation-")), path = join(root, "bad.json");
    await writeFile(path, JSON.stringify({ adapter_version: "1.0.0", bucket: "invented" }));
    const binding = await bindCliSituation({ feature: "enabled", projection_file: path, legacy: { source: "v1" } });
    expect(binding).toMatchObject({ selection: { mode: "v1_fallback", reason: "projection_mismatch", served: { payload: { source: "v1" } } } });
  });

  it("keeps the legacy payload when the feature is disabled", async () => {
    const binding = await bindCliSituation({ feature: false, legacy: { source: "v1" } });
    expect(binding.selection).toMatchObject({ mode: "v1_fallback", reason: "feature_disabled", served: { payload: { source: "v1" } } });
  });
});

function fixture(): BoundedSituationProjection {
  return { schema_version: "1.0.0", situation_id: digest("a"), decision_id: digest("b"),
    budget: { requested_bytes: 4096, actual_bytes: 1000, complete: true, candidate_count: 1, indexed_count: 1, scanned_count: 0, event_count: 1, file_count: 1, omitted_categories: [] },
    orientation: { intent: { intent_id: "sd_int_fixture", state: "active" }, risk: [], delivery: { evidence: "passed", delivery: "committed" }, grave: null,
      source_health: { substrate: "healthy", degraded_source_ids: [], quarantine_count: 0, unresolved_disagreement_count: 0 }, next_action: { disposition: "recommend", action: "resume_intent" } },
    trust: { source_health: { freshness: "current", completeness: "complete", source_ids: ["project"], missing: [] } } };
}
