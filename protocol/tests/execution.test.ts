import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  assertCommandCommitReceipt,
  assertOutboxDeliveryReceipt,
  assertOutboxEffect,
  buildCommandCommitReceipt,
  buildOutboxDeliveryReceipt,
  buildOutboxEffect,
  canonicalJsonDigest,
  generateCanonicalId,
} from "../src/index.js";

const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => seed + index);
const id = <K extends "event" | "command" | "project" | "principal" | "receipt">(kind: K, seed: number) => (
  generateCanonicalId(kind, { now: 1_723_379_696_000 + seed, entropy: entropy(seed) })
);
const EVENT = id("event", 1);
const COMMAND = id("command", 2);
const PROJECT = id("project", 3);
const PRINCIPAL = id("principal", 4);
const DELIVERY = id("receipt", 5);
const COMMIT = id("receipt", 6);
const DIGEST = `sha256:${"ab".repeat(32)}` as const;
const PROJECTION = `sha256:${"cd".repeat(32)}` as const;

describe("outbox execution contracts", () => {
  it("binds canonical effect payload bytes to one effect identity", () => {
    const effect = buildOutboxEffect({
      effect_id: EVENT,
      effect_key: "message:42",
      command_id: COMMAND,
      project_id: PROJECT,
      effect_type: "space.message.post",
      declared_at: "2026-08-11T10:00:00.000Z",
      required: true,
      payload: { message: "hello", recipients: ["claude"] },
    });
    expect(effect.payload_digest).toBe(canonicalJsonDigest(effect.payload));
    expect(() => assertOutboxEffect(effect)).not.toThrow();
    expectCode(() => assertOutboxEffect({ ...effect, payload: { message: "changed" } }), "seedrop.protocol.outbox_effect_invalid");
  });

  it("makes delivered and dead-letter Receipts mutually honest", () => {
    const delivered = buildOutboxDeliveryReceipt({
      receipt_id: DELIVERY,
      effect_id: EVENT,
      effect_key: "message:42",
      command_id: COMMAND,
      project_id: PROJECT,
      state: "delivered",
      attempt: 1,
      recorded_at: "2026-08-11T10:00:01.000Z",
      evidence_digest: DIGEST,
      error: null,
    });
    expect(() => assertOutboxDeliveryReceipt(delivered)).not.toThrow();
    expectCode(() => buildOutboxDeliveryReceipt({ ...delivered, evidence_digest: null }), "seedrop.protocol.outbox_delivery_invalid");
    expectCode(() => buildOutboxDeliveryReceipt({ ...delivered, state: "dead_letter" }), "seedrop.protocol.outbox_delivery_invalid");
  });
});

describe("committed command Receipt", () => {
  it("separates completed, pending, and repair-required truth", () => {
    const completed = buildCommandCommitReceipt({
      receipt_id: COMMIT,
      command_id: COMMAND,
      principal_id: PRINCIPAL,
      project_id: PROJECT,
      command_name: "intent.create",
      idempotency_key: "intent-42",
      input_digest: DIGEST,
      transaction_digest: DIGEST,
      projection_digest: PROJECTION,
      outcome: "completed",
      outbox_effect_count: 1,
      outbox_delivered_count: 1,
      recorded_at: "2026-08-11T10:00:02.000Z",
      recovery: null,
      error: null,
    });
    expect(() => assertCommandCommitReceipt(completed)).not.toThrow();
    expectCode(
      () => buildCommandCommitReceipt({ ...completed, outbox_delivered_count: 0 }),
      "seedrop.protocol.command_commit_receipt_invalid",
    );
    const recovery = {
      owner_principal_id: PRINCIPAL,
      action: `recover command ${COMMAND}`,
      recover_by: "2026-08-11T10:01:02.000Z",
      attempt_limit: 3,
    };
    expect(buildCommandCommitReceipt({
      ...completed,
      outcome: "effects_pending",
      outbox_delivered_count: 0,
      recovery,
    }).outcome).toBe("effects_pending");
    expectCode(
      () => buildCommandCommitReceipt({ ...completed, outcome: "needs_repair", recovery }),
      "seedrop.protocol.command_commit_receipt_invalid",
    );
  });
});

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}
