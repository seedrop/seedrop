import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
} from "../src/index.js";
import { golden } from "./fixtures.js";

describe("canonical JSON", () => {
  it("matches frozen text, UTF-8 bytes, and digest vectors", () => {
    expect(canonicalJson(golden.canonical_json.value)).toBe(golden.canonical_json.text);
    expect(Buffer.from(canonicalJsonBytes(golden.canonical_json.value)).toString("hex"))
      .toBe(golden.canonical_json.utf8_hex);
    expect(canonicalJsonDigest(golden.canonical_json.value)).toBe(golden.canonical_json.sha256);
  });

  it("is independent of insertion order and normalizes negative zero", () => {
    const left = { z: 3, a: { y: 2, x: -0 } };
    const right = { a: { x: 0, y: 2 }, z: 3 };
    expect(canonicalJson(left)).toBe('{"a":{"x":0,"y":2},"z":3}');
    expect(canonicalJson(right)).toBe(canonicalJson(left));
  });

  it("allows the same object in separate branches but rejects cycles", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectProtocolCode(() => canonicalJson(cyclic), "seedrop.protocol.canonical_json_cycle");
  });

  it.each([
    ["undefined object field", { value: undefined }],
    ["undefined array item", [undefined]],
    ["bigint", 1n],
    ["non-finite number", Number.NaN],
    ["date", new Date(0)],
    ["map", new Map()],
  ])("rejects %s instead of coercing or dropping it", (_name, value) => {
    expectProtocolCode(() => canonicalJson(value), "seedrop.protocol.canonical_json_unsupported");
  });

  it("rejects sparse arrays and unpaired Unicode surrogates", () => {
    const sparse = new Array(2);
    sparse[1] = "present";
    expectProtocolCode(() => canonicalJson(sparse), "seedrop.protocol.canonical_json_unsupported");
    expectProtocolCode(() => canonicalJson("\ud800"), "seedrop.protocol.canonical_json_invalid_unicode");
    expectProtocolCode(() => canonicalJson({ "\udc00": true }), "seedrop.protocol.canonical_json_invalid_unicode");
  });

  it("rejects properties ordinary JSON would silently skip or execute", () => {
    const symbolObject = { visible: true, [Symbol("hidden")]: true };
    expectProtocolCode(() => canonicalJson(symbolObject), "seedrop.protocol.canonical_json_unsupported");

    const hiddenObject = { visible: true };
    Object.defineProperty(hiddenObject, "hidden", { value: true, enumerable: false });
    expectProtocolCode(() => canonicalJson(hiddenObject), "seedrop.protocol.canonical_json_unsupported");

    const accessorObject = Object.defineProperty({}, "dynamic", { enumerable: true, get: () => 1 });
    expectProtocolCode(() => canonicalJson(accessorObject), "seedrop.protocol.canonical_json_unsupported");

    const array = [1];
    Object.assign(array, { extra: 2 });
    expectProtocolCode(() => canonicalJson(array), "seedrop.protocol.canonical_json_unsupported");
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
