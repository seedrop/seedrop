import { describe, expect, it } from "vitest";
import {
  CURRENT_VERSION_ENVELOPE,
  ERROR_REGISTRY,
  ProtocolError,
  assertSupportedVersion,
  canonicalJson,
  compareProtocolVersions,
  parseProtocolVersion,
  parseVersionEnvelope,
  protocolError,
  protocolErrorEnvelope,
} from "../src/index.js";
import { golden } from "./fixtures.js";

describe("stable error registry", () => {
  it("matches the frozen registry vector", () => {
    expect(ERROR_REGISTRY).toEqual(golden.error_registry);
    expect(Object.isFrozen(ERROR_REGISTRY)).toBe(true);
    expect(Object.values(ERROR_REGISTRY).every(Object.isFrozen)).toBe(true);
  });

  it("renders a transport-neutral stable envelope", () => {
    const error = protocolError("seedrop.protocol.version_forward", {
      axis: "wire",
      current: "1.0.0",
      found: "2.0.0",
    });
    expect(protocolErrorEnvelope(error)).toEqual({
      error: {
        code: "seedrop.protocol.version_forward",
        category: "compatibility",
        message: "The protocol version is newer than this implementation supports.",
        retryable: false,
        details: { axis: "wire", current: "1.0.0", found: "2.0.0" },
      },
    });
    expect(canonicalJson(error.toJSON())).toBe(canonicalJson(protocolErrorEnvelope(error)));
  });
});

describe("independent protocol versions", () => {
  it("matches the frozen five-axis version vector", () => {
    expect(CURRENT_VERSION_ENVELOPE).toEqual(golden.versions);
    expect(parseVersionEnvelope(golden.versions)).toEqual(golden.versions);
  });

  it("requires strict three-part numeric versions", () => {
    expect(parseProtocolVersion("1.2.3")).toBe("1.2.3");
    for (const invalid of [undefined, "1", "1.0", "01.0.0", "1.0.0-alpha", "latest"]) {
      expectProtocolCode(() => parseProtocolVersion(invalid), "seedrop.protocol.version_invalid");
    }
  });

  it("compares arbitrarily large numeric version segments without precision loss", () => {
    expect(compareProtocolVersions("9007199254740992.0.0", "9007199254740993.0.0")).toBe(-1);
    expectProtocolCode(
      () => assertSupportedVersion("wire", "9007199254740993.0.0"),
      "seedrop.protocol.version_forward",
    );
  });

  it("distinguishes unknown historical versions from forward versions", () => {
    expectProtocolCode(() => assertSupportedVersion("wire", "0.9.0"), "seedrop.protocol.version_unknown");
    expectProtocolCode(() => assertSupportedVersion("wire", "1.1.0"), "seedrop.protocol.version_forward");
  });

  it("does not infer a missing version axis", () => {
    const missing = { ...CURRENT_VERSION_ENVELOPE } as Partial<typeof CURRENT_VERSION_ENVELOPE>;
    delete missing.wire_version;
    expectProtocolCode(() => parseVersionEnvelope(missing), "seedrop.protocol.version_invalid");
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
