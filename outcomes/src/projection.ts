import {
  assertProjectTransaction, canonicalJsonBytes, canonicalJsonDigest, projectTransactionDigest,
} from "@seedrop/protocol";
import type { CanonicalId, JsonValue, ProjectEventEnvelope, ProjectTransaction, ProjectTransactionDigest } from "@seedrop/protocol";
import { DELIVERY_STATES, EVIDENCE_STATES, OUTCOME_PROJECTION_VERSION } from "./types.js";
import type { DeliveryState, EvidenceState, OutcomeObservationReference, OutcomeProjection, SubjectOutcomeProjection } from "./types.js";

const VALIDATION = "seedrop.outcome.validation_observed";
const DELIVERY = "seedrop.outcome.delivery_observed";

export function compileOutcomeProjection(input: {
  transactions: readonly ProjectTransaction[];
  current_input_digests?: Readonly<Record<string, ProjectTransactionDigest>>;
}): OutcomeProjection {
  const transactions = canonicalTransactions(input.transactions);
  const bySubject = new Map<string, MutableSubject>();
  let observations = 0;
  let ignored = 0;
  for (const transaction of transactions) {
    const transactionDigest = projectTransactionDigest(transaction);
    for (const event of transaction.events) {
      const subject = subjectFor(event, bySubject);
      if (event.event_type === VALIDATION) {
        const payload = object(event.payload);
        const status = validationState(payload.status);
        const reference = observation(event, transactionDigest, payload);
        if (newer(reference, subject.validation?.reference)) subject.validation = { state: status, reference };
        observations += 1;
      } else if (event.event_type === DELIVERY) {
        const payload = object(event.payload);
        const state = deliveryState(payload.outcome);
        const reference = observation(event, transactionDigest, payload);
        if (newer(reference, subject.delivery?.reference)) subject.delivery = { state, reference };
        observations += 1;
      } else if (event.event_type === "seedrop.episode.transitioned") {
        const payload = object(event.payload);
        if (typeof payload.to === "string") subject.reported = payload.to;
        ignored += 1;
      } else if (event.event_type.startsWith("seedrop.migration.record_")) {
        const payload = object(event.payload);
        const source = object(payload.source_payload ?? {});
        if (payload.source_family === "run" && typeof source.status === "string") subject.reported = legacyLifecycle(source.status);
        ignored += 1;
      } else ignored += 1;
    }
  }
  const subjects = [...bySubject.values()].map((subject) => finalize(subject, input.current_input_digests?.[subject.id]))
    .sort((left, right) => left.subject_id.localeCompare(right.subject_id));
  return freeze({
    projection_version: OUTCOME_PROJECTION_VERSION,
    source_digest: canonicalJsonDigest(transactions.map(projectTransactionDigest)) as ProjectTransactionDigest,
    subjects,
    observation_count: observations,
    ignored_event_count: ignored,
  });
}

export function outcomeProjectionBytes(projection: OutcomeProjection): Uint8Array { return canonicalJsonBytes(projection); }
export function outcomeProjectionDigest(projection: OutcomeProjection): ProjectTransactionDigest {
  return canonicalJsonDigest(projection) as ProjectTransactionDigest;
}

interface MutableSubject {
  id: CanonicalId;
  reported: string | null;
  validation?: { state: EvidenceState; reference: OutcomeObservationReference };
  delivery?: { state: DeliveryState; reference: OutcomeObservationReference };
}

function finalize(subject: MutableSubject, current?: ProjectTransactionDigest): SubjectOutcomeProjection {
  let evidence = subject.validation?.state ?? "unverified";
  if (current && subject.validation && subject.validation.reference.input_digest !== current) evidence = "stale";
  const delivery = subject.delivery?.state ?? "unobserved";
  const contradictions = [];
  if (subject.reported === "reported_complete" && evidence === "failed") contradictions.push("reported_complete_with_failed_validation");
  if (subject.reported === "reported_complete" && ["reverted", "superseded", "absent"].includes(delivery)) contradictions.push(`reported_complete_but_${delivery}`);
  return freeze({ subject_id: subject.id, reported_lifecycle: subject.reported, evidence, delivery,
    validation_observation: subject.validation?.reference ?? null,
    delivery_observation: subject.delivery?.reference ?? null,
    contradictions: contradictions.sort() });
}

function canonicalTransactions(input: readonly ProjectTransaction[]): ProjectTransaction[] {
  const transactions = [...input];
  for (const item of transactions) assertProjectTransaction(item);
  const digests = transactions.map(projectTransactionDigest);
  if (new Set(digests).size !== digests.length) throw new Error("Duplicate outcome source transaction.");
  return transactions.sort((a, b) => projectTransactionDigest(a).localeCompare(projectTransactionDigest(b)));
}
function subjectFor(event: ProjectEventEnvelope, map: Map<string, MutableSubject>): MutableSubject {
  const payload = object(event.payload);
  const id = typeof payload.subject_episode_id === "string" ? payload.subject_episode_id as CanonicalId : event.subject_id;
  const found = map.get(id) ?? { id, reported: null };
  map.set(id, found); return found;
}
function observation(event: ProjectEventEnvelope, transaction: ProjectTransactionDigest, payload: Record<string, JsonValue>): OutcomeObservationReference {
  if (typeof payload.observed_at !== "string" || typeof payload.input_digest !== "string" || typeof payload.source_ref !== "string") {
    throw new Error(`Malformed outcome observation ${event.event_id}.`);
  }
  return freeze({ event_id: event.event_id, transaction_digest: transaction, observed_at: payload.observed_at,
    input_digest: payload.input_digest as ProjectTransactionDigest,
    build_identity: typeof payload.build_identity === "string" ? payload.build_identity : null, source_ref: payload.source_ref });
}
function newer(candidate: OutcomeObservationReference, current?: OutcomeObservationReference): boolean {
  return !current || candidate.observed_at > current.observed_at
    || (candidate.observed_at === current.observed_at && candidate.event_id > current.event_id);
}
function validationState(value: JsonValue | undefined): EvidenceState {
  const mapped = value === "passed" ? "passed" : value === "failed" ? "failed" : value === "unavailable" ? "unavailable" : "unverified";
  if (!(EVIDENCE_STATES as readonly string[]).includes(mapped)) throw new Error("Unknown validation state."); return mapped;
}
function deliveryState(value: JsonValue | undefined): DeliveryState {
  const mapped = value === "survived" ? "committed" : value;
  if (typeof mapped !== "string" || !(DELIVERY_STATES as readonly string[]).includes(mapped)) throw new Error(`Unknown delivery state: ${String(value)}`);
  return mapped as DeliveryState;
}
function legacyLifecycle(status: string): string { return status === "completed" ? "reported_complete" : status; }
function object(value: JsonValue): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) freeze(item); } return value; }
