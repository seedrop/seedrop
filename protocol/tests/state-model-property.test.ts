import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_CROSS_AXIS_IMPLICATIONS,
  LIFECYCLE_NAMES,
  OBSERVED_STATE_CLASSES,
  PROTOCOL_INVENTORY_CORE,
  ProtocolError,
  TRUST_AXES,
  assertLifecycleTransition,
  buildOrthogonalTrustState,
  canLifecycleTransition,
  canonicalJson,
  isLifecycleState,
} from "../src/index.js";
import type { LifecycleName, OrthogonalTrustState } from "../src/index.js";

const packageRoot = join(import.meta.dirname, "..");
const proof = readJson("generated/state-model-proof.json");

describe("state-model properties", () => {
  it("traverses every known lifecycle pair and rejects all 104 implicit edges", () => {
    let pairs = 0;
    let permitted = 0;
    let rejected = 0;
    for (const lifecycleName of LIFECYCLE_NAMES) {
      const lifecycle = PROTOCOL_INVENTORY_CORE.lifecycles[lifecycleName];
      for (const from of lifecycle.states) {
        for (const to of lifecycle.states) {
          pairs += 1;
          const expected = (lifecycle.transitions[from] as readonly string[]).includes(to);
          expect(canLifecycleTransition(lifecycleName, from, to), `${lifecycleName}: ${from} -> ${to}`).toBe(expected);
          if (expected) {
            permitted += 1;
            expect(() => assertLifecycleTransition(lifecycleName, from, to)).not.toThrow();
          } else {
            rejected += 1;
            expectProtocolError(
              () => assertLifecycleTransition(lifecycleName, from, to),
              "seedrop.protocol.lifecycle_transition_invalid",
            );
          }
        }
      }
    }
    expect({ pairs, permitted, rejected }).toEqual({ pairs: 152, permitted: 48, rejected: 104 });
  });

  it("makes every state reachable and every terminal state terminal", () => {
    for (const lifecycleName of LIFECYCLE_NAMES) {
      const lifecycle = PROTOCOL_INVENTORY_CORE.lifecycles[lifecycleName];
      const reachable = new Set<string>([lifecycle.initial]);
      const queue: string[] = [lifecycle.initial];
      while (queue.length > 0) {
        const from = queue.shift()!;
        for (const to of (lifecycle.transitions as Readonly<Record<string, readonly string[]>>)[from]!) {
          if (!reachable.has(to)) {
            reachable.add(to);
            queue.push(to);
          }
        }
      }
      expect([...reachable].sort(), lifecycleName).toEqual([...lifecycle.states].sort());
      for (const terminal of lifecycle.terminal) {
        expect((lifecycle.transitions as Readonly<Record<string, readonly string[]>>)[terminal]).toEqual([]);
      }
    }
  });

  it("rejects unknown lifecycle names and states without fallback", () => {
    expect(canLifecycleTransition("unknown" as LifecycleName, "active", "blocked")).toBe(false);
    expect(isLifecycleState("unknown" as LifecycleName, "active")).toBe(false);
    expectProtocolError(
      () => assertLifecycleTransition("unknown" as LifecycleName, "active", "blocked"),
      "seedrop.protocol.lifecycle_state_unknown",
    );
    for (const lifecycleName of LIFECYCLE_NAMES) {
      expectProtocolError(
        () => assertLifecycleTransition(lifecycleName, "__unknown__", PROTOCOL_INVENTORY_CORE.lifecycles[lifecycleName].initial),
        "seedrop.protocol.lifecycle_state_unknown",
      );
      expectProtocolError(
        () => assertLifecycleTransition(lifecycleName, PROTOCOL_INVENTORY_CORE.lifecycles[lifecycleName].initial, "__unknown__"),
        "seedrop.protocol.lifecycle_state_unknown",
      );
    }
  });

  it("represents all 2,700 trust tuples without collapsing an axis", () => {
    const combinations = cartesianTrustStates();
    expect(combinations).toHaveLength(2_700);
    const canonical = new Set(combinations.map((state) => canonicalJson(buildOrthogonalTrustState(state))));
    expect(canonical.size).toBe(2_700);
    expect(proof.trust_state_space.combinations.map(canonicalJson).sort()).toEqual(
      combinations.map(canonicalJson).sort(),
    );
    expect(proof.trust_state_space.pair_witness_count).toBe(260);
  });

  it("requires every trust axis exactly once and validates each value independently", () => {
    const valid = buildOrthogonalTrustState({
      evidence: "passed",
      delivery: "absent",
      substrate: "healthy",
      readiness: "not_ready",
      confidence: "unknown",
    });
    expect(valid).toEqual({ evidence: "passed", delivery: "absent", substrate: "healthy", readiness: "not_ready", confidence: "unknown" });
    expect(Object.isFrozen(valid)).toBe(true);
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "evidence", { enumerable: true, get: () => "passed" });
    const symbolAxis = { ...valid, [Symbol("summary")]: "green" };
    const inherited = Object.assign(Object.create({ summary: "green" }), valid);
    for (const invalid of [
      { ...valid, evidence: "successful" },
      { evidence: valid.evidence, delivery: valid.delivery, substrate: valid.substrate, readiness: valid.readiness },
      { ...valid, summary: "green" },
      accessor,
      symbolAxis,
      inherited,
    ]) {
      expectProtocolError(() => buildOrthogonalTrustState(invalid), "seedrop.protocol.trust_state_invalid");
    }
  });

  it("materializes counterexamples for every forbidden implication", () => {
    expect(proof.forbidden_implication_witnesses.map((entry: { id: string }) => entry.id)).toEqual(
      FORBIDDEN_CROSS_AXIS_IMPLICATIONS.map((entry) => entry.id),
    );
    for (const witness of proof.forbidden_implication_witnesses) {
      expect(propositionHolds(witness.antecedent, witness.counterexample), witness.id).toBe(true);
      expect(propositionHolds(witness.consequent, witness.counterexample), witness.id).toBe(false);
    }
  });

  it("keeps all 14 observed machine classes representable", () => {
    expect(proof.observed_state_classes).toEqual(OBSERVED_STATE_CLASSES);
    for (const stateClass of OBSERVED_STATE_CLASSES) {
      expect(isLifecycleState(stateClass.lifecycle, stateClass.lifecycle_state), `${stateClass.id}`).toBe(true);
      expect(buildOrthogonalTrustState(stateClass.trust)).toEqual(stateClass.trust);
    }
    expect(proof.counts).toEqual({
      lifecycle_count: 4,
      lifecycle_state_count: 24,
      lifecycle_pair_count: 152,
      permitted_transition_count: 48,
      rejected_transition_count: 104,
      trust_combination_count: 2_700,
      lifecycle_trust_combination_count: 64_800,
      trust_pair_witness_count: 260,
      forbidden_implication_count: 8,
      observed_state_class_count: 14,
    });
  });
});

function cartesianTrustStates(): OrthogonalTrustState[] {
  const result: OrthogonalTrustState[] = [];
  for (const evidence of TRUST_AXES.evidence) {
    for (const delivery of TRUST_AXES.delivery) {
      for (const substrate of TRUST_AXES.substrate) {
        for (const readiness of TRUST_AXES.readiness) {
          for (const confidence of TRUST_AXES.confidence) {
            result.push({ evidence, delivery, substrate, readiness, confidence });
          }
        }
      }
    }
  }
  return result;
}

function propositionHolds(
  proposition: { axis: string; value: string },
  counterexample: { lifecycle: string; lifecycle_state: string; trust: Record<string, string> },
): boolean {
  if (proposition.axis.endsWith("_lifecycle")) {
    return proposition.axis === `${counterexample.lifecycle}_lifecycle`
      && proposition.value === counterexample.lifecycle_state;
  }
  return counterexample.trust[proposition.axis] === proposition.value;
}

function expectProtocolError(action: () => void, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(join(packageRoot, path), "utf8"));
}
