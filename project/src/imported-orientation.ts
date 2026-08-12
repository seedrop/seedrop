import type { CanonicalId, JsonValue } from "@seedrop/protocol";
import type { ImportedEpisodeProjectionRecord, ImportedIntentProjectionRecord, ImportedOrientationProjection, ProjectLogScan } from "./types.js";
import { reduceProjectTransactions } from "./projection.js";

export function reduceImportedOrientation(scan: ProjectLogScan): ImportedOrientationProjection {
  const project = reduceProjectTransactions(scan);
  if (!project.lag.complete) throw new Error("Imported orientation requires a complete Project projection.");
  const transactions = new Map(scan.transactions.map((entry) => [entry.digest, entry]));
  const intents = new Map<string, ImportedIntentProjectionRecord>();
  const episodes = new Map<string, ImportedEpisodeProjectionRecord>();
  let ignored = 0;
  for (const applied of project.applied) {
    const transaction = transactions.get(applied.transaction_digest)!;
    for (const event of transaction.transaction.events) {
      if (!event.event_type.startsWith("seedrop.migration.record_")) { ignored += 1; continue; }
      const payload = object(event.payload), source = object(payload.source_payload), links = object(payload.explicit_links);
      if (payload.disposition !== "imported" || typeof payload.source_ref !== "string") { ignored += 1; continue; }
      if (payload.source_family === "task" && typeof payload.canonical_subject_id === "string" && typeof source.title === "string") {
        intents.set(payload.canonical_subject_id, deepFreeze({ intent_id: payload.canonical_subject_id as CanonicalId<"intent">,
          title: source.title, state: typeof source.status === "string" ? source.status : "unknown", source_ref: payload.source_ref,
          observed_at: timestamp(source.updated_at, source.created_at, event.occurred_at), related_episode_ids: strings(links.related_episode_ids) as CanonicalId<"episode">[] }));
      } else if (payload.source_family === "run" && typeof payload.canonical_subject_id === "string" && typeof source.goal === "string") {
        episodes.set(payload.canonical_subject_id, deepFreeze({ episode_id: payload.canonical_subject_id as CanonicalId<"episode">,
          goal: source.goal, state: typeof source.status === "string" ? source.status : "unknown", source_ref: payload.source_ref,
          observed_at: timestamp(source.updated_at, source.finished_at, source.started_at, event.occurred_at) }));
      } else ignored += 1;
    }
  }
  return deepFreeze({ projection_version: "1.0.0", project_id: scan.project_id,
    source_high_watermark: project.source_high_watermark,
    intents: [...intents.values()].sort((a, b) => a.intent_id.localeCompare(b.intent_id)),
    episodes: [...episodes.values()].sort((a, b) => a.episode_id.localeCompare(b.episode_id)), ignored_event_count: ignored });
}
function object(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function strings(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").sort() : []; }
function timestamp(...values: (JsonValue | undefined)[]): string { return values.find((value): value is string => typeof value === "string")!; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
