import { spawnSync } from "node:child_process";
import type { WorkspaceView } from "./view.js";

export interface ViewDiffReport {
  since: string;
  resolved_since: "iso-timestamp" | "last-session" | "earliest";
  resolved_at: string;
  new_continuity_packets: Array<{ id: string; mission: string; summary: string; created_at: string; agent: string }>;
  runs_started: Array<{ run_id: string; goal: string; agent_id: string; started_at: string }>;
  runs_finished: Array<{ run_id: string; goal: string; status: string; finished_at: string }>;
  tasks_changed: Array<{ task_id: string; title: string; status: string; updated_at: string; owner?: string }>;
  git_commits: Array<{ hash: string; subject: string; author: string; date: string }>;
  notable: boolean;
}

export interface ViewDiffOptions {
  since?: string;
  agentId?: string;
}

export async function diffView(view: WorkspaceView, options: ViewDiffOptions = {}): Promise<ViewDiffReport> {
  const resolved = await resolveSince(view, options.since, options.agentId);
  const since = resolved.iso;

  const packets = await safeListPackets(view);
  const runs = await safeListRuns(view);
  const tasks = await safeListTasks(view);

  const newPackets = packets
    .filter((p) => p.created_at > since)
    .map((p) => ({ id: p.id, mission: p.mission, summary: p.summary, created_at: p.created_at, agent: p.agent }));

  const runsStarted = runs
    .filter((r) => r.started_at > since)
    .map((r) => ({ run_id: r.run_id, goal: r.goal, agent_id: r.agent_id, started_at: r.started_at }));

  const runsFinished = runs
    .filter((r) => r.finished_at && r.finished_at > since)
    .map((r) => ({ run_id: r.run_id, goal: r.goal, status: r.status, finished_at: r.finished_at! }));

  const tasksChanged = tasks
    .filter((t) => t.updated_at > since)
    .map((t) => ({ task_id: t.task_id, title: t.title, status: t.status, updated_at: t.updated_at, owner: t.owner }));

  const gitCommits = listGitCommitsSince(view.root, since);

  const notable = newPackets.length > 0 || runsStarted.length > 0 || runsFinished.length > 0 || tasksChanged.length > 0 || gitCommits.length > 0;

  return {
    since: options.since ?? "earliest",
    resolved_since: resolved.kind,
    resolved_at: since,
    new_continuity_packets: newPackets,
    runs_started: runsStarted,
    runs_finished: runsFinished,
    tasks_changed: tasksChanged,
    git_commits: gitCommits,
    notable,
  };
}

async function resolveSince(view: WorkspaceView, since: string | undefined, agentId: string | undefined): Promise<{ iso: string; kind: ViewDiffReport["resolved_since"] }> {
  if (!since || since === "earliest") {
    return { iso: new Date(0).toISOString(), kind: "earliest" };
  }
  if (since === "last-session") {
    const packets = await safeListPackets(view);
    const mine = packets.filter((p) => !agentId || p.agent === agentId);
    const latest = mine.at(-1);
    if (latest) {
      return { iso: latest.created_at, kind: "last-session" };
    }
    return { iso: new Date(0).toISOString(), kind: "earliest" };
  }
  // Assume ISO 8601
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) {
    throw new Error(`--since must be an ISO-8601 timestamp, "last-session", or "earliest" (got '${since}').`);
  }
  return { iso: new Date(parsed).toISOString(), kind: "iso-timestamp" };
}

async function safeListPackets(view: WorkspaceView): Promise<Array<{ id: string; mission: string; summary: string; created_at: string; agent: string }>> {
  try {
    const ctx = await view.context();
    const latest = ctx.latest_continuity;
    if (latest) {
      // context only exposes latest; reach into the view directly for the full list.
    }
    return await readAllPackets(view);
  } catch {
    return [];
  }
}

async function readAllPackets(view: WorkspaceView): Promise<Array<{ id: string; mission: string; summary: string; created_at: string; agent: string }>> {
  const { existsSync } = await import("node:fs");
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = path.join(view.dataDir, "continuity");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const packets: Array<{ id: string; mission: string; summary: string; created_at: string; agent: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(dir, entry.name), "utf8");
      const parsed = JSON.parse(raw) as { id: string; mission: string; summary: string; created_at: string; agent: string };
      packets.push(parsed);
    } catch {
      continue;
    }
  }
  return packets.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function safeListRuns(view: WorkspaceView): Promise<Array<{ run_id: string; goal: string; agent_id: string; status: string; started_at: string; finished_at?: string }>> {
  try {
    const runs = await view.listRuns();
    return runs;
  } catch {
    return [];
  }
}

async function safeListTasks(view: WorkspaceView): Promise<Array<{ task_id: string; title: string; status: string; updated_at: string; owner?: string }>> {
  try {
    return await view.listTasks();
  } catch {
    return [];
  }
}

function listGitCommitsSince(repoRoot: string, sinceIso: string): ViewDiffReport["git_commits"] {
  const inside = spawnSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return [];
  const log = spawnSync("git", ["-C", repoRoot, "log", `--since=${sinceIso}`, "--pretty=format:%H%x09%an%x09%aI%x09%s"], { encoding: "utf8" });
  if (log.status !== 0 || !log.stdout) return [];
  const commits: ViewDiffReport["git_commits"] = [];
  for (const line of log.stdout.split("\n")) {
    if (!line) continue;
    const [hash, author, date, ...subjectParts] = line.split("\t");
    if (!hash || !date) continue;
    commits.push({ hash: hash.slice(0, 8), subject: (subjectParts.join("\t") || "").trim(), author: author ?? "", date });
  }
  return commits;
}

export function renderViewDiff(report: ViewDiffReport): string {
  const lines: string[] = [];
  lines.push(`diff since ${report.resolved_since === "iso-timestamp" ? report.resolved_at : report.resolved_since} (= ${report.resolved_at})`);
  lines.push("");
  if (!report.notable) {
    lines.push("  nothing has changed.");
    return lines.join("\n");
  }
  if (report.git_commits.length > 0) {
    lines.push(`  git commits (${report.git_commits.length}):`);
    for (const c of report.git_commits.slice(0, 10)) {
      lines.push(`    ${c.hash}  ${c.subject}  (${c.author}, ${c.date})`);
    }
    if (report.git_commits.length > 10) lines.push(`    ...and ${report.git_commits.length - 10} more`);
  }
  if (report.new_continuity_packets.length > 0) {
    lines.push(`  new continuity packets (${report.new_continuity_packets.length}):`);
    for (const p of report.new_continuity_packets.slice(0, 5)) {
      lines.push(`    [${p.agent}] ${p.mission}`);
    }
  }
  if (report.runs_started.length > 0) {
    lines.push(`  runs started (${report.runs_started.length}):`);
    for (const r of report.runs_started.slice(0, 5)) {
      lines.push(`    [${r.agent_id}] ${r.run_id.slice(0, 8)} ${r.goal}`);
    }
  }
  if (report.runs_finished.length > 0) {
    lines.push(`  runs finished (${report.runs_finished.length}):`);
    for (const r of report.runs_finished.slice(0, 5)) {
      lines.push(`    ${r.run_id.slice(0, 8)} ${r.status}: ${r.goal}`);
    }
  }
  if (report.tasks_changed.length > 0) {
    lines.push(`  tasks changed (${report.tasks_changed.length}):`);
    for (const t of report.tasks_changed.slice(0, 5)) {
      lines.push(`    [${t.task_id.slice(0, 8)}] ${t.status}: ${t.title}${t.owner ? ` (${t.owner})` : ""}`);
    }
  }
  return lines.join("\n");
}
