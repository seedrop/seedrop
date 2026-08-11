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
  "seedrop.protocol.identity_registry_invalid": {
    category: "integrity",
    message: "The identity registry is malformed or internally inconsistent.",
    retryable: false,
  },
  "seedrop.protocol.identity_alias_not_found": {
    category: "not_found",
    message: "The identity alias did not resolve to a registered canonical identity.",
    retryable: false,
  },
  "seedrop.protocol.identity_alias_ambiguous": {
    category: "authorization",
    message: "The identity alias resolves to multiple canonical identities and is denied.",
    retryable: false,
  },
  "seedrop.protocol.health_invalid": {
    category: "input",
    message: "The HealthEnvelope input is malformed or incomplete.",
    retryable: false,
  },
  "seedrop.protocol.health_inconsistent": {
    category: "integrity",
    message: "The HealthEnvelope summary disagrees with its structured evidence.",
    retryable: false,
  },
  "seedrop.protocol.health_disagreement_invalid": {
    category: "integrity",
    message: "The HealthEnvelope disagreement record is malformed or does not preserve a real contradiction.",
    retryable: false,
  },
  "seedrop.protocol.command_audit_invalid": {
    category: "integrity",
    message: "The command audit trail is malformed, incomplete, or internally inconsistent.",
    retryable: false,
  },
  "seedrop.protocol.command_audit_inconsistent": {
    category: "integrity",
    message: "The command audit summary disagrees with its canonical audit entries.",
    retryable: false,
  },
  "seedrop.protocol.command_transition_invalid": {
    category: "conflict",
    message: "The command phase transition is not permitted by the command protocol.",
    retryable: false,
  },
  "seedrop.protocol.command_unrecoverable": {
    category: "integrity",
    message: "A nonterminal command has no valid recovery path or a terminal command retains one.",
    retryable: false,
  },
  "seedrop.protocol.command_request_invalid": {
    category: "input",
    message: "The kernel command request is malformed or incomplete.",
    retryable: false,
  },
  "seedrop.protocol.command_feature_disabled": {
    category: "authorization",
    message: "The v2 command executor is disabled by its feature gate.",
    retryable: false,
  },
  "seedrop.protocol.command_unauthorized": {
    category: "authorization",
    message: "The principal is not authorized to execute this command for the Project.",
    retryable: false,
  },
  "seedrop.protocol.command_idempotency_conflict": {
    category: "conflict",
    message: "The scoped idempotency key is already bound to different command input.",
    retryable: false,
  },
  "seedrop.protocol.command_definition_not_found": {
    category: "not_found",
    message: "No kernel command definition is registered for this name and version.",
    retryable: false,
  },
  "seedrop.protocol.command_recovery_required": {
    category: "conflict",
    message: "The command committed authoritative state but still requires governed recovery.",
    retryable: true,
  },
  "seedrop.protocol.outbox_effect_invalid": {
    category: "input",
    message: "The outbox effect declaration is malformed or internally inconsistent.",
    retryable: false,
  },
  "seedrop.protocol.outbox_delivery_invalid": {
    category: "integrity",
    message: "The outbox delivery Receipt is malformed or contradicts its outcome.",
    retryable: false,
  },
  "seedrop.protocol.command_commit_receipt_invalid": {
    category: "integrity",
    message: "The committed-command Receipt is malformed or contradicts execution state.",
    retryable: false,
  },
  "seedrop.protocol.project_event_invalid": {
    category: "input",
    message: "The project Event envelope is malformed or incomplete.",
    retryable: false,
  },
  "seedrop.protocol.project_transaction_invalid": {
    category: "integrity",
    message: "The project transaction is malformed, incomplete, or internally inconsistent.",
    retryable: false,
  },
  "seedrop.protocol.project_transaction_digest_mismatch": {
    category: "integrity",
    message: "The project transaction bytes do not match their content address.",
    retryable: false,
  },
  "seedrop.protocol.project_transaction_conflict": {
    category: "conflict",
    message: "The project transaction set contains a fork, duplicate identity, or version-chain conflict.",
    retryable: false,
  },
  "seedrop.protocol.project_projection_inconsistent": {
    category: "integrity",
    message: "The project projection does not reconcile with its canonical transaction sources.",
    retryable: false,
  },
  "seedrop.protocol.work_record_invalid": {
    category: "integrity",
    message: "The native work record or Event payload is malformed or internally inconsistent.",
    retryable: false,
  },
  "seedrop.protocol.work_state_conflict": {
    category: "conflict",
    message: "The native work command conflicts with current Intent, Episode, Claim, Receipt, or Lease state.",
    retryable: false,
  },
  "seedrop.protocol.lease_conflict": {
    category: "conflict",
    message: "The requested target already has an active Lease or the Lease is no longer mutable.",
    retryable: false,
  },
  "seedrop.protocol.lifecycle_state_unknown": {
    category: "input",
    message: "The lifecycle name or state is not registered by the protocol.",
    retryable: false,
  },
  "seedrop.protocol.lifecycle_transition_invalid": {
    category: "conflict",
    message: "The lifecycle transition is not permitted by the protocol state model.",
    retryable: false,
  },
  "seedrop.protocol.trust_state_invalid": {
    category: "input",
    message: "The orthogonal trust state is malformed or contains an unknown axis value.",
    retryable: false,
  },
  "seedrop.protocol.repair_receipt_invalid": {
    category: "integrity",
    message: "The repair Receipt is malformed, incomplete, or contradicts its outcome.",
    retryable: false,
  },
  "seedrop.protocol.repair_journal_invalid": {
    category: "integrity",
    message: "The append-only repair Receipt journal has a sequence or hash-chain violation.",
    retryable: false,
  },
  "seedrop.protocol.operational_metrics_invalid": {
    category: "input",
    message: "The operational metrics input is malformed or incomplete.",
    retryable: false,
  },
  "seedrop.protocol.operational_metrics_inconsistent": {
    category: "integrity",
    message: "The operational metrics summary disagrees with its canonical spans.",
    retryable: false,
  },
  "seedrop.protocol.explanation_trace_invalid": {
    category: "integrity",
    message: "The field explanation is missing evidence, policy, projection, or typed unknown state.",
    retryable: false,
  },
  "seedrop.protocol.explanation_trace_inconsistent": {
    category: "integrity",
    message: "The field explanation summary disagrees with its canonical evidence trace.",
    retryable: false,
  },
  "seedrop.protocol.budget_invalid": {
    category: "input",
    message: "The bounded-output request or candidate accounting is malformed.",
    retryable: false,
  },
  "seedrop.protocol.budget_insufficient": {
    category: "resource",
    message: "The requested byte budget cannot contain the mandatory truthful envelope.",
    retryable: false,
  },
  "seedrop.protocol.bounded_scan_exceeded": {
    category: "resource",
    message: "The bounded path scanned more candidates than its declared limit permits.",
    retryable: false,
  },
  "seedrop.protocol.telemetry_consent_invalid": {
    category: "integrity",
    message: "The telemetry consent Receipt is malformed or internally inconsistent.",
    retryable: false,
  },
  "seedrop.protocol.telemetry_export_denied": {
    category: "authorization",
    message: "Telemetry export is denied because explicit matching consent is absent or inactive.",
    retryable: false,
  },
  "seedrop.protocol.telemetry_secret_detected": {
    category: "authorization",
    message: "Telemetry export is denied because the payload contains a secret-pattern finding.",
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
