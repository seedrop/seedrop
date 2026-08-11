import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMAND_TRANSITIONS,
  PROTOCOL_GAPS,
  PROTOCOL_INVENTORY_CORE,
  PROTOCOL_SURFACES,
  PUBLIC_NOUNS,
  TRUST_AXES,
} from "../src/index.js";

const packageRoot = join(import.meta.dirname, "..");

describe("protocol completeness inventory", () => {
  it("accounts for exactly the nine frozen public nouns", () => {
    expect(PUBLIC_NOUNS.map((noun) => noun.name)).toEqual([
      "Principal", "Project", "Intent", "Episode", "Claim", "Receipt", "Lease", "Event", "Situation",
    ]);
    const gapIds = new Set(PROTOCOL_GAPS.map((gap) => gap.id));
    for (const noun of PUBLIC_NOUNS) {
      expect(noun.contract_status === "implemented" || noun.gap_ids.length > 0).toBe(true);
      for (const gapId of noun.gap_ids) expect(gapIds.has(gapId)).toBe(true);
    }
  });

  it("keeps lifecycle graphs closed and terminal states terminal", () => {
    for (const lifecycle of Object.values(PROTOCOL_INVENTORY_CORE.lifecycles)) {
      const states = new Set<string>(lifecycle.states);
      expect(Object.keys(lifecycle.transitions).sort()).toEqual([...states].sort());
      expect(states.has(lifecycle.initial)).toBe(true);
      for (const [from, targets] of Object.entries(lifecycle.transitions)) {
        for (const target of targets) expect(states.has(target), `${from} -> ${target}`).toBe(true);
      }
      for (const terminal of lifecycle.terminal) expect(lifecycle.transitions[terminal]).toEqual([]);
    }
    expect(PROTOCOL_INVENTORY_CORE.lifecycles.command.transitions).toBe(COMMAND_TRANSITIONS);
    expect(Object.isFrozen(COMMAND_TRANSITIONS)).toBe(true);
    for (const targets of Object.values(COMMAND_TRANSITIONS)) expect(Object.isFrozen(targets)).toBe(true);
  });

  it("freezes every orthogonal trust-axis value independently", () => {
    expect(TRUST_AXES).toEqual({
      evidence: ["unverified", "passed", "failed", "stale", "unavailable"],
      delivery: ["not_applicable", "unobserved", "uncommitted", "committed", "review_open", "merged", "reverted", "superseded", "absent"],
      substrate: ["healthy", "degraded", "corrupt", "migrating", "unreachable"],
      readiness: ["not_ready", "resumable_with_risk", "ready"],
      confidence: ["observed", "inferred_high", "inferred_low", "unknown"],
    });
  });

  it("registers implemented surfaces against the public export boundary", () => {
    const catalog = readJson("generated/protocol-catalog.json");
    const publicValues = new Set(catalog.public_exports.values.map((entry: { name: string }) => entry.name));
    const publicTypes = new Set(catalog.public_exports.types.map((entry: { name: string }) => entry.name));
    expect(new Set(PROTOCOL_SURFACES.map((surface) => surface.name)).size).toBe(PROTOCOL_SURFACES.length);
    for (const surface of PROTOCOL_SURFACES) {
      expect(publicTypes.has(surface.name), surface.name).toBe(true);
      if (surface.version_constant) expect(publicValues.has(surface.version_constant), surface.version_constant).toBe(true);
      if (surface.builder) expect(publicValues.has(surface.builder), surface.builder).toBe(true);
      if (surface.validator) expect(publicValues.has(surface.validator), surface.validator).toBe(true);
    }
  });

  it("generates exact top-level HealthEnvelope fields from its interface", () => {
    const catalog = readJson("generated/protocol-catalog.json");
    const health = catalog.surface_shapes.find((shape: { name: string }) => shape.name === "HealthEnvelope");
    expect(health.fields.map((field: { name: string }) => field.name)).toEqual([
      "health_version", "generated_at", "substrate", "projection_version", "policy", "sources",
      "quarantined", "stale_projections", "pending_commands", "budget", "disagreements", "reasons",
    ]);
    expect(catalog.core).toEqual(PROTOCOL_INVENTORY_CORE);
  });
});

function readJson(path: string): any {
  return JSON.parse(readFileSync(join(packageRoot, path), "utf8"));
}
