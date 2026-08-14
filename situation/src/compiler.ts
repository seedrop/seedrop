import { canonicalJsonBytes, canonicalJsonDigest } from "@seedrop/protocol";
import type { CanonicalId, ProjectTransactionDigest } from "@seedrop/protocol";
import { SITUATION_PROJECTION_VERSION } from "./types.js";
import type {
  CompileSituationInput, SituatedField, SituationCompleteness, SituationDecision, SituationDelivery,
  SituationFreshness, SituationGrave, SituationIntent, SituationProjection, SituationReadPort,
  SituationRisk, SituationSourceHealth, SituationSourceReference,
} from "./types.js";

export function compileSituation(input: CompileSituationInput): SituationProjection {
  assertTimestamp(input.generated_at);
  const ports = canonicalPorts(input);
  const project = input.project.value;
  const intent = selectIntent(project?.work ?? null) ?? selectImportedIntent(project?.imported_orientation ?? null);
  const subjectId = intent?.episode_id ?? intent?.intent_id ?? null;
  const delivery = selectDelivery(input.outcomes.value, subjectId);
  const grave = selectGrave(input.graves.value, subjectId);
  const risks = deriveRisks(input, intent, delivery, grave);
  const sourceHealth = deriveSourceHealth(input);

  const identityField = field(input.identity.value ? deepFreeze({ ...input.identity.value, candidates: [...input.identity.value.candidates].sort() }) : null, [input.identity]);
  const coordinationField = field(input.coordination.value ? deepFreeze({ ...input.coordination.value, active_claims: [...input.coordination.value.active_claims].sort() }) : null, [input.coordination]);
  const intentField = field(intent, [input.project]);
  const riskField = field(Object.freeze(risks), ports);
  const deliveryField = field(delivery, [input.project, input.outcomes]);
  const graveField = field(grave, [input.project, input.graves]);
  const healthField = field(sourceHealth, [input.project, input.identity, input.coordination, input.invalidation]);
  const decision = decide(input, intent, delivery, risks);
  const decisionField = field(decision, ports);
  const decisionId = canonicalJsonDigest(decisionField) as ProjectTransactionDigest;
  const sourceDigest = canonicalJsonDigest(ports.map(reference)) as ProjectTransactionDigest;
  const body = {
    projection_version: SITUATION_PROJECTION_VERSION,
    generated_at: input.generated_at,
    decision_id: decisionId,
    source_digest: sourceDigest,
    identity: identityField,
    coordination: coordinationField,
    intent: intentField,
    risk: riskField,
    delivery: deliveryField,
    grave: graveField,
    source_health: healthField,
    next_action: decisionField,
  };
  return deepFreeze({ ...body, situation_id: canonicalJsonDigest(body) as ProjectTransactionDigest });
}

export function situationBytes(value: SituationProjection): Uint8Array { return canonicalJsonBytes(value); }

function selectIntent(work: CompileSituationInput["project"]["value"] extends infer _ ? NonNullable<CompileSituationInput["project"]["value"]>["work"] | null : never): SituationIntent | null {
  if (!work) return null;
  const episodes = [...work.episodes].sort((a, b) => b.record.started_at.localeCompare(a.record.started_at)
    || a.record.episode_id.localeCompare(b.record.episode_id));
  const active = episodes.find((item) => ["active", "resumable_with_risk", "blocked"].includes(item.state));
  const intents = [...work.intents].sort((a, b) => b.record.created_at.localeCompare(a.record.created_at)
    || a.record.intent_id.localeCompare(b.record.intent_id));
  const selected = active ? intents.find((item) => item.record.intent_id === active.record.intent_id) :
    intents.find((item) => !["reported_complete", "abandoned", "failed"].includes(item.state));
  if (!selected) return null;
  const episode = active?.record.intent_id === selected.record.intent_id ? active : episodes.find((item) => item.record.intent_id === selected.record.intent_id);
  return deepFreeze({ intent_id: selected.record.intent_id, title: selected.record.title, state: selected.state,
    episode_id: episode?.record.episode_id ?? null, goal: episode?.record.goal ?? null });
}

function selectImportedIntent(imported: NonNullable<CompileSituationInput["project"]["value"]>["imported_orientation"] | null): SituationIntent | null {
  if (!imported) return null;
  const episodes = [...imported.episodes].sort((a, b) => b.observed_at.localeCompare(a.observed_at) || a.episode_id.localeCompare(b.episode_id));
  const active = episodes.find((item) => item.state === "in_progress");
  const intents = [...imported.intents].sort((a, b) => b.observed_at.localeCompare(a.observed_at) || a.intent_id.localeCompare(b.intent_id));
  const selected = (active ? intents.find((item) => item.related_episode_ids.includes(active.episode_id)) : undefined)
    ?? intents.find((item) => ["claimed", "open"].includes(item.state));
  if (!selected) return null;
  const episode = active ?? episodes.find((item) => selected.related_episode_ids.includes(item.episode_id));
  return deepFreeze({ intent_id: selected.intent_id, title: selected.title,
    state: active ? active.state : selected.state,
    episode_id: episode?.episode_id ?? null, goal: episode?.goal ?? null });
}

function selectDelivery(outcomes: CompileSituationInput["outcomes"]["value"], subjectId: CanonicalId | null): SituationDelivery | null {
  if (!outcomes || !subjectId) return null;
  const subject = outcomes.subjects.find((item) => item.subject_id === subjectId);
  if (!subject) return deepFreeze({ subject_id: subjectId, reported_lifecycle: null, evidence: "unverified", delivery: "unobserved", contradictions: [] });
  return deepFreeze({ subject_id: subject.subject_id, reported_lifecycle: subject.reported_lifecycle,
    evidence: subject.evidence, delivery: subject.delivery, contradictions: [...subject.contradictions].sort() });
}

function selectGrave(graves: CompileSituationInput["graves"]["value"], subjectId: CanonicalId | null): SituationGrave | null {
  if (!graves) return null;
  const rank: Record<string, number> = { blocked: 0, failed: 1, unresolved: 2, abandoned: 3, superseded: 4 };
  const selected = [...graves.graves].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)
    || a.subject_id.localeCompare(b.subject_id)).find((item) => item.subject_id === subjectId) ??
    [...graves.graves].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.subject_id.localeCompare(b.subject_id))[0];
  return selected ? deepFreeze({ subject_id: selected.subject_id, kind: selected.kind, cause: selected.cause,
    retry_status: selected.retry.status, retry_condition: selected.retry.condition,
    completeness: selected.completeness.status === "complete" ? "complete" : "partial" }) : null;
}

function deriveRisks(input: CompileSituationInput, intent: SituationIntent | null, delivery: SituationDelivery | null, grave: SituationGrave | null): SituationRisk[] {
  const risks: SituationRisk[] = [];
  for (const port of canonicalPorts(input)) {
    if (port.freshness !== "current") risks.push(risk(`source_${port.freshness}`, port.freshness === "unavailable" ? "critical" : "high", `${port.source_id} is ${port.freshness}.`, [port.source_id]));
    if (port.completeness !== "complete") risks.push(risk(`source_${port.completeness}`, port.completeness === "unavailable" ? "critical" : "high", `${port.source_id} is ${port.completeness}.`, [port.source_id]));
  }
  const health = input.project.value?.health;
  if (health && health.substrate !== "healthy") risks.push(risk(`substrate_${health.substrate}`, health.substrate === "corrupt" || health.substrate === "unreachable" ? "critical" : "high", `Project substrate is ${health.substrate}.`, [input.project.source_id]));
  for (const item of health?.quarantined ?? []) risks.push(risk(`quarantine:${item.code}`, item.severity === "error" ? "critical" : "high", `Quarantined ${item.referent}: ${item.code}.`, [item.source_id]));
  for (const item of health?.disagreements.filter((item) => item.resolution.status === "unresolved") ?? []) risks.push(risk(`disagreement:${item.field}`, "critical", `Sources disagree about ${item.field}.`, item.claims.map((claim) => claim.source_id)));
  for (const item of health?.stale_projections ?? []) risks.push(risk(`stale_projection:${item.projection}`, "critical", `${item.projection} is stale against ${item.source_id}.`, [item.source_id]));
  for (const item of health?.pending_commands ?? []) risks.push(risk(`pending_command:${item.phase}`, item.recoverable ? "high" : "critical", `Command ${item.command_id} is pending at ${item.phase}.`, [input.project.source_id]));
  if (health && !health.budget.complete) risks.push(risk("source_budget_incomplete", "critical", "The source health read omitted required evidence under its byte budget.", [input.project.source_id]));
  if (delivery?.contradictions.length) for (const contradiction of delivery.contradictions) risks.push(risk(`outcome:${contradiction}`, "critical", `Outcome contradiction: ${contradiction}.`, [input.outcomes.source_id]));
  if (delivery?.reported_lifecycle === "reported_complete" && delivery.evidence !== "passed") risks.push(risk("reported_complete_without_validation", "high", "Completion is reported but validation evidence does not prove it.", [input.outcomes.source_id]));
  const relevantClaimIds = new Set<string>((input.project.value?.work.claims ?? []).filter((claim) => claim.intent_id === intent?.intent_id).map((claim) => claim.claim_id));
  for (const claim of input.invalidation.value?.claims ?? []) if (claim.state === "invalidated" && relevantClaimIds.has(claim.claim_id)) risks.push(risk("relevant_claim_invalidated", "critical", `Claim ${claim.claim_id} depends on changed sources.`, [input.invalidation.source_id, ...claim.changed_source_ids]));
  if (grave) risks.push(risk(`grave:${grave.kind}`, grave.kind === "blocked" || grave.kind === "failed" ? "high" : "medium", `Relevant negative continuity: ${grave.kind} — ${grave.cause}`, [input.graves.source_id]));
  return uniqueRisks(risks);
}

function deriveSourceHealth(input: CompileSituationInput): SituationSourceHealth | null {
  const health = input.project.value?.health;
  if (!health) return null;
  const degraded = canonicalPorts(input).filter((port) => port.freshness !== "current" || port.completeness !== "complete").map((port) => port.source_id);
  degraded.push(...health.sources.filter((source) => source.status !== "available").map((source) => source.source_id));
  return deepFreeze({ substrate: health.substrate, degraded_source_ids: [...new Set(degraded)].sort(),
    quarantine_count: health.quarantined.length,
    unresolved_disagreement_count: health.disagreements.filter((item) => item.resolution.status === "unresolved").length });
}

function decide(input: CompileSituationInput, intent: SituationIntent | null, delivery: SituationDelivery | null, risks: readonly SituationRisk[]): SituationDecision {
  const sourceIds = canonicalPorts(input).map((port) => port.source_id);
  const blockers: string[] = [], requests: string[] = [];
  if (!input.project.value || input.project.completeness !== "complete" || input.project.freshness !== "current") { blockers.push("project_truth_not_current_and_complete"); requests.push("refresh_or_repair_project_projection"); }
  if (!input.identity.value || input.identity.value.status !== "resolved") { blockers.push("principal_not_resolved"); requests.push("resolve_principal_identity"); }
  for (const risk of risks.filter((item) => item.severity === "critical")) { blockers.push(risk.code); requests.push(`resolve:${risk.code}`); }
  if (!intent) { blockers.push("current_intent_unknown"); requests.push("record_or_select_current_intent"); }
  if (blockers.length) return deepFreeze({ disposition: "refuse", reason: "Cannot recommend safely while governing evidence is unknown or contradictory.",
    blocking_unknowns: [...new Set(blockers)].sort(), evidence_requests: [...new Set(requests)].sort(),
    smallest_repair: requests.sort()[0]!, evidence_source_ids: sourceIds });
  const restrictions: string[] = [];
  if (!input.coordination.value || input.coordination.value.status !== "available" || input.coordination.freshness !== "current") restrictions.push("coordination_actions_disabled");
  if (delivery?.evidence === "failed" || delivery?.evidence === "stale") return recommendation("rerun_validation", "Validation evidence does not support continuing toward delivery.", "seed validate", restrictions, sourceIds);
  if (delivery?.reported_lifecycle === "reported_complete" && delivery.evidence !== "passed") return recommendation("validate_reported_completion", "Completion is only reported; collect validation evidence before making a delivery claim.", "seed validate", restrictions, sourceIds);
  if (delivery && ["reverted", "superseded", "absent"].includes(delivery.delivery)) return recommendation("inspect_delivery", `Observed delivery state is ${delivery.delivery}.`, null, restrictions, sourceIds);
  return recommendation(restrictions.length ? "resume_local_intent" : "resume_intent", `Resume ${intent!.title}; governing project and identity evidence is sufficient.`, null, restrictions, sourceIds);
}

function recommendation(action: string, reason: string, command: string | null, restrictions: readonly string[], sources: readonly string[]): SituationDecision {
  return deepFreeze({ disposition: "recommend", action, reason, command, restrictions: [...restrictions].sort(), evidence_source_ids: [...sources].sort() });
}
function risk(code: string, severity: SituationRisk["severity"], summary: string, sources: readonly string[]): SituationRisk { return deepFreeze({ code, severity, summary, source_ids: [...new Set(sources)].sort() }); }
function uniqueRisks(risks: readonly SituationRisk[]): SituationRisk[] { const byKey = new Map(risks.map((item) => [`${item.code}\u0000${item.summary}`, item])); const rank = { critical: 0, high: 1, medium: 2, low: 3 }; return [...byKey.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code)); }

function field<T>(value: T, ports: readonly SituationReadPort<unknown>[]): SituatedField<T> {
  const canonical = [...ports].sort((a, b) => a.source_id.localeCompare(b.source_id));
  return deepFreeze({ value, provenance: canonical.map(reference), freshness: worstFreshness(canonical.map((port) => port.freshness)),
    completeness: worstCompleteness(canonical.map((port) => port.completeness)), missing: [...new Set(canonical.flatMap((port) => port.missing))].sort() });
}
function canonicalPorts(input: CompileSituationInput): SituationReadPort<unknown>[] { return [input.project, input.outcomes, input.graves, input.identity, input.coordination, input.invalidation].sort((a, b) => a.source_id.localeCompare(b.source_id)); }
function reference(port: SituationReadPort<unknown>): SituationSourceReference { return deepFreeze({ source_id: port.source_id, source_digest: port.source_digest, observed_at: port.observed_at, freshness: port.freshness, completeness: port.completeness }); }
function worstFreshness(values: readonly SituationFreshness[]): SituationFreshness { return values.includes("unavailable") ? "unavailable" : values.includes("stale") ? "stale" : "current"; }
function worstCompleteness(values: readonly SituationCompleteness[]): SituationCompleteness { return values.includes("unavailable") ? "unavailable" : values.includes("partial") ? "partial" : "complete"; }
function assertTimestamp(value: string): void { if (new Date(value).toISOString() !== value) throw new Error("generated_at must be a canonical UTC timestamp."); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
