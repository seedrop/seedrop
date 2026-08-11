import {
  WORK_EVENT_TYPES,
  WORK_RECEIPT_KINDS,
  assertWorkDomainEvent,
  canonicalJson,
  parseCanonicalId,
  protocolError,
} from "@seedrop/protocol";
import type {
  ClaimRecord,
  EpisodeRecord,
  IntentRecord,
  LeaseRecord,
  LeaseTransition,
  ProjectEventEnvelope,
  WorkCorrection,
  WorkLifecycleTransition,
  WorkReceipt,
} from "@seedrop/protocol";
import { reduceProjectTransactions } from "./projection.js";
import { WORK_PROJECTION_VERSION } from "./types.js";
import type {
  EpisodeProjectionRecord,
  IntentProjectionRecord,
  LeaseProjectionRecord,
  ProjectLogScan,
  WorkProjection,
  WorkReceiptProjectionRecord,
  WorkReceiptQuery,
} from "./types.js";

export function reduceWorkProjection(scan: ProjectLogScan): WorkProjection {
  const project = reduceProjectTransactions(scan);
  if (!project.lag.complete) {
    throw protocolError("seedrop.protocol.project_projection_inconsistent", {
      reason: "work_projection_requires_complete_project_log",
      quarantine_count: project.quarantined.length,
    });
  }
  const transactions = new Map(scan.transactions.map((entry) => [entry.digest, entry]));
  const intents = new Map<string, MutableIntent>();
  const episodes = new Map<string, MutableEpisode>();
  const claims = new Map<string, ClaimRecord>();
  const receipts = new Map<string, WorkReceiptProjectionRecord>();
  const leases = new Map<string, MutableLease>();

  for (const applied of project.applied) {
    const stored = transactions.get(applied.transaction_digest);
    if (!stored) inconsistent("applied_transaction_missing", { transaction_digest: applied.transaction_digest });
    for (const event of stored.transaction.events) {
      const record = assertWorkDomainEvent(event);
      if (record === null) continue;
      if ("project_id" in record && record.project_id !== scan.project_id) {
        inconsistent("record_project_mismatch", { event_id: event.event_id });
      }
      if (event.event_type === WORK_EVENT_TYPES.intent_created) {
        applyIntentCreated(intents, record as IntentRecord, event);
      } else if (event.event_type === WORK_EVENT_TYPES.intent_transitioned) {
        applyIntentTransition(intents, record as WorkLifecycleTransition, event);
      } else if (event.event_type === WORK_EVENT_TYPES.intent_corrected) {
        applyIntentCorrection(intents, record as WorkCorrection, event);
      } else if (event.event_type === WORK_EVENT_TYPES.episode_started) {
        applyEpisodeStarted(intents, episodes, record as EpisodeRecord, event);
      } else if (event.event_type === WORK_EVENT_TYPES.episode_transitioned) {
        applyEpisodeTransition(episodes, record as WorkLifecycleTransition, event);
      } else if (event.event_type === WORK_EVENT_TYPES.episode_corrected) {
        applyEpisodeCorrection(episodes, record as WorkCorrection, event);
      } else if (event.event_type === WORK_EVENT_TYPES.claim_recorded) {
        applyClaim(intents, episodes, claims, record as ClaimRecord);
      } else if (event.event_type === WORK_EVENT_TYPES.receipt_recorded) {
        applyReceipt(intents, episodes, leases, receipts, record as WorkReceipt, event, stored.transaction.command_id, stored.transaction.principal_id, stored.digest);
      } else if (event.event_type === WORK_EVENT_TYPES.lease_acquired) {
        applyLeaseAcquired(intents, episodes, leases, record as LeaseRecord, event);
      } else {
        applyLeaseTransition(leases, record as LeaseTransition, event);
      }
    }
  }

  return deepFreeze({
    projection_version: WORK_PROJECTION_VERSION,
    project_id: scan.project_id,
    source_high_watermark: project.source_high_watermark,
    intents: [...intents.values()].sort(byRecordId("intent_id")).map(freezeIntent),
    episodes: [...episodes.values()].sort(byRecordId("episode_id")).map(freezeEpisode),
    claims: [...claims.values()].sort((left, right) => left.claim_id.localeCompare(right.claim_id)),
    receipts: [...receipts.values()].sort((left, right) => left.receipt.receipt_id.localeCompare(right.receipt.receipt_id)),
    leases: [...leases.values()].sort(byRecordId("lease_id")).map(freezeLease),
  });
}

export function queryWorkReceipts(
  projection: WorkProjection,
  query: WorkReceiptQuery = {},
): readonly WorkReceiptProjectionRecord[] {
  canonicalJson(query);
  const allowed = ["receipt_id", "receipt_kind", "command_id", "principal_id", "subject_id"];
  const unknown = Object.keys(query).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) inconsistent("receipt_query_unknown_fields", { unknown: unknown.sort().join(",") });
  if (query.receipt_id !== undefined) parseCanonicalId(query.receipt_id, "receipt");
  if (query.command_id !== undefined) parseCanonicalId(query.command_id, "command");
  if (query.principal_id !== undefined) parseCanonicalId(query.principal_id, "principal");
  if (query.subject_id !== undefined) parseCanonicalId(query.subject_id);
  if (query.receipt_kind !== undefined && !(WORK_RECEIPT_KINDS as readonly unknown[]).includes(query.receipt_kind)) {
    inconsistent("receipt_query_kind_unknown", { receipt_kind: query.receipt_kind });
  }
  return Object.freeze(projection.receipts.filter((entry) => (
    (query.receipt_id === undefined || entry.receipt.receipt_id === query.receipt_id)
    && (query.receipt_kind === undefined || entry.receipt.receipt_kind === query.receipt_kind)
    && (query.command_id === undefined || entry.receipt.command_id === query.command_id)
    && (query.principal_id === undefined || entry.receipt.principal_id === query.principal_id)
    && (query.subject_id === undefined || entry.receipt.subject_id === query.subject_id)
  )));
}

export function activeLeaseForTarget(projection: WorkProjection, target: string): LeaseProjectionRecord | null {
  return projection.leases.find((lease) => lease.record.target === target && lease.state === "active") ?? null;
}

interface MutableIntent extends Omit<IntentProjectionRecord, "correction_event_ids"> {
  correction_event_ids: CanonicalEventId[];
}
interface MutableEpisode extends Omit<EpisodeProjectionRecord, "correction_event_ids"> {
  correction_event_ids: CanonicalEventId[];
}
type MutableLease = LeaseProjectionRecord;
type CanonicalEventId = ProjectEventEnvelope["event_id"];

function applyIntentCreated(intents: Map<string, MutableIntent>, record: IntentRecord, event: ProjectEventEnvelope): void {
  if (intents.has(record.intent_id)) inconsistent("duplicate_intent", { intent_id: record.intent_id });
  intents.set(record.intent_id, { record, state: "queued", state_event_id: event.event_id, correction_event_ids: [] });
}

function applyIntentTransition(intents: Map<string, MutableIntent>, transition: WorkLifecycleTransition, event: ProjectEventEnvelope): void {
  const current = required(intents, transition.subject_id, "intent_not_found");
  if (current.state !== transition.from) inconsistent("intent_state_mismatch", { expected: transition.from, observed: current.state });
  current.state = transition.to as IntentProjectionRecord["state"];
  current.state_event_id = event.event_id;
}

function applyIntentCorrection(intents: Map<string, MutableIntent>, correction: WorkCorrection, event: ProjectEventEnvelope): void {
  const current = required(intents, correction.subject_id, "intent_not_found");
  if (current.state !== correction.from || current.state_event_id !== correction.corrects_event_id) {
    inconsistent("intent_correction_target_mismatch", { expected_event_id: current.state_event_id });
  }
  current.state = "active";
  current.state_event_id = event.event_id;
  current.correction_event_ids.push(event.event_id);
}

function applyEpisodeStarted(intents: Map<string, MutableIntent>, episodes: Map<string, MutableEpisode>, record: EpisodeRecord, event: ProjectEventEnvelope): void {
  required(intents, record.intent_id, "episode_intent_not_found");
  if (episodes.has(record.episode_id)) inconsistent("duplicate_episode", { episode_id: record.episode_id });
  episodes.set(record.episode_id, { record, state: "active", state_event_id: event.event_id, correction_event_ids: [] });
}

function applyEpisodeTransition(episodes: Map<string, MutableEpisode>, transition: WorkLifecycleTransition, event: ProjectEventEnvelope): void {
  const current = required(episodes, transition.subject_id, "episode_not_found");
  if (current.state !== transition.from) inconsistent("episode_state_mismatch", { expected: transition.from, observed: current.state });
  current.state = transition.to as EpisodeProjectionRecord["state"];
  current.state_event_id = event.event_id;
}

function applyEpisodeCorrection(episodes: Map<string, MutableEpisode>, correction: WorkCorrection, event: ProjectEventEnvelope): void {
  const current = required(episodes, correction.subject_id, "episode_not_found");
  if (current.state !== correction.from || current.state_event_id !== correction.corrects_event_id) {
    inconsistent("episode_correction_target_mismatch", { expected_event_id: current.state_event_id });
  }
  current.state = "active";
  current.state_event_id = event.event_id;
  current.correction_event_ids.push(event.event_id);
}

function applyClaim(intents: Map<string, MutableIntent>, episodes: Map<string, MutableEpisode>, claims: Map<string, ClaimRecord>, record: ClaimRecord): void {
  required(intents, record.intent_id, "claim_intent_not_found");
  if (record.episode_id !== null) required(episodes, record.episode_id, "claim_episode_not_found");
  if (record.corrects_claim_id !== null) required(claims, record.corrects_claim_id, "corrected_claim_not_found");
  if (claims.has(record.claim_id)) inconsistent("duplicate_claim", { claim_id: record.claim_id });
  claims.set(record.claim_id, record);
}

function applyReceipt(
  intents: Map<string, MutableIntent>,
  episodes: Map<string, MutableEpisode>,
  leases: Map<string, MutableLease>,
  receipts: Map<string, WorkReceiptProjectionRecord>,
  receipt: WorkReceipt,
  event: ProjectEventEnvelope,
  commandId: WorkReceipt["command_id"],
  principalId: WorkReceipt["principal_id"],
  transactionDigest: WorkReceiptProjectionRecord["transaction_digest"],
): void {
  if (receipt.command_id !== commandId || receipt.principal_id !== principalId) inconsistent("receipt_command_identity_mismatch");
  if (receipt.receipt_kind === "episode_started" || receipt.receipt_kind === "episode_finished") required(episodes, receipt.subject_id, "receipt_episode_not_found");
  else if (receipt.receipt_kind === "lease_expired") required(leases, receipt.subject_id, "receipt_lease_not_found");
  else if (!intents.has(receipt.subject_id) && !episodes.has(receipt.subject_id)) inconsistent("correction_receipt_subject_not_found");
  if (receipts.has(receipt.receipt_id)) inconsistent("duplicate_work_receipt", { receipt_id: receipt.receipt_id });
  receipts.set(receipt.receipt_id, deepFreeze({ event_id: event.event_id, transaction_digest: transactionDigest, receipt }));
}

function applyLeaseAcquired(intents: Map<string, MutableIntent>, episodes: Map<string, MutableEpisode>, leases: Map<string, MutableLease>, record: LeaseRecord, event: ProjectEventEnvelope): void {
  required(intents, record.intent_id, "lease_intent_not_found");
  required(episodes, record.episode_id, "lease_episode_not_found");
  if (leases.has(record.lease_id)) inconsistent("duplicate_lease", { lease_id: record.lease_id });
  if ([...leases.values()].some((lease) => lease.record.target === record.target && lease.state === "active")) {
    throw protocolError("seedrop.protocol.lease_conflict", { reason: "target_already_leased", target: record.target });
  }
  leases.set(record.lease_id, { record, state: "active", state_event_id: event.event_id });
}

function applyLeaseTransition(leases: Map<string, MutableLease>, transition: LeaseTransition, event: ProjectEventEnvelope): void {
  const current = required(leases, transition.lease_id, "lease_not_found");
  if (current.state !== "active") throw protocolError("seedrop.protocol.lease_conflict", { reason: "lease_not_active", lease_id: transition.lease_id });
  if (transition.to === "expired" && transition.recorded_at < current.record.expires_at) {
    throw protocolError("seedrop.protocol.lease_conflict", { reason: "lease_not_expired", expires_at: current.record.expires_at });
  }
  current.state = transition.to;
  current.state_event_id = event.event_id;
}

function required<T>(map: Map<string, T>, id: string, reason: string): T {
  const value = map.get(id);
  if (!value) inconsistent(reason, { id });
  return value;
}

function freezeIntent(value: MutableIntent): IntentProjectionRecord {
  return deepFreeze({ ...value, correction_event_ids: [...value.correction_event_ids] });
}
function freezeEpisode(value: MutableEpisode): EpisodeProjectionRecord {
  return deepFreeze({ ...value, correction_event_ids: [...value.correction_event_ids] });
}
function freezeLease(value: MutableLease): LeaseProjectionRecord {
  return deepFreeze({ ...value });
}

function byRecordId<K extends "intent_id" | "episode_id" | "lease_id">(key: K) {
  return (left: { record: Record<K, string> }, right: { record: Record<K, string> }) => left.record[key].localeCompare(right.record[key]);
}

function inconsistent(reason: string, details: Record<string, string> = {}): never {
  throw protocolError("seedrop.protocol.work_state_conflict", { reason, ...details });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
