import { protocolError } from "./errors.js";

export const VERSION_AXES = Object.freeze([
  "schema",
  "semantic",
  "command",
  "projection",
  "wire",
] as const);

export type VersionAxis = (typeof VERSION_AXES)[number];
export type ProtocolVersion = `${number}.${number}.${number}`;

export interface VersionEnvelope {
  schema_version: ProtocolVersion;
  semantic_version: ProtocolVersion;
  command_version: ProtocolVersion;
  projection_version: ProtocolVersion;
  wire_version: ProtocolVersion;
}

export const CURRENT_VERSIONS = Object.freeze({
  schema: "2.0.0",
  semantic: "2.0.0",
  command: "1.0.0",
  projection: "1.0.0",
  wire: "1.0.0",
} as const satisfies Record<VersionAxis, ProtocolVersion>);

export const SUPPORTED_VERSIONS = Object.freeze({
  schema: Object.freeze([CURRENT_VERSIONS.schema]),
  semantic: Object.freeze([CURRENT_VERSIONS.semantic]),
  command: Object.freeze([CURRENT_VERSIONS.command]),
  projection: Object.freeze([CURRENT_VERSIONS.projection]),
  wire: Object.freeze([CURRENT_VERSIONS.wire]),
} as const satisfies Record<VersionAxis, readonly ProtocolVersion[]>);

export const CURRENT_VERSION_ENVELOPE: VersionEnvelope = Object.freeze({
  schema_version: CURRENT_VERSIONS.schema,
  semantic_version: CURRENT_VERSIONS.semantic,
  command_version: CURRENT_VERSIONS.command,
  projection_version: CURRENT_VERSIONS.projection,
  wire_version: CURRENT_VERSIONS.wire,
});

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function parseProtocolVersion(value: unknown, axis?: VersionAxis): ProtocolVersion {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw protocolError("seedrop.protocol.version_invalid", {
      axis: axis ?? null,
      received: typeof value === "string" ? value : null,
    });
  }
  return value as ProtocolVersion;
}

export function compareProtocolVersions(left: ProtocolVersion, right: ProtocolVersion): -1 | 0 | 1 {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

export function assertSupportedVersion(axis: VersionAxis, value: unknown): ProtocolVersion {
  const version = parseProtocolVersion(value, axis);
  const supported = SUPPORTED_VERSIONS[axis] as readonly ProtocolVersion[];
  if (supported.includes(version)) return version;
  const current = CURRENT_VERSIONS[axis];
  const code = compareProtocolVersions(version, current) > 0
    ? "seedrop.protocol.version_forward"
    : "seedrop.protocol.version_unknown";
  throw protocolError(code, { axis, current, found: version });
}

export function parseVersionEnvelope(value: unknown): VersionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("seedrop.protocol.version_invalid", { axis: null, received: null });
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    schema_version: assertSupportedVersion("schema", record.schema_version),
    semantic_version: assertSupportedVersion("semantic", record.semantic_version),
    command_version: assertSupportedVersion("command", record.command_version),
    projection_version: assertSupportedVersion("projection", record.projection_version),
    wire_version: assertSupportedVersion("wire", record.wire_version),
  });
}
