import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  assertHealthEnvelope,
  buildHealthEnvelope,
  canonicalJson,
} from "../src/index.js";
import type {
  BuildHealthEnvelopeInput,
  HealthDisagreement,
  HealthSource,
} from "../src/index.js";

const RECEIPT = "sd_rcp_0191416f-4495-7011-a233-445566778899" as const;
const CLAIM_A = "sd_clm_0191416f-4495-7011-a233-44556677889a" as const;
const CLAIM_B = "sd_clm_0191416f-4495-7011-a233-44556677889b" as const;
const EVENT = "sd_evt_0191416f-4495-7011-a233-44556677889c" as const;
const COMMAND = "sd_cmd_0191416f-4495-7011-a233-445566778899" as const;
const PRINCIPAL = "sd_prn_0191416f-4495-7011-a233-445566778899" as const;
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("HealthEnvelope derivation", () => {
  it("reports healthy only when required sources are complete, fresh, compatible, and bounded", () => {
    const envelope = buildHealthEnvelope(baseInput());
    expect(envelope.substrate).toBe("healthy");
    expect(envelope.reasons).toEqual([]);
    expect(envelope.sources.map((entry) => entry.source_id)).toEqual(["daemon", "project-events"]);
    expect(Object.isFrozen(envelope)).toBe(true);
    assertHealthEnvelope(envelope);
  });

  it("reports degraded with every independent stale, optional, pending, and budget reason preserved", () => {
    const input = baseInput();
    const envelope = buildHealthEnvelope({
      ...input,
      sources: [
        ...input.sources,
        {
          source_id: "git",
          kind: "external-authority",
          status: "unreachable",
          high_watermark: null,
          content_digest: null,
          observed_at: "2026-08-09T12:00:00.000Z",
          governing_record_id: null,
          message: "observer timed out",
        },
      ],
      stale_projections: [{
        projection: "situation",
        source_id: "project-events",
        projection_watermark: "event:40",
        source_high_watermark: "event:42",
        observed_at: "2026-08-09T12:00:00.000Z",
        reason: "two committed events behind",
      }],
      pending_commands: [{
        command_id: COMMAND,
        phase: "effects_pending",
        recoverable: true,
        observed_at: "2026-08-09T12:00:00.000Z",
        recovery_owner: PRINCIPAL,
      }],
      budget: {
        requested_bytes: 2048,
        actual_bytes: 2100,
        complete: false,
        candidate_count: 25,
        indexed_count: 20,
        scanned_count: 5,
        omitted_categories: ["history"],
      },
    });
    expect(envelope.substrate).toBe("degraded");
    expect(envelope.reasons.map((entry) => entry.code)).toEqual([
      "budget_incomplete",
      "budget_overflow",
      "optional_source_unavailable",
      "pending_command",
      "projection_stale",
    ]);
  });

  it("uses deterministic severity precedence without erasing concurrent reasons", () => {
    const input = baseInput();
    const envelope = buildHealthEnvelope({
      ...input,
      sources: input.sources.map((source) => source.source_id === "daemon"
        ? { ...source, status: "migrating" as const }
        : source),
      quarantined: [{
        source_id: "project-events",
        kind: "event",
        referent: "events/0042.json",
        code: "parse_failed",
        severity: "error",
        repair: "seed doctor quarantine inspect events/0042.json",
      }],
    });
    expect(envelope.substrate).toBe("corrupt");
    expect(envelope.reasons.map((entry) => entry.code)).toEqual([
      "quarantine_present",
      "required_source_migrating",
    ]);
  });

  it.each([
    ["corrupt", "corrupt"],
    ["migrating", "migrating"],
    ["unreachable", "unreachable"],
  ] as const)("projects required source state %s as substrate %s", (status, expected) => {
    const input = baseInput();
    const envelope = buildHealthEnvelope({
      ...input,
      sources: input.sources.map((source) => source.source_id === "project-events"
        ? {
            ...source,
            status,
            ...(status === "unreachable" ? {
              high_watermark: null,
              content_digest: null,
              governing_record_id: null,
            } : {}),
          }
        : source),
    });
    expect(envelope.substrate).toBe(expected);
  });

  it("reports a missing required source as unreachable rather than empty success", () => {
    const input = baseInput();
    const envelope = buildHealthEnvelope({
      ...input,
      sources: input.sources.filter((source) => source.source_id !== "daemon"),
    });
    expect(envelope.substrate).toBe("unreachable");
    expect(envelope.reasons).toContainEqual(expect.objectContaining({
      code: "required_source_missing",
      source_id: "daemon",
    }));
  });

  it("reports incompatible projection versions inside health instead of failing to describe them", () => {
    const envelope = buildHealthEnvelope({ ...baseInput(), projection_version: "2.0.0" });
    expect(envelope.substrate).toBe("degraded");
    expect(envelope.reasons).toContainEqual(expect.objectContaining({ code: "projection_version_incompatible" }));
  });
});

describe("HealthEnvelope disagreement contract", () => {
  it("preserves a governed contradiction and its selected policy trace without degrading health", () => {
    const envelope = buildHealthEnvelope({
      ...baseInput(),
      disagreements: [disagreement("governed")],
    });
    expect(envelope.substrate).toBe("healthy");
    expect(envelope.disagreements[0]?.claims.map((claim) => claim.value)).toEqual(["L1", "L3"]);
    expect(envelope.disagreements[0]?.resolution).toEqual(expect.objectContaining({
      status: "governed",
      selected_claim_index: 1,
      decision_record_id: EVENT,
    }));
    expect(envelope.reasons).toEqual([expect.objectContaining({ code: "disagreement_governed", severity: "info" })]);
  });

  it("preserves an unresolved contradiction and degrades health", () => {
    const envelope = buildHealthEnvelope({
      ...baseInput(),
      disagreements: [disagreement("unresolved")],
    });
    expect(envelope.substrate).toBe("degraded");
    expect(envelope.disagreements[0]?.claims).toHaveLength(2);
    expect(envelope.reasons).toEqual([expect.objectContaining({ code: "disagreement_unresolved", severity: "error" })]);
  });

  it("rejects a fake disagreement whose source values are equal", () => {
    const record = disagreement("unresolved");
    const claims = record.claims.map((claim) => ({ ...claim, value: "same" }));
    expectCode(
      () => buildHealthEnvelope({ ...baseInput(), disagreements: [{ ...record, claims }] }),
      "seedrop.protocol.health_disagreement_invalid",
    );
  });

  it("rejects governed disagreement without a selected claim and decision record", () => {
    const record = disagreement("governed");
    expectCode(
      () => buildHealthEnvelope({
        ...baseInput(),
        disagreements: [{
          ...record,
          resolution: { ...record.resolution, selected_claim_index: null, decision_record_id: null },
        }],
      }),
      "seedrop.protocol.health_disagreement_invalid",
    );
  });

  it("rejects a claim whose watermark or digest does not match its named source", () => {
    const record = disagreement("unresolved");
    expectCode(
      () => buildHealthEnvelope({
        ...baseInput(),
        disagreements: [{
          ...record,
          claims: record.claims.map((claim, index) => index === 0
            ? { ...claim, source_high_watermark: "event:41" }
            : claim),
        }],
      }),
      "seedrop.protocol.health_disagreement_invalid",
    );
  });
});

describe("HealthEnvelope integrity", () => {
  it("rejects available sources that omit watermark, digest, or governing record", () => {
    const input = baseInput();
    expectCode(
      () => buildHealthEnvelope({
        ...input,
        sources: input.sources.map((source) => source.source_id === "daemon"
          ? { ...source, content_digest: null }
          : source),
      }),
      "seedrop.protocol.health_invalid",
    );
  });

  it("rejects future-dated evidence and unknown fields", () => {
    const input = baseInput();
    expectCode(
      () => buildHealthEnvelope({
        ...input,
        sources: input.sources.map((source) => source.source_id === "daemon"
          ? { ...source, observed_at: "2026-08-09T12:00:01.000Z" }
          : source),
      }),
      "seedrop.protocol.health_invalid",
    );
    expectCode(
      () => buildHealthEnvelope({ ...input, adapter_guess: true } as BuildHealthEnvelopeInput),
      "seedrop.protocol.health_invalid",
    );
  });

  it("returns stable protocol errors for structurally missing arrays and booleans", () => {
    const input = baseInput();
    expectCode(
      () => buildHealthEnvelope({ ...input, sources: undefined } as unknown as BuildHealthEnvelopeInput),
      "seedrop.protocol.health_invalid",
    );
    expectCode(
      () => buildHealthEnvelope({
        ...input,
        budget: { ...input.budget, complete: "yes" } as unknown as BuildHealthEnvelopeInput["budget"],
      }),
      "seedrop.protocol.health_invalid",
    );
  });

  it("rejects empty optional evidence fields and inconsistent budget counts", () => {
    const input = baseInput();
    expectCode(
      () => buildHealthEnvelope({
        ...input,
        sources: input.sources.map((entry) => entry.source_id === "daemon"
          ? { ...entry, fresh_until: "" }
          : entry),
      }),
      "seedrop.protocol.health_invalid",
    );
    expectCode(
      () => buildHealthEnvelope({
        ...input,
        budget: { ...input.budget, candidate_count: 13 },
      }),
      "seedrop.protocol.health_invalid",
    );
  });

  it("rejects terminal pending-command phases and recovery ownership disagreement", () => {
    const input = baseInput();
    expectCode(
      () => buildHealthEnvelope({
        ...input,
        pending_commands: [{
          command_id: COMMAND,
          phase: "completed",
          recoverable: false,
          observed_at: input.generated_at,
        }],
      } as unknown as BuildHealthEnvelopeInput),
      "seedrop.protocol.health_invalid",
    );
    expectCode(
      () => buildHealthEnvelope({
        ...input,
        pending_commands: [{
          command_id: COMMAND,
          phase: "effects_pending",
          recoverable: true,
          observed_at: input.generated_at,
        }],
      }),
      "seedrop.protocol.health_invalid",
    );
  });

  it("rejects a tampered summary even when the underlying evidence is valid", () => {
    const envelope = buildHealthEnvelope(baseInput());
    expectCode(
      () => assertHealthEnvelope({ ...envelope, substrate: "degraded" }),
      "seedrop.protocol.health_inconsistent",
    );
  });

  it("is byte-deterministic regardless of input ordering", () => {
    const first = baseInput();
    const second = { ...first, sources: [...first.sources].reverse() };
    expect(canonicalJson(buildHealthEnvelope(first))).toBe(canonicalJson(buildHealthEnvelope(second)));
  });

  it("does not freeze caller-owned disagreement values", () => {
    const value = { level: "L1" };
    const record = disagreement("unresolved");
    const claims = [{ ...record.claims[0]!, value }, record.claims[1]!];
    buildHealthEnvelope({ ...baseInput(), disagreements: [{ ...record, claims }] });
    expect(Object.isFrozen(value)).toBe(false);
  });
});

function baseInput(): BuildHealthEnvelopeInput {
  return {
    generated_at: "2026-08-09T12:00:00.000Z",
    projection_version: "1.0.0",
    policy: {
      policy_id: "seedrop.health.default",
      policy_version: "1.0.0",
      required_projection_version: "1.0.0",
      required_source_ids: ["project-events", "daemon"],
    },
    sources: [
      source("project-events", "event:42", DIGEST_A, "2026-08-09T12:05:00.000Z"),
      source("daemon", "tx:99", DIGEST_B, "2026-08-09T12:01:00.000Z"),
    ],
    budget: {
      requested_bytes: 4096,
      actual_bytes: 2048,
      complete: true,
      candidate_count: 12,
      indexed_count: 12,
      scanned_count: 0,
      omitted_categories: [],
    },
  };
}

function source(sourceId: string, watermark: string, digest: string, freshUntil: string): HealthSource {
  return {
    source_id: sourceId,
    kind: sourceId === "daemon" ? "coordination-store" : "project-event-set",
    status: "available",
    high_watermark: watermark,
    content_digest: digest,
    observed_at: "2026-08-09T12:00:00.000Z",
    fresh_until: freshUntil,
    governing_record_id: RECEIPT,
  };
}

function disagreement(status: "governed" | "unresolved"): HealthDisagreement {
  return {
    field: "view.success_level",
    claims: [
      {
        source_id: "project-events",
        value: "L1",
        observed_at: "2026-08-09T12:00:00.000Z",
        source_high_watermark: "event:42",
        source_content_digest: DIGEST_A,
        governing_record_id: CLAIM_A,
      },
      {
        source_id: "daemon",
        value: "L3",
        observed_at: "2026-08-09T12:00:00.000Z",
        source_high_watermark: "tx:99",
        source_content_digest: DIGEST_B,
        governing_record_id: CLAIM_B,
      },
    ],
    resolution: status === "governed"
      ? {
          status,
          policy_id: "seedrop.orientation.success",
          policy_version: "1.0.0",
          rule_id: "project-policy-wins",
          selected_claim_index: 1,
          decision_record_id: EVENT,
          explanation: "The repo policy requirement governs the advisory boot label.",
        }
      : {
          status,
          policy_id: "seedrop.orientation.success",
          policy_version: "1.0.0",
          rule_id: "no-applicable-authority",
          selected_claim_index: null,
          decision_record_id: null,
          explanation: "Neither source is authorized to supersede the other.",
        },
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}
