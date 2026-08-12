import { assertProjectTransaction, canonicalJsonBytes, canonicalJsonDigest, projectTransactionDigest } from "@seedrop/protocol";
import type { CanonicalId, JsonValue, ProjectTransaction, ProjectTransactionDigest } from "@seedrop/protocol";
import { GRAVE_PROJECTION_VERSION } from "./types.js";
import type { GraveKind, GraveProjection, GraveProjectionRecord, OutcomeProjection } from "./types.js";

interface Candidate {
  subject_id: CanonicalId;
  kind: GraveKind;
  goal: string | null;
  cause: string;
  scope: Set<string>;
  evidence: Set<CanonicalId<"event">>;
  transactions: Set<ProjectTransactionDigest>;
  source_refs: Set<string>;
  corrections: Set<CanonicalId<"event">>;
  retry_status: "ready" | "blocked" | "unknown";
  retry_condition: string;
}

export function compileGraveProjection(input: {
  transactions: readonly ProjectTransaction[];
  outcomes?: OutcomeProjection;
}): GraveProjection {
  const transactions = canonicalTransactions(input.transactions);
  const candidates = new Map<string, Candidate>();
  const goals = new Map<string, string>();
  const corrections = new Map<string, Array<{ event_id: CanonicalId<"event">; digest: ProjectTransactionDigest; reason: string }>>();
  for (const transaction of transactions) {
    const digest = projectTransactionDigest(transaction);
    for (const event of transaction.events) {
      const payload = object(event.payload);
      if (event.event_type.startsWith("seedrop.migration.record_") && payload.source_family === "run") {
        const source = object(payload.source_payload ?? {});
        const disposition = typeof payload.disposition === "string" ? payload.disposition : "";
        const status = typeof source.status === "string" ? source.status : "";
        const kind = legacyKind(status, disposition);
        if (!kind) continue;
        const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics.map(object)
          .map((item) => typeof item.reason === "string" ? item.reason : null).filter((item): item is string => item !== null) : [];
        const cause = typeof source.cause === "string" ? source.cause
          : diagnostics.join("; ") || defaultCause(kind);
        const candidate = get(candidates, event.subject_id, kind, typeof source.goal === "string" ? source.goal : null, cause);
        addEvidence(candidate, event.event_id, digest, typeof payload.source_ref === "string" ? payload.source_ref : null);
        for (const path of strings(source.changed_paths)) candidate.scope.add(path);
      } else if (event.event_type === "seedrop.episode.transitioned") {
        const to = typeof payload.to === "string" ? payload.to : "";
        const kind = to === "failed" || to === "blocked" || to === "abandoned" ? to : null;
        if (!kind) continue;
        const candidate = get(candidates, event.subject_id, kind,
          null, typeof payload.reason === "string" ? payload.reason : defaultCause(kind));
        addEvidence(candidate, event.event_id, digest, null);
      } else if (event.event_type === "seedrop.episode.started") {
        if (typeof payload.goal === "string") goals.set(event.subject_id, payload.goal);
      } else if (event.event_type === "seedrop.episode.corrected") {
        corrections.set(event.subject_id, [...(corrections.get(event.subject_id) ?? []), {
          event_id: event.event_id, digest,
          reason: typeof payload.reason === "string" ? payload.reason : "Authorized correction returned the Episode to active.",
        }]);
      }
    }
  }

  for (const candidate of candidates.values()) {
    if (candidate.goal === null && goals.has(candidate.subject_id)) candidate.goal = goals.get(candidate.subject_id)!;
    for (const correction of corrections.get(candidate.subject_id) ?? []) {
      candidate.corrections.add(correction.event_id);
      candidate.retry_status = "ready";
      candidate.retry_condition = correction.reason;
      addEvidence(candidate, correction.event_id, correction.digest, null);
    }
  }

  for (const outcome of input.outcomes?.subjects ?? []) {
    if (outcome.delivery !== "superseded") continue;
    const candidate = get(candidates, outcome.subject_id, "superseded", null, "A delivery authority observed this attempt as superseded.");
    if (outcome.delivery_observation) {
      candidate.evidence.add(outcome.delivery_observation.event_id);
      candidate.transactions.add(outcome.delivery_observation.transaction_digest);
      candidate.source_refs.add(outcome.delivery_observation.source_ref);
    }
    candidate.retry_status = "blocked";
    candidate.retry_condition = "Follow the governing successor or append an authorized correction link.";
  }
  const graves = [...candidates.values()].map(finalize).sort((a, b) => a.subject_id.localeCompare(b.subject_id) || a.kind.localeCompare(b.kind));
  return freeze({ projection_version: GRAVE_PROJECTION_VERSION,
    source_digest: canonicalJsonDigest({ transactions: transactions.map(projectTransactionDigest), outcomes: input.outcomes?.source_digest ?? null }) as ProjectTransactionDigest,
    graves });
}

export function graveProjectionBytes(value: GraveProjection): Uint8Array { return canonicalJsonBytes(value); }
export function graveProjectionDigest(value: GraveProjection): ProjectTransactionDigest { return canonicalJsonDigest(value) as ProjectTransactionDigest; }

function get(map: Map<string, Candidate>, subject: CanonicalId, kind: GraveKind, goal: string | null, cause: string): Candidate {
  const key = `${subject}\0${kind}`;
  const candidate = map.get(key) ?? { subject_id: subject, kind, goal, cause, scope: new Set(), evidence: new Set(),
    transactions: new Set(), source_refs: new Set(), corrections: new Set(), retry_status: "unknown" as const,
    retry_condition: "Inspect the cited evidence and record an explicit recovery condition." };
  if (candidate.goal === null && goal !== null) candidate.goal = goal;
  map.set(key, candidate); return candidate;
}
function finalize(value: Candidate): GraveProjectionRecord {
  const missing = [];
  if (value.goal === null) missing.push("goal");
  if (value.scope.size === 0) missing.push("scope");
  if (value.retry_condition.trim().length === 0) missing.push("retry_condition");
  return freeze({ subject_id: value.subject_id, kind: value.kind, goal: value.goal, cause: value.cause,
    scope: [...value.scope].sort(), evidence_event_ids: [...value.evidence].sort(),
    source_transaction_digests: [...value.transactions].sort(), source_refs: [...value.source_refs].sort(),
    retry: { status: value.retry_status, condition: value.retry_condition }, correction_event_ids: [...value.corrections].sort(),
    completeness: { status: missing.length === 0 ? "complete" : "partial", missing_fields: missing.sort() } });
}
function addEvidence(candidate: Candidate, event: CanonicalId<"event">, digest: ProjectTransactionDigest, source: string | null) {
  candidate.evidence.add(event); candidate.transactions.add(digest); if (source) candidate.source_refs.add(source);
}
function legacyKind(status: string, disposition: string): GraveKind | null {
  if (disposition === "unresolved") return "unresolved";
  if (status === "failed" || status === "blocked") return status;
  if (status === "abandoned") return "abandoned";
  return null;
}
function defaultCause(kind: GraveKind): string { return kind === "unresolved" ? "The admitted attempt could not be linked without guessing." : `The Episode ended as ${kind}.`; }
function canonicalTransactions(input: readonly ProjectTransaction[]): ProjectTransaction[] { const result = [...input]; for (const item of result) assertProjectTransaction(item); return result.sort((a, b) => projectTransactionDigest(a).localeCompare(projectTransactionDigest(b))); }
function object(value: JsonValue): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function strings(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) freeze(item); } return value; }
