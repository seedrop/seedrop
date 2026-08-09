import type { BucketId, ObserverProject, ObserverTask } from "./types";

export const BUCKET_LABELS: Record<BucketId, string> = {
  ongoing: "Ongoing",
  needs_attention: "Needs attention",
  up_next: "Up Next",
  quiet: "Quiet",
};

export function projectBucket(project: ObserverProject): BucketId {
  if (project.status === "active" || (project.counts?.activeRuns ?? 0) > 0) return "ongoing";
  if (project.status === "broken") return "needs_attention";
  const blocked = project.situation?.tasks?.blocked ?? 0;
  if (blocked > 0) return "needs_attention";
  if (project.status === "attention" || (project.counts?.openTasks ?? 0) > 0) return "up_next";
  return "quiet";
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
