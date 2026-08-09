import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  assertCommandAuditTrail,
  buildCommandAuditTrail,
  canonicalJson,
  evaluateCommandInvariants,
  findCommandSweepCandidates,
} from "../src/index.js";
import type {
  BuildCommandAuditTrailInput,
  CommandAuditEntry,
  CommandAuditTrail,
  CommandPhase,
  CommandSweepPolicy,
} from "../src/index.js";

const COMMAND_A = "sd_cmd_0191416f-4495-7011-a233-445566778899" as const;
const COMMAND_B = "sd_cmd_0191416f-4495-7011-a233-44556677889a" as const;
const PRINCIPAL = "sd_prn_0191416f-4495-7011-a233-445566778899" as const;
const PROJECT = "sd_prj_0191416f-4495-7011-a233-445566778899" as const;
const EVENT_A = "sd_evt_0191416f-4495-7011-a233-445566778899" as const;
const EVENT_B = "sd_evt_0191416f-4495-7011-a233-44556677889a" as const;
const EVENT_C = "sd_evt_0191416f-4495-7011-a233-44556677889b" as const;
const EVENT_D = "sd_evt_0191416f-4495-7011-a233-44556677889c" as const;
const INPUT = `sha256:${"a".repeat(64)}`;
const RESULT = `sha256:${"b".repeat(64)}`;
const EVIDENCE = `sha256:${"c".repeat(64)}`;

describe("command audit trail", () => {
  it("accepts a fully terminal command and verifies canonical integrity", () => {
    const trail = buildCommandAuditTrail(completedInput());
    expect(trail.entries.map((entry) => entry.phase)).toEqual(["accepted", "executing", "completed"]);
    expect(trail.entries.at(-1)).toMatchObject({
      result_state_version: "state:18",
      result_digest: RESULT,
      recovery: null,
    });
    expect(Object.isFrozen(trail)).toBe(true);
    assertCommandAuditTrail(trail);
  });

  it("requires every nonterminal phase to retain an explicit recovery owner and budget", () => {
    const trail = buildCommandAuditTrail(pendingInput());
    expect(trail.entries.at(-1)).toMatchObject({
      phase: "effects_pending",
      result_state_version: "state:18",
      result_digest: RESULT,
      recovery: {
        owner_principal_id: PRINCIPAL,
        action: "replay deterministic mention effects",
        attempt_limit: 3,
      },
    });
    expectCode(
      () => buildCommandAuditTrail({
        ...pendingInput(),
        entries: pendingInput().entries.map((entry, index) => index === 1
          ? { ...entry, recovery: null }
          : entry),
      }),
      "seedrop.protocol.command_unrecoverable",
    );
  });

  it("rejects phase transitions after terminal state", () => {
    const input = completedInput();
    expectCode(
      () => buildCommandAuditTrail({
        ...input,
        entries: [
          ...input.entries,
          entry(EVENT_D, "executing", "2026-08-09T12:00:03.000Z", 2),
        ],
      }),
      "seedrop.protocol.command_transition_invalid",
    );
  });

  it("rejects a state-version gap and an exhausted recovery attempt budget", () => {
    const pending = pendingInput();
    expectCode(
      () => buildCommandAuditTrail({
        ...pending,
        entries: pending.entries.map((item, index) => index === 1
          ? { ...item, expected_state_version: "state:99" }
          : item),
      }),
      "seedrop.protocol.command_audit_invalid",
    );
    expectCode(
      () => buildCommandAuditTrail({
        ...pending,
        entries: pending.entries.map((item, index) => index === 1
          ? { ...item, attempt: 3 }
          : item),
      }),
      "seedrop.protocol.command_unrecoverable",
    );
  });

  it("rejects a tampered audit object", () => {
    const trail = buildCommandAuditTrail(completedInput());
    expectCode(
      () => assertCommandAuditTrail({ ...trail, adapter_summary: "ok" } as CommandAuditTrail),
      "seedrop.protocol.command_audit_inconsistent",
    );
  });
});

describe("age/state invariant and sweep queries", () => {
  it("reports terminal and recoverable commands without collapsing them", () => {
    const reports = evaluateCommandInvariants(
      [buildCommandAuditTrail(pendingInput()), buildCommandAuditTrail(completedInput())],
      policy(),
      "2026-08-09T12:00:03.000Z",
    );
    expect(reports.map((report) => [report.command_id, report.terminal, report.recoverable])).toEqual([
      [COMMAND_A, true, false],
      [COMMAND_B, false, true],
    ]);
    expect(reports.every((report) => report.violations.length === 0)).toBe(true);
  });

  it("produces a read-only deterministic sweep candidate after idle, age, and deadline thresholds", () => {
    const trail = buildCommandAuditTrail(pendingInput());
    const candidates = findCommandSweepCandidates(
      [trail],
      policy(),
      "2026-08-09T12:02:01.000Z",
    );
    expect(candidates).toEqual([expect.objectContaining({
      command_id: COMMAND_B,
      observed_phase: "effects_pending",
      recovery_owner_principal_id: PRINCIPAL,
      reason_codes: ["command_age_exceeded", "phase_idle_exceeded", "recovery_deadline_exceeded"],
      proposed_event: expect.objectContaining({
        event_type: "command.sweep_candidate",
        confidence: "inferred",
      }),
    })]);
    expect(canonicalJson(candidates)).not.toContain("completed");
  });

  it("never proposes a sweep for a terminal command regardless of age", () => {
    expect(findCommandSweepCandidates(
      [buildCommandAuditTrail(completedInput())],
      policy(),
      "2026-08-10T12:00:00.000Z",
    )).toEqual([]);
  });

  it("rejects duplicate idempotency identity across different commands", () => {
    const first = buildCommandAuditTrail(completedInput());
    const second = buildCommandAuditTrail({
      ...pendingInput(),
      idempotency_key: first.idempotency_key,
      command_name: first.command_name,
    });
    expectCode(
      () => evaluateCommandInvariants([first, second], policy(), "2026-08-09T12:00:03.000Z"),
      "seedrop.protocol.command_audit_invalid",
    );
  });

  it("rejects an observation that predates the latest audit event", () => {
    expectCode(
      () => evaluateCommandInvariants(
        [buildCommandAuditTrail(pendingInput())],
        policy(),
        "2026-08-09T12:00:00.500Z",
      ),
      "seedrop.protocol.command_audit_invalid",
    );
  });
});

function completedInput(): BuildCommandAuditTrailInput {
  return {
    command_id: COMMAND_A,
    command_version: "1.0.0",
    command_name: "intent.complete",
    principal_id: PRINCIPAL,
    project_id: PROJECT,
    idempotency_key: "complete-intent-42",
    input_digest: INPUT,
    accepted_at: "2026-08-09T12:00:00.000Z",
    entries: [
      entry(EVENT_A, "accepted", "2026-08-09T12:00:00.000Z", 0),
      entry(EVENT_B, "executing", "2026-08-09T12:00:01.000Z", 1),
      {
        ...entry(EVENT_C, "completed", "2026-08-09T12:00:02.000Z", 1),
        result_state_version: "state:18",
        result_digest: RESULT,
        recovery: null,
      },
    ],
  };
}

function pendingInput(): BuildCommandAuditTrailInput {
  return {
    command_id: COMMAND_B,
    command_version: "1.0.0",
    command_name: "space.post",
    principal_id: PRINCIPAL,
    project_id: PROJECT,
    idempotency_key: "space-post-99",
    input_digest: INPUT,
    accepted_at: "2026-08-09T12:00:00.000Z",
    entries: [
      entry(EVENT_A, "accepted", "2026-08-09T12:00:00.000Z", 0),
      {
        ...entry(EVENT_B, "effects_pending", "2026-08-09T12:00:01.000Z", 1),
        result_state_version: "state:18",
        result_digest: RESULT,
      },
    ],
  };
}

function entry(
  eventId: typeof EVENT_A | typeof EVENT_B | typeof EVENT_C | typeof EVENT_D,
  phase: CommandPhase,
  recordedAt: string,
  attempt: number,
): CommandAuditEntry {
  const terminal = phase === "completed" || phase === "rejected" || phase === "failed" || phase === "compensated";
  const errorRequired = phase === "recovery_pending" || phase === "rejected" || phase === "failed";
  return {
    event_id: eventId,
    phase,
    recorded_at: recordedAt,
    expected_state_version: "state:17",
    result_state_version: null,
    result_digest: null,
    attempt,
    error: errorRequired ? {
      code: "effects_failed",
      message: "The durable effect has not been observed.",
      retryable: phase !== "failed",
      evidence_digest: EVIDENCE,
    } : null,
    recovery: terminal ? null : {
      owner_principal_id: PRINCIPAL,
      action: phase === "effects_pending" ? "replay deterministic mention effects" : "resume command executor",
      recover_by: "2026-08-09T12:01:00.000Z",
      attempt_limit: 3,
    },
  };
}

function policy(): CommandSweepPolicy {
  return {
    policy_id: "seedrop.command.default",
    policy_version: "1.0.0",
    maximum_command_age_ms: 120_000,
    phase_maximum_idle_ms: {
      accepted: 30_000,
      executing: 30_000,
      effects_pending: 30_000,
      recovery_pending: 60_000,
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
