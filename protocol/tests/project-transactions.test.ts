import { describe, expect, it } from "vitest";
import {
  PROJECT_EVENT_VERSION,
  PROJECT_TRANSACTION_VERSION,
  ProtocolError,
  buildProjectEvent,
  buildProjectTransaction,
  generateCanonicalId,
  projectTransactionBytes,
  projectTransactionDigest,
} from "../src/index.js";

const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff);
const id = <K extends "principal" | "project" | "command" | "event" | "intent">(kind: K, seed: number) => (
  generateCanonicalId(kind, { now: 1_723_379_696_000 + seed, entropy: entropy(seed) })
);

function transactionInput() {
  return {
    command_id: id("command", 1),
    command_version: "1.0.0" as const,
    command_name: "project.record_test_event",
    principal_id: id("principal", 2),
    project_id: id("project", 3),
    idempotency_key: "fixture-command-1",
    input_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const,
    previous_transaction_digest: null,
    recorded_at: "2026-08-11T06:30:00.000Z",
    events: [{
      event_id: id("event", 4),
      event_type: "project.test_recorded",
      subject_id: id("intent", 5),
      occurred_at: "2026-08-11T06:29:59.000Z",
      payload: { alpha: 1, nested: [true, null, "Zażółć"] },
    }],
  };
}

describe("project transaction protocol", () => {
  it("builds deeply frozen canonical envelopes with stable bytes and digest", () => {
    const transaction = buildProjectTransaction(transactionInput());
    expect(transaction.transaction_version).toBe(PROJECT_TRANSACTION_VERSION);
    expect(transaction.events[0]?.event_version).toBe(PROJECT_EVENT_VERSION);
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(Object.isFrozen(transaction.events)).toBe(true);
    expect(Object.isFrozen(transaction.events[0]?.payload)).toBe(true);
    expect(new TextDecoder().decode(projectTransactionBytes(transaction))).toContain('"transaction_version":"1.0.0"');
    expect(projectTransactionDigest(transaction)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("requires exact fields, canonical timestamps, identifiers, digests, and event names", () => {
    const base = transactionInput();
    expectCode(() => buildProjectTransaction({ ...base, recorded_at: "2026-08-11T08:30:00+02:00" }), "seedrop.protocol.project_transaction_invalid");
    expectCode(() => buildProjectTransaction({ ...base, input_digest: "sha256:nope" as never }), "seedrop.protocol.project_transaction_invalid");
    expectCode(() => buildProjectTransaction({ ...base, command_name: "" }), "seedrop.protocol.project_transaction_invalid");
    expectCode(() => buildProjectEvent({ ...base.events[0]!, event_type: "AdapterMeaning" }), "seedrop.protocol.project_event_invalid");
    expectCode(() => buildProjectTransaction({ ...base, extra: true } as never), "seedrop.protocol.project_transaction_invalid");
  });

  it("requires at least one unique event no later than the transaction", () => {
    const base = transactionInput();
    expectCode(() => buildProjectTransaction({ ...base, events: [] }), "seedrop.protocol.project_transaction_invalid");
    expectCode(() => buildProjectTransaction({ ...base, events: [base.events[0]!, base.events[0]!] }), "seedrop.protocol.project_transaction_invalid");
    expectCode(() => buildProjectTransaction({
      ...base,
      events: [{ ...base.events[0]!, occurred_at: "2026-08-11T06:30:01.000Z" }],
    }), "seedrop.protocol.project_transaction_invalid");
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
