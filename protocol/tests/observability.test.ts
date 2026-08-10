import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  assertBoundedOutput,
  assertFieldExplanation,
  assertOperationalMetricsSnapshot,
  authorizeTelemetryExport,
  buildFieldExplanation,
  buildOperationalMetricsSnapshot,
  buildTelemetryConsentReceipt,
  canonicalJsonBytes,
  canonicalJsonDigest,
  compileBoundedOutput,
  findTelemetrySecretPatterns,
  healthBudgetFromBoundedOutput,
  telemetryExportState,
  type BuildFieldExplanationInput,
  type BuildOperationalMetricsInput,
  type BuildTelemetryConsentInput,
  type OperationalMetricsSnapshot,
  type TelemetryExportRequest,
} from "../src/index.js";

const PRINCIPAL = "sd_prn_0191416f-4495-7011-a233-445566778899";
const PROJECT = "sd_prj_0191416f-4495-7011-a233-445566778899";
const COMMAND_A = "sd_cmd_0191416f-4495-7011-a233-445566778899";
const COMMAND_B = "sd_cmd_0191416f-4495-7011-a233-44556677889a";
const SITUATION = "sd_sit_0191416f-4495-7011-a233-445566778899";
const RECEIPT = "sd_rcp_0191416f-4495-7011-a233-445566778899";
const CLAIM = "sd_clm_0191416f-4495-7011-a233-445566778899";
const EVENT = "sd_evt_0191416f-4495-7011-a233-445566778899";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describe("operational metrics", () => {
  it("derives retry, CAS, idempotency, lag, and dead-letter truth from canonical spans", () => {
    const snapshot = buildOperationalMetricsSnapshot(metricInput());
    expect(snapshot.counters).toEqual({
      duplicate_idempotency_count: 1,
      cas_conflict_count: 1,
      retry_count: 3,
      outbox_dead_letter_count: 1,
      outbox_lag_sample_count: 2,
    });
    expect(snapshot.outbox_lag).toEqual({
      sample_count: 2,
      total_ms: 9_500,
      maximum_ms: 7_500,
    });
    expect(snapshot.alerts.map((alert) => alert.code)).toEqual([
      "outbox_dead_letter",
      "outbox_lag_slo_exceeded",
      "retry_storm",
    ]);
    assertOperationalMetricsSnapshot(snapshot);
    expect(Object.isFrozen(snapshot.spans)).toBe(true);
  });

  it("rejects kind/lag contradictions and future observations", () => {
    const wrongLag = metricInput();
    wrongLag.spans[0] = { ...wrongLag.spans[0]!, outbox_lag_ms: 2 };
    expectCode(() => buildOperationalMetricsSnapshot(wrongLag), "seedrop.protocol.operational_metrics_invalid");

    const future = metricInput();
    future.spans[0] = { ...future.spans[0]!, observed_at: "2026-08-10T12:01:00.000Z" };
    expectCode(() => buildOperationalMetricsSnapshot(future), "seedrop.protocol.operational_metrics_invalid");
  });

  it("detects a caller-tampered derived summary", () => {
    const snapshot = buildOperationalMetricsSnapshot(metricInput());
    const tampered = structuredClone(snapshot) as OperationalMetricsSnapshot;
    tampered.counters.retry_count = 99;
    expectCode(() => assertOperationalMetricsSnapshot(tampered), "seedrop.protocol.operational_metrics_inconsistent");
  });
});

describe("field explanation traces", () => {
  it("requires every confident field to resolve through evidence, policy, projection, and decision", () => {
    const trace = buildFieldExplanation(resolvedExplanation());
    expect(trace.status).toBe("resolved");
    expect(trace.evidence).toHaveLength(2);
    expect(trace.evidence.map((item) => item.record_id)).toEqual([CLAIM, EVENT]);
    assertFieldExplanation(trace);
  });

  it("preserves missing truth as a typed unknown with an evidence request", () => {
    const trace = buildFieldExplanation({
      situation_id: SITUATION,
      field: "outcome.delivery.observed",
      status: "unknown",
      confidence: "unknown",
      value_digest: null,
      projection_version: "1.0.0",
      policy: {
        policy_id: "seedrop.outcome.delivery",
        policy_version: "1.0.0",
        rule_id: "receipt-required",
      },
      decision_record_id: null,
      evidence: [],
      unknown: {
        code: "delivery_receipt_missing",
        message: "No recipient or deployment observation Receipt exists.",
        requested_evidence: ["deployment receipt", "recipient observation receipt"],
      },
    });
    expect(trace.unknown?.requested_evidence).toEqual([
      "deployment receipt",
      "recipient observation receipt",
    ]);
    assertFieldExplanation(trace);
  });

  it("rejects unsupported confidence and contradictory unknown assertions", () => {
    const missing = resolvedExplanation();
    missing.evidence = [];
    expectCode(() => buildFieldExplanation(missing), "seedrop.protocol.explanation_trace_invalid");
    const claimOnly = resolvedExplanation();
    claimOnly.evidence = [claimOnly.evidence.find((item) => item.record_id === CLAIM)!];
    claimOnly.decision_record_id = CLAIM;
    expectCode(() => buildFieldExplanation(claimOnly), "seedrop.protocol.explanation_trace_invalid");

    const contradiction = {
      ...resolvedExplanation(),
      status: "unknown",
      confidence: "unknown",
      unknown: {
        code: "missing",
        message: "Missing evidence.",
        requested_evidence: ["receipt"],
      },
    } as BuildFieldExplanationInput;
    expectCode(() => buildFieldExplanation(contradiction), "seedrop.protocol.explanation_trace_invalid");
  });
});

describe("bounded output compiler", () => {
  it("returns exact full-envelope UTF-8 byte accounting and deterministic priority order", () => {
    const result = compileBoundedOutput({
      requested_bytes: 4_096,
      maximum_scanned_count: 1,
      candidates: boundedCandidates(),
    });
    expect(result.actual_bytes).toBe(canonicalJsonBytes(result).byteLength);
    expect(result.actual_bytes).toBeLessThanOrEqual(result.requested_bytes);
    expect(result.complete).toBe(true);
    expect(result.payload.map((item) => item.candidate_id)).toEqual([
      "mission",
      "risk",
      "unicode",
    ]);
    expect(result).toEqual(compileBoundedOutput({
      requested_bytes: 4_096,
      maximum_scanned_count: 1,
      candidates: [...boundedCandidates()].reverse(),
    }));
    assertBoundedOutput(result);
    const tampered = structuredClone(result);
    tampered.actual_bytes -= 1;
    expectCode(() => assertBoundedOutput(tampered), "seedrop.protocol.budget_invalid");
    expect(healthBudgetFromBoundedOutput(result)).toMatchObject({
      requested_bytes: 4_096,
      actual_bytes: result.actual_bytes,
      candidate_count: 3,
      indexed_count: 2,
      scanned_count: 1,
    });
  });

  it("omits optional categories rather than overflowing or byte-slicing JSON", () => {
    const result = compileBoundedOutput({
      requested_bytes: 700,
      maximum_scanned_count: 2,
      candidates: [
        ...boundedCandidates(),
        {
          candidate_id: "history",
          category: "history",
          acquisition: "scan",
          required: false,
          priority: 1,
          value: { text: "x".repeat(1_000) },
        },
      ],
    });
    expect(result.actual_bytes).toBeLessThanOrEqual(700);
    expect(result.complete).toBe(false);
    expect(result.omitted_categories).toContain("history");
    expect(result.payload.some((item) => item.candidate_id === "mission")).toBe(true);
    assertBoundedOutput(result);
  });

  it("refuses when mandatory truth cannot fit or bounded scan accounting is exceeded", () => {
    expectCode(() => compileBoundedOutput({
      requested_bytes: 1,
      maximum_scanned_count: 1,
      candidates: boundedCandidates(),
    }), "seedrop.protocol.budget_insufficient");
    expectCode(() => compileBoundedOutput({
      requested_bytes: 4_096,
      maximum_scanned_count: 0,
      candidates: boundedCandidates(),
    }), "seedrop.protocol.bounded_scan_exceeded");
  });

  it("rejects duplicate candidate identities", () => {
    const candidates = boundedCandidates();
    candidates.push({ ...candidates[0]! });
    expectCode(() => compileBoundedOutput({
      requested_bytes: 4_096,
      maximum_scanned_count: 2,
      candidates,
    }), "seedrop.protocol.budget_invalid");
  });
});

describe("telemetry consent and export", () => {
  it("is local-only when no explicit consent Receipt exists", () => {
    expect(telemetryExportState(null, "2026-08-10T12:00:00.000Z")).toEqual({
      mode: "local_only",
      export_enabled: false,
      reason: "no_consent",
      consent_receipt_id: null,
    });
    expectCode(() => authorizeTelemetryExport(null, exportRequest()), "seedrop.protocol.telemetry_export_denied");
  });

  it("authorizes only an active exact-scope grant and returns a payload digest", () => {
    const receipt = buildTelemetryConsentReceipt(consentInput());
    expect(telemetryExportState(receipt, "2026-08-10T11:59:59.000Z").reason).toBe("not_yet_active");
    expectCode(
      () => authorizeTelemetryExport(receipt, { ...exportRequest(), requested_at: "2026-08-10T11:59:59.000Z" }),
      "seedrop.protocol.telemetry_export_denied",
    );
    const request = exportRequest();
    const authorization = authorizeTelemetryExport(receipt, request);
    expect(authorization.consent_receipt_id).toBe(RECEIPT);
    expect(authorization.payload_digest).toBe(canonicalJsonDigest(request.payload));
    expect(authorization.categories).toEqual(["command_recovery", "outbox_health"]);
    expect(telemetryExportState(receipt, request.requested_at).mode).toBe("consented_export");
  });

  it("denies denied, revoked, expired, destination, schema, identity, and category mismatches", () => {
    for (const decision of ["denied", "revoked"] as const) {
      expectCode(
        () => authorizeTelemetryExport(buildTelemetryConsentReceipt({ ...consentInput(), decision }), exportRequest()),
        "seedrop.protocol.telemetry_export_denied",
      );
    }
    const receipt = buildTelemetryConsentReceipt(consentInput());
    expectCode(
      () => authorizeTelemetryExport(receipt, { ...exportRequest(), requested_at: "2026-09-11T12:00:00.000Z" }),
      "seedrop.protocol.telemetry_export_denied",
    );
    expectCode(
      () => authorizeTelemetryExport(receipt, { ...exportRequest(), destination: "https://other.invalid/v1" }),
      "seedrop.protocol.telemetry_export_denied",
    );
    expectCode(
      () => authorizeTelemetryExport(receipt, { ...exportRequest(), schema_version: "1.1.0" }),
      "seedrop.protocol.telemetry_export_denied",
    );
    expectCode(
      () => authorizeTelemetryExport(receipt, { ...exportRequest(), project_id: "sd_prj_0191416f-4495-7011-a233-44556677889a" }),
      "seedrop.protocol.telemetry_export_denied",
    );
    expectCode(
      () => authorizeTelemetryExport(receipt, { ...exportRequest(), categories: ["identity_aliases"] }),
      "seedrop.protocol.telemetry_export_denied",
    );
    expectCode(
      () => authorizeTelemetryExport(receipt, { ...exportRequest(), categories: ["command_recovery"] }),
      "seedrop.protocol.telemetry_export_denied",
    );
  });

  it("detects secret patterns without returning secret values and blocks export", () => {
    const payload = {
      command_recovery: {
        retry_count: 2,
        credentials: { value: "redacted" },
        note: "Bearer abcdefghijklmnopqrstuvwxyz",
      },
      outbox_health: { dead_letter_count: 1 },
    };
    expect(findTelemetrySecretPatterns(payload)).toEqual([
      { path: "$.command_recovery.credentials", pattern: "sensitive_key" },
      { path: "$.command_recovery.note", pattern: "bearer_credential" },
    ]);
    expectCode(
      () => authorizeTelemetryExport(buildTelemetryConsentReceipt(consentInput()), {
        ...exportRequest(),
        payload,
      }),
      "seedrop.protocol.telemetry_secret_detected",
    );
  });

  it("requires explicit grants to expire and forbids self-evidence", () => {
    expectCode(
      () => buildTelemetryConsentReceipt({ ...consentInput(), expires_at: null }),
      "seedrop.protocol.telemetry_consent_invalid",
    );
    expectCode(
      () => buildTelemetryConsentReceipt({ ...consentInput(), evidence_record_id: RECEIPT }),
      "seedrop.protocol.telemetry_consent_invalid",
    );
  });
});

function metricInput(): BuildOperationalMetricsInput & { spans: BuildOperationalMetricsInput["spans"] extends readonly (infer T)[] ? T[] : never } {
  const kinds = [
    ["duplicate_idempotency", COMMAND_A, 0, null],
    ["cas_conflict", COMMAND_A, 1, null],
    ["retry", COMMAND_A, 1, null],
    ["retry", COMMAND_A, 2, null],
    ["retry", COMMAND_A, 3, null],
    ["outbox_lag", COMMAND_B, 1, 2_000],
    ["outbox_dead_letter", COMMAND_B, 2, 7_500],
  ] as const;
  return {
    generated_at: "2026-08-10T12:00:10.000Z",
    policy: {
      policy_id: "seedrop.kernel.visibility",
      policy_version: "1.0.0",
      maximum_retries_per_command: 2,
      outbox_lag_slo_ms: 5_000,
    },
    spans: kinds.map(([kind, command_id, attempt, outbox_lag_ms], index) => ({
      event_id: `sd_evt_0191416f-4495-7011-a233-445566778${(899 + index).toString(16)}` as `sd_evt_${string}`,
      project_id: PROJECT,
      command_id,
      kind,
      operation: kind.startsWith("outbox") ? "space.post.effects" : "intent.complete",
      observed_at: `2026-08-10T12:00:0${index}.000Z`,
      duration_ms: index * 10,
      attempt,
      outbox_lag_ms,
      evidence_digest: index % 2 === 0 ? DIGEST_A : DIGEST_B,
    })),
  };
}

function resolvedExplanation(): BuildFieldExplanationInput & { evidence: BuildFieldExplanationInput["evidence"] extends readonly (infer T)[] ? T[] : never } {
  return {
    situation_id: SITUATION,
    field: "next_action.command",
    status: "resolved",
    confidence: "confirmed",
    value_digest: DIGEST_A,
    projection_version: "1.0.0",
    policy: {
      policy_id: "seedrop.boot.next-action",
      policy_version: "1.0.0",
      rule_id: "highest-safe-priority",
    },
    decision_record_id: EVENT,
    evidence: [
      {
        record_id: EVENT,
        source_id: "project-events",
        role: "decision",
        digest: DIGEST_B,
        observed_at: "2026-08-10T11:59:58.000Z",
      },
      {
        record_id: CLAIM,
        source_id: "git",
        role: "candidate-evidence",
        digest: DIGEST_A,
        observed_at: "2026-08-10T11:59:57.000Z",
      },
    ],
    unknown: null,
  };
}

function boundedCandidates() {
  return [
    {
      candidate_id: "unicode",
      category: "context",
      acquisition: "scan" as const,
      required: false,
      priority: 5,
      value: { note: "Zażółć 🪴" },
    },
    {
      candidate_id: "risk",
      category: "risk",
      acquisition: "index" as const,
      required: false,
      priority: 10,
      value: { level: "medium" },
    },
    {
      candidate_id: "mission",
      category: "mission",
      acquisition: "index" as const,
      required: true,
      priority: 100,
      value: { goal: "Ship bounded truth" },
    },
  ];
}

function consentInput(): BuildTelemetryConsentInput {
  return {
    receipt_id: RECEIPT,
    principal_id: PRINCIPAL,
    project_id: PROJECT,
    decision: "granted",
    issued_at: "2026-08-10T12:00:00.000Z",
    expires_at: "2026-09-10T12:00:00.000Z",
    purpose: "Export aggregate reliability evidence for an operator-approved pilot.",
    scope: {
      categories: ["outbox_health", "command_recovery"],
      destination: "https://telemetry.example.invalid/v1",
      schema_id: "seedrop.reliability",
      schema_version: "1.0.0",
    },
    evidence_record_id: CLAIM,
  };
}

function exportRequest(): TelemetryExportRequest {
  return {
    principal_id: PRINCIPAL,
    project_id: PROJECT,
    requested_at: "2026-08-10T12:01:00.000Z",
    destination: "https://telemetry.example.invalid/v1",
    schema_id: "seedrop.reliability",
    schema_version: "1.0.0",
    categories: ["outbox_health", "command_recovery"],
    payload: {
      command_recovery: { retry_count: 3 },
      outbox_health: { dead_letter_count: 1, maximum_lag_ms: 7_500 },
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
