import { describe, expect, it } from "vitest";
import {
  CANONICAL_ID_KINDS,
  CANONICAL_ID_KIND_CODES,
  ProtocolError,
  generateCanonicalId,
  isCanonicalId,
  parseCanonicalId,
  resolveCanonicalIdInput,
  type CanonicalId,
} from "../src/index.js";
import { golden } from "./fixtures.js";

describe("canonical Seedrop IDs", () => {
  it("matches the frozen public kind-code registry", () => {
    expect(CANONICAL_ID_KIND_CODES).toEqual(golden.id_kind_codes);
    expect(Object.isFrozen(CANONICAL_ID_KIND_CODES)).toBe(true);
  });

  it("matches the frozen UUIDv7 golden vector", () => {
    const entropy = Uint8Array.from(Buffer.from(golden.canonical_id.entropy_hex, "hex"));
    const id = generateCanonicalId("intent", { now: golden.canonical_id.timestamp_ms, entropy });
    expect(id).toBe(golden.canonical_id.value);
    expect(parseCanonicalId(id, "intent")).toEqual({
      value: golden.canonical_id.value,
      kind: "intent",
      uuid: "0191416f-4495-7011-a233-445566778899",
      timestamp_ms: golden.canonical_id.timestamp_ms,
    });
  });

  it("generates a typed canonical ID for every public identity/address kind", () => {
    for (const [index, kind] of CANONICAL_ID_KINDS.entries()) {
      const id = generateCanonicalId(kind, {
        now: 1_700_000_000_000 + index,
        entropy: new Uint8Array(10).fill(index),
      });
      expect(isCanonicalId(id, kind)).toBe(true);
      expect(parseCanonicalId(id).kind).toBe(kind);
    }
  });

  it("rejects non-canonical casing, UUID versions, and cross-kind use", () => {
    expect(isCanonicalId(golden.canonical_id.value.toUpperCase())).toBe(false);
    expect(isCanonicalId("sd_int_550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(() => parseCanonicalId(golden.canonical_id.value, "project")).toThrowError(ProtocolError);
  });

  it("resolves a prefix only at the explicit input boundary and returns the full ID", () => {
    const wanted = golden.canonical_id.value as CanonicalId<"intent">;
    const other = generateCanonicalId("intent", {
      now: golden.canonical_id.timestamp_ms + 100_000,
      entropy: new Uint8Array(10).fill(0xff),
    });
    expect(resolveCanonicalIdInput("intent", "0191416F4495", [wanted, other])).toBe(wanted);
    expect(resolveCanonicalIdInput("intent", "int_0191416f-4495", [wanted, other])).toBe(wanted);
    expect(resolveCanonicalIdInput("intent", wanted, [wanted, other])).toBe(wanted);
  });

  it("fails typed on short, missing, and ambiguous prefixes", () => {
    const first = generateCanonicalId("intent", {
      now: golden.canonical_id.timestamp_ms,
      entropy: new Uint8Array(10).fill(1),
    });
    const second = generateCanonicalId("intent", {
      now: golden.canonical_id.timestamp_ms,
      entropy: new Uint8Array(10).fill(2),
    });
    expectProtocolCode(() => resolveCanonicalIdInput("intent", "0191416", [first]), "seedrop.protocol.id_prefix_too_short");
    expectProtocolCode(() => resolveCanonicalIdInput("intent", "ffffffff", [first]), "seedrop.protocol.id_prefix_not_found");
    expectProtocolCode(() => resolveCanonicalIdInput("intent", "0191416f", [first, second]), "seedrop.protocol.id_prefix_ambiguous");
  });

  it("rejects invalid generation inputs rather than truncating them", () => {
    expectProtocolCode(
      () => generateCanonicalId("claim", { now: -1, entropy: new Uint8Array(10) }),
      "seedrop.protocol.invalid_id",
    );
    expectProtocolCode(
      () => generateCanonicalId("claim", { now: 1, entropy: new Uint8Array(9) }),
      "seedrop.protocol.invalid_id",
    );
  });
});

function expectProtocolCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}
