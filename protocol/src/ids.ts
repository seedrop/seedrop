import { randomBytes } from "node:crypto";
import { protocolError } from "./errors.js";

export const CANONICAL_ID_KINDS = Object.freeze([
  "principal",
  "project",
  "intent",
  "episode",
  "claim",
  "receipt",
  "lease",
  "event",
  "situation",
  "command",
] as const);

export type CanonicalIdKind = (typeof CANONICAL_ID_KINDS)[number];
export type CanonicalId<K extends CanonicalIdKind = CanonicalIdKind> = string & {
  readonly __seedropCanonicalId: K;
};

export const CANONICAL_ID_KIND_CODES = Object.freeze({
  principal: "prn",
  project: "prj",
  intent: "int",
  episode: "eps",
  claim: "clm",
  receipt: "rcp",
  lease: "lse",
  event: "evt",
  situation: "sit",
  command: "cmd",
} as const satisfies Record<CanonicalIdKind, string>);

const CODE_KINDS = Object.freeze(Object.fromEntries(
  Object.entries(CANONICAL_ID_KIND_CODES).map(([kind, code]) => [code, kind]),
) as Record<(typeof CANONICAL_ID_KIND_CODES)[CanonicalIdKind], CanonicalIdKind>);

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_ID = /^sd_([a-z]{3})_([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const MAX_TIMESTAMP_MS = 0xffffffffffff;
export const MIN_ID_PREFIX_HEX_LENGTH = 8;

export interface GenerateCanonicalIdOptions {
  now?: number;
  /** Exactly ten bytes. Exposed for reproducible vectors; production callers omit it. */
  entropy?: Uint8Array;
}

export interface ParsedCanonicalId<K extends CanonicalIdKind = CanonicalIdKind> {
  value: CanonicalId<K>;
  kind: K;
  uuid: string;
  timestamp_ms: number;
}

export function generateCanonicalId<K extends CanonicalIdKind>(
  kind: K,
  options: GenerateCanonicalIdOptions = {},
): CanonicalId<K> {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIMESTAMP_MS) {
    throw protocolError("seedrop.protocol.invalid_id", { reason: "timestamp_out_of_range" });
  }
  const entropy = options.entropy ?? randomBytes(10);
  if (entropy.byteLength !== 10) {
    throw protocolError("seedrop.protocol.invalid_id", {
      reason: "entropy_length",
      received_bytes: entropy.byteLength,
    });
  }

  const bytes = new Uint8Array(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (entropy[0]! & 0x0f);
  bytes[7] = entropy[1]!;
  bytes[8] = 0x80 | (entropy[2]! & 0x3f);
  for (let index = 9; index < 16; index += 1) {
    bytes[index] = entropy[index - 6]!;
  }

  return `sd_${CANONICAL_ID_KIND_CODES[kind]}_${formatUuid(bytes)}` as CanonicalId<K>;
}

export function parseCanonicalId<K extends CanonicalIdKind>(
  value: string,
  expectedKind?: K,
): ParsedCanonicalId<K> {
  const match = CANONICAL_ID.exec(value);
  const code = match?.[1] as keyof typeof CODE_KINDS | undefined;
  const kind = code ? CODE_KINDS[code] : undefined;
  const uuid = match?.[2];
  if (!kind || !uuid || !UUID_V7.test(uuid) || (expectedKind !== undefined && kind !== expectedKind)) {
    throw protocolError("seedrop.protocol.invalid_id", {
      expected_kind: expectedKind ?? null,
      received: value,
    });
  }
  const compactTimestamp = uuid.slice(0, 8) + uuid.slice(9, 13);
  return {
    value: value as CanonicalId<K>,
    kind: kind as K,
    uuid,
    timestamp_ms: Number.parseInt(compactTimestamp, 16),
  };
}

export function isCanonicalId(value: unknown, expectedKind?: CanonicalIdKind): value is CanonicalId {
  if (typeof value !== "string") return false;
  try {
    parseCanonicalId(value, expectedKind);
    return true;
  } catch {
    return false;
  }
}

export function resolveCanonicalIdInput<K extends CanonicalIdKind>(
  kind: K,
  input: string,
  candidates: readonly CanonicalId<K>[],
): CanonicalId<K> {
  if (isCanonicalId(input, kind)) return input as CanonicalId<K>;

  const expectedCode = CANONICAL_ID_KIND_CODES[kind];
  const normalized = input.toLowerCase().trim();
  const withoutType = normalized.startsWith(`sd_${expectedCode}_`)
    ? normalized.slice(`sd_${expectedCode}_`.length)
    : normalized.startsWith(`${expectedCode}_`)
      ? normalized.slice(expectedCode.length + 1)
      : normalized;
  const hexPrefix = withoutType.replaceAll("-", "");
  if (!/^[0-9a-f]+$/.test(hexPrefix)) {
    throw protocolError("seedrop.protocol.invalid_id", { expected_kind: kind, received: input });
  }
  if (hexPrefix.length < MIN_ID_PREFIX_HEX_LENGTH) {
    throw protocolError("seedrop.protocol.id_prefix_too_short", {
      expected_kind: kind,
      minimum_hex_length: MIN_ID_PREFIX_HEX_LENGTH,
      received_hex_length: hexPrefix.length,
    });
  }

  const matches = [...new Set(candidates)].filter((candidate) => {
    const parsed = parseCanonicalId(candidate, kind);
    return parsed.uuid.replaceAll("-", "").startsWith(hexPrefix);
  });
  if (matches.length === 0) {
    throw protocolError("seedrop.protocol.id_prefix_not_found", { expected_kind: kind, prefix: input });
  }
  if (matches.length > 1) {
    throw protocolError("seedrop.protocol.id_prefix_ambiguous", {
      expected_kind: kind,
      prefix: input,
      match_count: matches.length,
    });
  }
  return matches[0]!;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
