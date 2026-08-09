import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  assertRepairJournal,
  assertRepairReceipt,
  buildRepairReceipt,
  canonicalJsonDigest,
  queryRepairReceipts,
} from "../src/index.js";
import type { BuildRepairReceiptInput, RepairReceipt } from "../src/index.js";

const RECEIPT_A = "sd_rcp_0191416f-4495-7011-a233-445566778899" as const;
const RECEIPT_B = "sd_rcp_0191416f-4495-7011-a233-44556677889a" as const;
const COMMAND_A = "sd_cmd_0191416f-4495-7011-a233-445566778899" as const;
const COMMAND_B = "sd_cmd_0191416f-4495-7011-a233-44556677889a" as const;
const PRINCIPAL = "sd_prn_0191416f-4495-7011-a233-445566778899" as const;
const RECOVERY_OWNER = "sd_prn_0191416f-4495-7011-a233-44556677889a" as const;
const PROJECT = "sd_prj_0191416f-4495-7011-a233-445566778899" as const;
const EVENT = "sd_evt_0191416f-4495-7011-a233-445566778899" as const;
const CLAIM = "sd_clm_0191416f-4495-7011-a233-445566778899" as const;
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

describe("repair Receipt", () => {
  it("records actor, evidence, before/after state, command digest, rollback, and recovery owner", () => {
    const receipt = buildRepairReceipt(firstInput());
    expect(receipt).toMatchObject({
      receipt_id: RECEIPT_A,
      actor_principal_id: PRINCIPAL,
      recovery_owner_principal_id: RECOVERY_OWNER,
      outcome: "applied",
      rollback: { mode: "snapshot", artifact_digest: DIGEST_C },
    });
    expect(receipt.evidence.map((item) => item.record_id)).toEqual([CLAIM, EVENT]);
    expect(Object.isFrozen(receipt)).toBe(true);
    assertRepairReceipt(receipt);
  });

  it("rejects applied-without-change while preserving partial mutation on failure", () => {
    const applied = firstInput();
    expectCode(
      () => buildRepairReceipt({ ...applied, after: applied.before }),
      "seedrop.protocol.repair_receipt_invalid",
    );
    const failed = buildRepairReceipt({
      ...applied,
      outcome: "failed",
      failure: { code: "repair_failed", message: "write rejected after a partial mutation", evidence_digest: DIGEST_C },
    });
    expect(failed.before).not.toEqual(failed.after);
    expect(failed.failure?.code).toBe("repair_failed");
    expectCode(
      () => buildRepairReceipt({ ...applied, outcome: "failed", failure: null }),
      "seedrop.protocol.repair_receipt_invalid",
    );
  });

  it("rejects missing evidence and an ambiguous unavailable rollback", () => {
    const input = firstInput();
    expectCode(
      () => buildRepairReceipt({ ...input, evidence: [] }),
      "seedrop.protocol.repair_receipt_invalid",
    );
    expectCode(
      () => buildRepairReceipt({
        ...input,
        rollback: {
          mode: "unavailable",
          instruction: "try manually",
          artifact_digest: null,
          unavailable_reason: null,
        },
      }),
      "seedrop.protocol.repair_receipt_invalid",
    );
  });

  it("rejects a tampered receipt", () => {
    const receipt = buildRepairReceipt(firstInput());
    expectCode(
      () => assertRepairReceipt({ ...receipt, operator_summary: "fixed" } as RepairReceipt),
      "seedrop.protocol.repair_receipt_invalid",
    );
  });
});

describe("append-only repair journal", () => {
  it("verifies the hash chain and makes every repair queryable", () => {
    const first = buildRepairReceipt(firstInput());
    const second = buildRepairReceipt(secondInput(canonicalJsonDigest(first)));
    assertRepairJournal([second, first]);
    expect(queryRepairReceipts([second, first]).map((receipt) => receipt.receipt_id)).toEqual([RECEIPT_A, RECEIPT_B]);
    expect(queryRepairReceipts([second, first], { outcome: "no_change" })).toEqual([second]);
    expect(queryRepairReceipts([second, first], { target_kind: "quarantine" })).toEqual([first]);
    expect(queryRepairReceipts([second, first], { recovery_owner_principal_id: RECOVERY_OWNER })).toHaveLength(2);
  });

  it("rejects a broken prior digest and sequence gap", () => {
    const first = buildRepairReceipt(firstInput());
    const brokenDigest = buildRepairReceipt(secondInput(DIGEST_A));
    expectCode(
      () => assertRepairJournal([first, brokenDigest]),
      "seedrop.protocol.repair_journal_invalid",
    );
    const gap = buildRepairReceipt({
      ...secondInput(canonicalJsonDigest(first)),
      journal: { sequence: 3, previous_receipt_digest: canonicalJsonDigest(first) },
    });
    expectCode(
      () => assertRepairJournal([first, gap]),
      "seedrop.protocol.repair_journal_invalid",
    );
  });

  it("rejects duplicate receipt identity", () => {
    const first = buildRepairReceipt(firstInput());
    expectCode(
      () => assertRepairJournal([first, first]),
      "seedrop.protocol.repair_journal_invalid",
    );
  });

  it("rejects mixing Projects inside one repair journal", () => {
    const first = buildRepairReceipt(firstInput());
    const second = buildRepairReceipt({
      ...secondInput(canonicalJsonDigest(first)),
      project_id: "sd_prj_0191416f-4495-7011-a233-44556677889a",
    });
    expectCode(
      () => assertRepairJournal([first, second]),
      "seedrop.protocol.repair_journal_invalid",
    );
  });
});

function firstInput(): BuildRepairReceiptInput {
  return {
    receipt_id: RECEIPT_A,
    repair_command_id: COMMAND_A,
    project_id: PROJECT,
    actor_principal_id: PRINCIPAL,
    recovery_owner_principal_id: RECOVERY_OWNER,
    issued_at: "2026-08-09T12:00:00.000Z",
    target: { kind: "quarantine", referent: "events/0042.json" },
    command: { name: "doctor.quarantine.repair", input_digest: DIGEST_A },
    evidence: [
      { record_id: EVENT, role: "parse_failure", digest: DIGEST_B, observed_at: "2026-08-09T11:59:00.000Z" },
      { record_id: CLAIM, role: "operator_authorization", digest: DIGEST_A, observed_at: "2026-08-09T11:59:30.000Z" },
    ],
    before: { state_version: "state:17", digest: DIGEST_A },
    after: { state_version: "state:18", digest: DIGEST_B },
    outcome: "applied",
    failure: null,
    rollback: {
      mode: "snapshot",
      instruction: "restore snapshot object and append a rollback Receipt",
      artifact_digest: DIGEST_C,
      unavailable_reason: null,
    },
    journal: { sequence: 1, previous_receipt_digest: null },
  };
}

function secondInput(previousDigest: string): BuildRepairReceiptInput {
  return {
    receipt_id: RECEIPT_B,
    repair_command_id: COMMAND_B,
    project_id: PROJECT,
    actor_principal_id: PRINCIPAL,
    recovery_owner_principal_id: RECOVERY_OWNER,
    issued_at: "2026-08-09T12:01:00.000Z",
    target: { kind: "migration", referent: "project-events" },
    command: { name: "migration.verify", input_digest: DIGEST_B },
    evidence: [
      { record_id: EVENT, role: "verification", digest: DIGEST_C, observed_at: "2026-08-09T12:00:30.000Z" },
    ],
    before: { state_version: "state:18", digest: DIGEST_B },
    after: { state_version: "state:18", digest: DIGEST_B },
    outcome: "no_change",
    failure: null,
    rollback: {
      mode: "unavailable",
      instruction: null,
      artifact_digest: null,
      unavailable_reason: "Verification did not mutate state, so rollback is not applicable.",
    },
    journal: { sequence: 2, previous_receipt_digest: previousDigest },
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
