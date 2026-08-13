import type { AdapterSituationProjection, BucketId, ObserverProject, ObserverTask } from "./types";

export const BUCKET_LABELS: Record<BucketId, string> = {
  ongoing: "Ongoing",
  needs_attention: "Needs attention",
  up_next: "Up Next",
  quiet: "Quiet",
};

export function projectBucket(project: ObserverProject): BucketId {
  const shared = canonicalSituation(project);
  if (shared) return shared.bucket;
  if (project.status === "active" || (project.counts?.activeRuns ?? 0) > 0) return "ongoing";
  if (project.status === "broken") return "needs_attention";
  const blocked = project.situation?.tasks?.blocked ?? 0;
  if (blocked > 0) return "needs_attention";
  if (project.status === "attention" || (project.counts?.openTasks ?? 0) > 0) return "up_next";
  return "quiet";
}

export function canonicalSituation(project: ObserverProject): AdapterSituationProjection | null {
  const selection = project.adapter_situation;
  return selection?.mode === "v2" && selection.served.kind === "v2_situation"
    ? selection.served.payload
    : null;
}

export function canonicalIntent(project: ObserverProject): string | null {
  const shared = canonicalSituation(project);
  return shared ? displayField(shared.orientation.intent, ["title", "goal", "state", "intent_id"]) : null;
}

export function canonicalDecision(project: ObserverProject): {
  disposition: "recommend" | "refuse" | "unknown";
  display: string;
  reason: string | null;
} | null {
  const shared = canonicalSituation(project);
  return shared ? {
    disposition: shared.decision.disposition,
    display: shared.decision.display,
    reason: shared.decision.reason,
  } : null;
}

export function canonicalHealth(project: ObserverProject): AdapterSituationProjection["health"] | null {
  return canonicalSituation(project)?.health ?? null;
}

export function filterByBucket(projects: ObserverProject[], bucket: BucketId): ObserverProject[] {
  return projects.filter((p) => projectBucket(p) === bucket);
}

export function projectTitle(project: ObserverProject): string {
  return project.label || project.id;
}

export function taskProgress(project: ObserverProject): { done: number; total: number } {
  const open = project.situation?.tasks?.open ?? project.counts?.openTasks ?? 0;
  const blocked = project.situation?.tasks?.blocked ?? 0;
  const active = project.situation?.tasks?.active ?? 0;
  const total = Math.max(open, active + blocked, project.inspectors?.tasks?.active?.length ?? 0);
  // Desktop is read-only; treat remaining open work as incomplete.
  const done = 0;
  return { done, total };
}

export function projectStatusLabel(project: ObserverProject): string {
  const bucket = projectBucket(project);
  return BUCKET_LABELS[bucket];
}

export function collectTasks(project: ObserverProject): ObserverTask[] {
  return project.inspectors?.tasks?.active ?? [];
}

function displayField(input: unknown, keys: readonly string[]): string {
  if (typeof input === "string") return input;
  const value = record(input);
  for (const key of keys) {
    const candidate = string(value[key]);
    if (candidate) return candidate;
  }
  return "Not available";
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function string(input: unknown): string | null {
  return typeof input === "string" && input.length > 0 ? input : null;
}
