import { COMMAND_PHASES, COMMAND_TRANSITIONS, TERMINAL_COMMAND_PHASES } from "./commands.js";
import { ERROR_REGISTRY } from "./errors.js";
import { COMMAND_EXECUTION_EVENT_TYPES } from "./execution.js";
import { CANONICAL_ID_KINDS } from "./ids.js";
import { SUBSTRATE_STATES } from "./health.js";
import { CURRENT_VERSIONS, VERSION_AXES } from "./versions.js";
import { NATIVE_WORK_COMMANDS, WORK_EVENT_TYPES } from "./work.js";
import { EPISODE_LIFECYCLE, INTENT_LIFECYCLE, LEASE_LIFECYCLE } from "./lifecycles.js";

export { EPISODE_LIFECYCLE, INTENT_LIFECYCLE, LEASE_LIFECYCLE } from "./lifecycles.js";

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
  surface("OutboxEffect", "src/execution.ts", "durable_record", "Event", "effect_version", "OUTBOX_EFFECT_VERSION", "buildOutboxEffect", "assertOutboxEffect"),
  surface("OutboxDeliveryReceipt", "src/execution.ts", "durable_record", "Receipt", "delivery_version", "OUTBOX_DELIVERY_VERSION", "buildOutboxDeliveryReceipt", "assertOutboxDeliveryReceipt"),
  surface("CommandCommitReceipt", "src/execution.ts", "durable_record", "Receipt", "receipt_version", "COMMAND_COMMIT_RECEIPT_VERSION", "buildCommandCommitReceipt", "assertCommandCommitReceipt"),
  surface("ProjectEventEnvelope", "src/project-transactions.ts", "durable_record", "Event", "event_version", "PROJECT_EVENT_VERSION", "buildProjectEvent", "assertProjectEvent"),
  surface("ProjectTransaction", "src/project-transactions.ts", "durable_record", "Project", "transaction_version", "PROJECT_TRANSACTION_VERSION", "buildProjectTransaction", "assertProjectTransaction"),
  surface("IntentRecord", "src/work.ts", "durable_record", "Intent", "intent_version", "WORK_RECORD_VERSION", "buildIntentRecord", "assertIntentRecord"),
  surface("EpisodeRecord", "src/work.ts", "durable_record", "Episode", "episode_version", "WORK_RECORD_VERSION", "buildEpisodeRecord", "assertEpisodeRecord"),
  surface("ClaimRecord", "src/work.ts", "durable_record", "Claim", "claim_version", "WORK_RECORD_VERSION", "buildClaimRecord", "assertClaimRecord"),
  surface("WorkReceipt", "src/work.ts", "durable_record", "Receipt", "receipt_version", "WORK_RECEIPT_VERSION", "buildWorkReceipt", "assertWorkReceipt"),
  surface("LeaseRecord", "src/work.ts", "durable_record", "Lease", "lease_version", "WORK_RECORD_VERSION", "buildLeaseRecord", "assertLeaseRecord"),
  surface("WorkLifecycleTransition", "src/work.ts", "durable_record", "Event", "transition_version", "WORK_TRANSITION_VERSION", "buildWorkLifecycleTransition", "assertWorkLifecycleTransition"),
  surface("WorkCorrection", "src/work.ts", "durable_record", "Event", "correction_version", "WORK_CORRECTION_VERSION", "buildWorkCorrection", "assertWorkCorrection"),
  surface("SweepCandidateEvent", "src/commands.ts", "proposal", "Event", "sweep_candidate_version", "SWEEP_CANDIDATE_VERSION", "findCommandSweepCandidates", null),
  surface("RepairReceipt", "src/repairs.ts", "durable_record", "Receipt", "receipt_version", "REPAIR_RECEIPT_VERSION", "buildRepairReceipt", "assertRepairReceipt"),
  surface("OperationalMetricsSnapshot", "src/observability.ts", "projection", "Situation", "metrics_version", "OPERATIONAL_METRICS_VERSION", "buildOperationalMetricsSnapshot", "assertOperationalMetricsSnapshot"),
  surface("FieldExplanationTrace", "src/observability.ts", "projection", "Claim", "explanation_version", "EXPLANATION_TRACE_VERSION", "buildFieldExplanation", "assertFieldExplanation"),
  surface("BoundedOutputEnvelope", "src/observability.ts", "projection", "Situation", "budget_version", "BOUNDED_OUTPUT_VERSION", "compileBoundedOutput", "assertBoundedOutput"),
  surface("TelemetryConsentReceipt", "src/observability.ts", "durable_record", "Receipt", "consent_version", "TELEMETRY_CONSENT_VERSION", "buildTelemetryConsentReceipt", "assertTelemetryConsentReceipt"),
  surface("TelemetryExportAuthorization", "src/observability.ts", "authorization", "Receipt", "export_version", "TELEMETRY_EXPORT_VERSION", "authorizeTelemetryExport", null),
] as const);

export const PROTOCOL_GAPS = Object.freeze([
  gap("situation_envelope", "Situation", "projection", "Health and bounded projections exist, but the complete Situation envelope is not implemented."),
  gap("event_type_registry", "Event", "kernel", "Execution and native work Events are registered; migration and Situation Event families remain open."),
  gap("command_name_registry", null, "kernel", "Native work commands are registered; migration and adapter command families remain open."),
] as const);

export const PUBLIC_EVENT_TYPES = Object.freeze([
  ...Object.values(COMMAND_EXECUTION_EVENT_TYPES).map((name) => Object.freeze({
    name,
    status: "implemented" as const,
    surface: name === COMMAND_EXECUTION_EVENT_TYPES.outbox_declared ? "OutboxEffect" : "ProjectEventEnvelope",
  })),
  ...Object.values(WORK_EVENT_TYPES).map((name) => Object.freeze({
    name,
    status: "implemented" as const,
    surface: "ProjectEventEnvelope",
  })),
  Object.freeze({
    name: "command.sweep_candidate",
    status: "proposal_only",
    surface: "SweepCandidateEvent",
  }),
] as const);

export const PUBLIC_NOUNS = Object.freeze([
  noun("Principal", "machine", "implemented", ["PrincipalRecord", "PrincipalRegistry"], []),
  noun("Project", "mixed", "implemented", ["ProjectRecord", "ProjectRegistry", "ProjectTransaction"], []),
  noun("Intent", "project", "implemented", ["IntentRecord"], []),
  noun("Episode", "project", "implemented", ["EpisodeRecord"], []),
  noun("Claim", "mixed", "implemented", ["ClaimRecord", "FieldExplanationTrace"], []),
  noun("Receipt", "external", "implemented", ["WorkReceipt", "OutboxDeliveryReceipt", "CommandCommitReceipt", "RepairReceipt", "TelemetryConsentReceipt", "TelemetryExportAuthorization"], []),
  noun("Lease", "machine", "implemented", ["LeaseRecord"], []),
  noun("Event", "project", "partial", ["CommandAuditTrail", "OutboxEffect", "ProjectEventEnvelope", "SweepCandidateEvent"], ["event_type_registry"]),
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
  commands: Object.freeze({ closure: "open", registered: Object.freeze(Object.values(NATIVE_WORK_COMMANDS)) }),
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
