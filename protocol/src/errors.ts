import type { JsonValue } from "./canonical-json.js";

export const ERROR_REGISTRY = Object.freeze({
  "seedrop.protocol.invalid_id": {
    category: "input",
    message: "The identifier is not a canonical Seedrop v2 identifier.",
    retryable: false,
  },
  "seedrop.protocol.id_prefix_too_short": {
    category: "input",
    message: "The identifier prefix is shorter than the protocol minimum.",
    retryable: false,
  },
  "seedrop.protocol.id_prefix_not_found": {
    category: "not_found",
    message: "The identifier prefix did not match a canonical identifier.",
    retryable: false,
  },
  "seedrop.protocol.id_prefix_ambiguous": {
    category: "conflict",
    message: "The identifier prefix matched more than one canonical identifier.",
    retryable: false,
  },
  "seedrop.protocol.canonical_json_unsupported": {
    category: "input",
    message: "The value is outside the canonical JSON data model.",
    retryable: false,
  },
  "seedrop.protocol.canonical_json_cycle": {
    category: "input",
    message: "Canonical JSON cannot encode a cyclic value.",
    retryable: false,
  },
  "seedrop.protocol.canonical_json_invalid_unicode": {
    category: "input",
    message: "Canonical JSON cannot encode an unpaired Unicode surrogate.",
    retryable: false,
  },
  "seedrop.protocol.version_invalid": {
    category: "input",
    message: "The protocol version is missing or malformed.",
    retryable: false,
  },
  "seedrop.protocol.version_unknown": {
    category: "compatibility",
    message: "The protocol version is not registered as supported.",
    retryable: false,
  },
  "seedrop.protocol.version_forward": {
    category: "compatibility",
    message: "The protocol version is newer than this implementation supports.",
    retryable: false,
  },
  "seedrop.protocol.migration_graph_invalid": {
    category: "integrity",
    message: "The migration graph is ambiguous, cyclic, orphaned, or has a gap.",
    retryable: false,
  },
  "seedrop.protocol.migration_failed": {
    category: "integrity",
    message: "A registered protocol migration failed.",
    retryable: false,
  },
  "seedrop.protocol.validation_failed": {
    category: "input",
    message: "The migrated protocol value failed current-schema validation.",
    retryable: false,
  },
} as const);

for (const definition of Object.values(ERROR_REGISTRY)) Object.freeze(definition);

export type ProtocolErrorCode = keyof typeof ERROR_REGISTRY;
export type ProtocolErrorCategory = (typeof ERROR_REGISTRY)[ProtocolErrorCode]["category"];
export type ProtocolErrorDetails = Readonly<Record<string, JsonValue>>;

export interface ProtocolErrorEnvelope {
  error: {
    code: ProtocolErrorCode;
    category: ProtocolErrorCategory;
    message: string;
    retryable: boolean;
    details: ProtocolErrorDetails;
  };
}

export class ProtocolError<C extends ProtocolErrorCode = ProtocolErrorCode> extends Error {
  public readonly code: C;
  public readonly category: (typeof ERROR_REGISTRY)[C]["category"];
  public readonly retryable: (typeof ERROR_REGISTRY)[C]["retryable"];
  public readonly details: ProtocolErrorDetails;

  constructor(code: C, details: ProtocolErrorDetails = {}, options?: { cause?: unknown }) {
    const definition = ERROR_REGISTRY[code];
    super(definition.message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProtocolError";
    this.code = code;
    this.category = definition.category;
    this.retryable = definition.retryable;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): ProtocolErrorEnvelope {
    return protocolErrorEnvelope(this);
  }
}

export function protocolError<C extends ProtocolErrorCode>(
  code: C,
  details: ProtocolErrorDetails = {},
  options?: { cause?: unknown },
): ProtocolError<C> {
  return new ProtocolError(code, details, options);
}

export function isProtocolError(value: unknown): value is ProtocolError {
  return value instanceof ProtocolError;
}

export function protocolErrorEnvelope(error: ProtocolError): ProtocolErrorEnvelope {
  return {
    error: {
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
  };
}
