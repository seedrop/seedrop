import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileAdapterSituation } from "@seedrop/situation";
import type { BoundedSituationProjection, ProjectTransactionDigest } from "@seedrop/situation";
import { bindCliSituation, cliSituationEnabled, renderCliSituationBinding } from "../src/index.js";

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

  it("compiles a live projection when the feature is on and no file is supplied", async () => {
    const shared = compileAdapterSituation(fixture());
    const binding = await bindCliSituation({
      feature: true,
      repo_root: "/repo",
      principal_alias: "cursor",
      legacy: { source: "v1" },
      compile_live: async () => fixture(),
      expected: { situation_id: shared.situation_id, decision_id: shared.decision_id, semantic_digest: shared.semantic_digest },
    });
    expect(binding.selection).toMatchObject({ mode: "v2", served: { kind: "v2_situation", payload: shared } });
  });

  it("serves v1 with projection_missing when live compile fails", async () => {
    const binding = await bindCliSituation({
      feature: true,
      repo_root: "/repo",
      legacy: { source: "v1" },
      compile_live: async () => { throw new Error("compile failed"); },
    });
    expect(binding.selection).toMatchObject({
      mode: "v1_fallback",
      reason: "projection_missing",
      served: { payload: { source: "v1" } },
    });
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

  it("enables live Situation on default boot argv and disables it for --v1", () => {
    expect(cliSituationEnabled(["--json", "--peek"], {})).toBe(true);
    expect(cliSituationEnabled(["--v1", "--json"], { SEEDROP_V2_SITUATION: "1" })).toBe(false);
    expect(cliSituationEnabled([], { SEEDROP_V2_SITUATION: "0" })).toBe(false);
  });

  it("forwards requested_bytes to the live compile so callers can spend budget", async () => {
    const shared = compileAdapterSituation(fixture());
    let seen: number | undefined;
    const binding = await bindCliSituation({
      feature: true,
      repo_root: "/repo",
      requested_bytes: 16384,
      legacy: { source: "v1" },
      compile_live: async (input) => {
        seen = input.requested_bytes;
        return fixture();
      },
      expected: { situation_id: shared.situation_id, decision_id: shared.decision_id, semantic_digest: shared.semantic_digest },
    });
    expect(binding.selection.mode).toBe("v2");
    expect(seen).toBe(16384);
  });

  it("renders an explicit elision reason and remedy when the budget truncated text", async () => {
    const byteCapped = fixture();
    byteCapped.budget = {
      ...byteCapped.budget,
      complete: false,
      requested_bytes: 4096,
      actual_bytes: 4096,
      omitted_categories: ["decision_text", "grave_text", "risk_text"],
    };
    const sharedByte = compileAdapterSituation(byteCapped);
    const byteBinding = await bindCliSituation({
      feature: true,
      repo_root: "/repo",
      legacy: { source: "v1" },
      compile_live: async () => byteCapped,
      expected: { situation_id: sharedByte.situation_id, decision_id: sharedByte.decision_id, semantic_digest: sharedByte.semantic_digest },
    });
    const byteRendered = renderCliSituationBinding(byteBinding);
    expect(byteRendered).toContain("were truncated to fit the 4096-byte budget");
    expect(byteRendered).toContain("--situation-budget <bytes>");

    const fieldCapped = fixture();
    fieldCapped.budget = {
      ...fieldCapped.budget,
      complete: false,
      requested_bytes: 16384,
      actual_bytes: 2764,
      omitted_categories: ["decision_text"],
    };
    const sharedField = compileAdapterSituation(fieldCapped);
    const fieldBinding = await bindCliSituation({
      feature: true,
      repo_root: "/repo",
      legacy: { source: "v1" },
      compile_live: async () => fieldCapped,
      expected: { situation_id: sharedField.situation_id, decision_id: sharedField.decision_id, semantic_digest: sharedField.semantic_digest },
    });
    expect(renderCliSituationBinding(fieldBinding)).toContain("hit fixed per-field caps (2764 of 16384 bytes used)");
  });
});

function fixture(): BoundedSituationProjection {
  return { schema_version: "1.0.0", situation_id: digest("a"), decision_id: digest("b"),
    budget: { requested_bytes: 4096, actual_bytes: 1000, complete: true, candidate_count: 1, indexed_count: 1, scanned_count: 0, event_count: 1, file_count: 1, omitted_categories: [] },
    orientation: { intent: { intent_id: "sd_int_fixture", state: "active" }, risk: [], delivery: { evidence: "passed", delivery: "committed" }, grave: null,
      source_health: { substrate: "healthy", degraded_source_ids: [], quarantine_count: 0, unresolved_disagreement_count: 0 }, next_action: { disposition: "recommend", action: "resume_intent" } },
    trust: { source_health: { freshness: "current", completeness: "complete", source_ids: ["project"], missing: [] } } };
}
