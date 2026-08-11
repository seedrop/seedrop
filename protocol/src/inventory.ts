import { COMMAND_PHASES, COMMAND_TRANSITIONS, TERMINAL_COMMAND_PHASES } from "./commands.js";
import { ERROR_REGISTRY } from "./errors.js";
import { CANONICAL_ID_KINDS } from "./ids.js";
import { SUBSTRATE_STATES } from "./health.js";
import { CURRENT_VERSIONS, VERSION_AXES } from "./versions.js";

export const PROTOCOL_INVENTORY_VERSION = "1.0.0" as const;

export type InventoryContractStatus = "implemented" | "partial" | "declared";

export interface ProtocolNoun {
  name: "Principal" | "Project" | "Intent" | "Episode" | "Claim" | "Receipt" | "Lease" | "Event" | "Situation";
  authority: "machine" | "project" | "external" | "projection" | "mixed";
  contract_status: InventoryContractStatus;
  implemented_surfaces: readonly string[];
  gap_ids: readonly string[];
}

export interface ProtocolSurface {
  name: string;
  source_file: string;
  role: "wire_envelope" | "durable_record" | "registry" | "projection" | "proposal" | "authorization";
  noun: ProtocolNoun["name"] | null;
  version_field: string | null;
  version_constant: string | null;
  builder: string | null;
  validator: string | null;
}

export interface ProtocolGap {
  id: string;
  noun: ProtocolNoun["name"] | null;
  boundary: string;
  reason: string;
}

function freezeTransitions<const T extends Readonly<Record<string, readonly string[]>>>(
  transitions: T,
): T {
  for (const values of Object.values(transitions)) Object.freeze(values);
  return Object.freeze(transitions);
}

export const INTENT_LIFECYCLE = Object.freeze({
  states: Object.freeze(["queued", "active", "paused", "blocked", "reported_complete", "abandoned"] as const),
  initial: "queued",
  terminal: Object.freeze(["reported_complete", "abandoned"] as const),
  transitions: freezeTransitions({
    queued: ["active", "paused", "blocked", "abandoned"],
    active: ["paused", "blocked", "reported_complete", "abandoned"],
    paused: ["active", "blocked", "abandoned"],
    blocked: ["active", "paused", "abandoned"],
    reported_complete: [],
    abandoned: [],
  }),
});

export const EPISODE_LIFECYCLE = Object.freeze({
  states: Object.freeze(["active", "paused", "blocked", "reported_complete", "failed", "abandoned"] as const),
  initial: "active",
  terminal: Object.freeze(["reported_complete", "failed", "abandoned"] as const),
  transitions: freezeTransitions({
    active: ["paused", "blocked", "reported_complete", "failed", "abandoned"],
    paused: ["active", "blocked", "failed", "abandoned"],
    blocked: ["active", "paused", "failed", "abandoned"],
    reported_complete: [],
    failed: [],
    abandoned: [],
  }),
});

export const LEASE_LIFECYCLE = Object.freeze({
  states: Object.freeze(["active", "released", "expired", "revoked"] as const),
  initial: "active",
  terminal: Object.freeze(["released", "expired", "revoked"] as const),
  transitions: freezeTransitions({
    active: ["released", "expired", "revoked"],
    released: [],
    expired: [],
    revoked: [],
  }),
});

export const TRUST_AXES = Object.freeze({
  evidence: Object.freeze(["unverified", "passed", "failed", "stale", "unavailable"] as const),
  delivery: Object.freeze([
    "not_applicable", "unobserved", "uncommitted", "committed", "review_open",
    "merged", "reverted", "superseded", "absent",
  ] as const),
  substrate: SUBSTRATE_STATES,
  readiness: Object.freeze(["not_ready", "resumable_with_risk", "ready"] as const),
  confidence: Object.freeze(["observed", "inferred_high", "inferred_low", "unknown"] as const),
});

export const PROTOCOL_SURFACES = Object.freeze([
  surface("VersionEnvelope", "src/versions.ts", "wire_envelope", null, null, null, null, "parseVersionEnvelope"),
  surface("ProtocolErrorEnvelope", "src/errors.ts", "wire_envelope", null, null, null, "protocolErrorEnvelope", null),
  surface("PrincipalRecord", "src/identity.ts", "durable_record", "Principal", null, null, null, null),
  surface("PrincipalRegistry", "src/identity.ts", "registry", "Principal", "registry_version", "IDENTITY_REGISTRY_VERSION", null, "assertPrincipalRegistry"),
  surface("ProjectRecord", "src/identity.ts", "durable_record", "Project", null, null, null, null),
  surface("ProjectRegistry", "src/identity.ts", "registry", "Project", "registry_version", "IDENTITY_REGISTRY_VERSION", null, "assertProjectRegistry"),
  surface("HealthEnvelope", "src/health.ts", "projection", "Situation", "health_version", "HEALTH_ENVELOPE_VERSION", "buildHealthEnvelope", "assertHealthEnvelope"),
  surface("CommandAuditTrail", "src/commands.ts", "durable_record", "Event", "audit_version", "COMMAND_AUDIT_VERSION", "buildCommandAuditTrail", "assertCommandAuditTrail"),
  surface("SweepCandidateEvent", "src/commands.ts", "proposal", "Event", "sweep_candidate_version", "SWEEP_CANDIDATE_VERSION", "findCommandSweepCandidates", null),
  surface("RepairReceipt", "src/repairs.ts", "durable_record", "Receipt", "receipt_version", "REPAIR_RECEIPT_VERSION", "buildRepairReceipt", "assertRepairReceipt"),
  surface("OperationalMetricsSnapshot", "src/observability.ts", "projection", "Situation", "metrics_version", "OPERATIONAL_METRICS_VERSION", "buildOperationalMetricsSnapshot", "assertOperationalMetricsSnapshot"),
  surface("FieldExplanationTrace", "src/observability.ts", "projection", "Claim", "explanation_version", "EXPLANATION_TRACE_VERSION", "buildFieldExplanation", "assertFieldExplanation"),
  surface("BoundedOutputEnvelope", "src/observability.ts", "projection", "Situation", "budget_version", "BOUNDED_OUTPUT_VERSION", "compileBoundedOutput", "assertBoundedOutput"),
  surface("TelemetryConsentReceipt", "src/observability.ts", "durable_record", "Receipt", "consent_version", "TELEMETRY_CONSENT_VERSION", "buildTelemetryConsentReceipt", "assertTelemetryConsentReceipt"),
  surface("TelemetryExportAuthorization", "src/observability.ts", "authorization", "Receipt", "export_version", "TELEMETRY_EXPORT_VERSION", "authorizeTelemetryExport", null),
] as const);

export const PROTOCOL_GAPS = Object.freeze([
  gap("intent_record", "Intent", "kernel", "No canonical Intent Event or root record is implemented yet."),
  gap("episode_record", "Episode", "kernel", "No canonical Episode Event or root record is implemented yet."),
  gap("claim_record", "Claim", "kernel", "Explanation evidence exists, but the canonical Claim record is not implemented."),
  gap("receipt_record", "Receipt", "kernel", "Concrete repair and consent Receipts exist; the general Receipt contract is not implemented."),
  gap("lease_record", "Lease", "coordination", "The lifecycle is frozen, but no native v2 Lease record or command exists."),
  gap("event_envelope", "Event", "kernel", "Audit entries and proposals exist, but the canonical atomic Event envelope is not implemented."),
  gap("situation_envelope", "Situation", "projection", "Health and bounded projections exist, but the complete Situation envelope is not implemented."),
  gap("event_type_registry", "Event", "kernel", "Event names remain open until native kernel commands freeze the complete registry."),
  gap("command_name_registry", null, "kernel", "CommandAuditTrail accepts a non-empty command name; the native command registry is not frozen."),
] as const);

export const PUBLIC_EVENT_TYPES = Object.freeze([
  Object.freeze({
    name: "command.sweep_candidate",
    status: "proposal_only",
    surface: "SweepCandidateEvent",
  }),
] as const);

export const PUBLIC_NOUNS = Object.freeze([
  noun("Principal", "machine", "implemented", ["PrincipalRecord", "PrincipalRegistry"], []),
  noun("Project", "mixed", "implemented", ["ProjectRecord", "ProjectRegistry"], []),
  noun("Intent", "project", "declared", [], ["intent_record"]),
  noun("Episode", "project", "declared", [], ["episode_record"]),
  noun("Claim", "mixed", "partial", ["FieldExplanationTrace"], ["claim_record"]),
  noun("Receipt", "external", "partial", ["RepairReceipt", "TelemetryConsentReceipt", "TelemetryExportAuthorization"], ["receipt_record"]),
  noun("Lease", "machine", "declared", [], ["lease_record"]),
  noun("Event", "project", "partial", ["CommandAuditTrail", "SweepCandidateEvent"], ["event_envelope", "event_type_registry"]),
  noun("Situation", "projection", "partial", ["HealthEnvelope", "OperationalMetricsSnapshot", "BoundedOutputEnvelope"], ["situation_envelope"]),
] as const satisfies readonly ProtocolNoun[]);

export const PROTOCOL_INVENTORY_CORE = Object.freeze({
  inventory_version: PROTOCOL_INVENTORY_VERSION,
  ontology: PUBLIC_NOUNS,
  lifecycles: Object.freeze({
    intent: INTENT_LIFECYCLE,
    episode: EPISODE_LIFECYCLE,
    lease: LEASE_LIFECYCLE,
    command: Object.freeze({
      states: COMMAND_PHASES,
      initial: "accepted",
      terminal: TERMINAL_COMMAND_PHASES,
      transitions: COMMAND_TRANSITIONS,
    }),
  }),
  trust_axes: TRUST_AXES,
  canonical_id_kinds: CANONICAL_ID_KINDS,
  version_axes: VERSION_AXES,
  current_versions: CURRENT_VERSIONS,
  errors: ERROR_REGISTRY,
  events: Object.freeze({ closure: "open", registered: PUBLIC_EVENT_TYPES }),
  commands: Object.freeze({ closure: "open", registered: Object.freeze([] as readonly string[]) }),
  surfaces: PROTOCOL_SURFACES,
  gaps: PROTOCOL_GAPS,
});

function surface(
  name: string,
  source_file: string,
  role: ProtocolSurface["role"],
  nounName: ProtocolSurface["noun"],
  version_field: string | null,
  version_constant: string | null,
  builder: string | null,
  validator: string | null,
): Readonly<ProtocolSurface> {
  return Object.freeze({ name, source_file, role, noun: nounName, version_field, version_constant, builder, validator });
}

function noun(
  name: ProtocolNoun["name"],
  authority: ProtocolNoun["authority"],
  contract_status: InventoryContractStatus,
  implemented_surfaces: readonly string[],
  gap_ids: readonly string[],
): Readonly<ProtocolNoun> {
  return Object.freeze({
    name,
    authority,
    contract_status,
    implemented_surfaces: Object.freeze(implemented_surfaces),
    gap_ids: Object.freeze(gap_ids),
  });
}

function gap(id: string, nounName: ProtocolGap["noun"], boundary: string, reason: string): Readonly<ProtocolGap> {
  return Object.freeze({ id, noun: nounName, boundary, reason });
}
