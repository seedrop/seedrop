import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceView, type AuditReport, type ContinuityPacket as SpaceContinuityPacket, type Grave, type ViewBrief as SpaceViewBrief, type ViewCheck } from "@seedrop/space";
import type { PassportSource } from "./active-passport.js";
import { readContinuityState, writeContinuityState } from "./continuity-state.js";
import type { RunCliIO } from "./router.js";

export interface ContinuityOptions {
  passportPath: string;
  /** How `passportPath` was resolved: env > active login > operator fallback. */
  passportSource?: PassportSource;
  spaceUrl: string;
  cwd: string;
  root?: string;
  rootKind?: "git" | "folder";
  messageLimit?: number;
  json?: boolean;
  /** ISO-8601 watermark to compare against. If omitted, reads the per-agent state file. */
  since?: string;
  /** When false (default), the watermark is advanced to "now" after the report is built. */
  peek?: boolean;
}

export type ContinuityRenderMode = "brief" | "medium" | "full";

interface Passport {
  agent_id?: string;
  name?: string;
  purpose?: string;
  issued_by?: string;
  autonomous?: boolean;
  active_projects?: Array<{
    id: string;
    root: string;
    role?: string;
    current_focus?: string;
    space?: string;
    last_seen_at?: string;
  }>;
  continuity?: {
    current_focus?: string;
    handoff?: string;
    next_actions?: string[];
    open_threads?: string[];
    updated_at?: string;
  };
}

interface ViewManifest {
  workspace_id?: string;
  root?: string;
  /** Full file list — only present when reading manifest.json directly. */
  files?: Array<{ path: string }>;
  /** Summary form delivered by `view context` (files are never inlined there). */
  files_count?: number;
  updated_at?: string;
}

type ViewBrief = Pick<SpaceViewBrief, "success" | "git_status">;

interface ViewSignal {
  id: string;
  type: "claim" | "lock";
  target: string;
  intent?: string;
  owner?: string;
  created_at?: string;
  expires_at?: string;
}

interface ViewTask {
  task_id: string;
  title: string;
  status: "open" | "claimed" | "in_progress" | "blocked" | "done" | "dropped";
  owner?: string;
  assigned_by?: string;
  from_knowledge?: string;
  blocked_by?: string[];
}

type ContinuityPacket = Partial<SpaceContinuityPacket> & {
  // cli reads this extra field on packets surfaced by the daemon; not in the wire schema yet.
  next_actions?: string[];
};

interface ViewRun {
  run_id: string;
  agent_id: string;
  goal: string;
  status: "in_progress" | "completed" | "blocked" | "failed";
  started_at?: string;
  updated_at?: string;
  changed_paths?: string[];
  open_threads?: string[];
  validation?: Array<{ command: string; status: string; recorded_at: string }>;
  next_actions?: Array<{ command?: string; reason: string; kind: string }>;
}

interface OrientationNextAction {
  kind: "setup" | "inbox" | "handoff" | "signal" | "verify" | "run" | "continuity" | "space" | "focus";
  command?: string;
  reason: string;
  source: "identity" | "view" | "daemon" | "inbox" | "handoff" | "signal" | "run" | "continuity" | "space";
  risk: "low" | "medium" | "high";
  requires_human: boolean;
}

interface OrientationReport {
  schema_version: "1.0";
  identity: {
    present: boolean;
    agent_id: string | null;
    passport_path: string;
    source: "passport" | "missing";
  };
  place: {
    cwd: string;
    root: string;
    root_kind: "git" | "folder";
    view_present: boolean;
    workspace_id: string | null;
  };
  traces: {
    latest_continuity_at: string | null;
    current_run_id: string | null;
    current_run_goal: string | null;
    latest_run_status: string | null;
    open_signals: number;
  };
  coordination: {
    daemon_reachable: boolean;
    inbox_unacked: number;
    joined_spaces: string[];
    online_sessions: number;
  };
  health: {
    warnings: string[];
    view_preflight_failed: boolean;
    view_success_level: "L0" | "L1" | "L2" | "L3" | "L4" | null;
    view_success_required: "L0" | "L1" | "L2" | "L3" | "L4" | null;
    view_success_meets_required: boolean | null;
  };
  next_action: OrientationNextAction;
}

interface PresenceRecord {
  passport_id: string;
  working_on?: string;
  last_seen_at: string;
  online: boolean;
}

interface InboxMention {
  id: string;
  message_id: string;
  space_id: string;
  space_name?: string;
  sender_passport_id: string;
  sender_principal_chain?: string[];
  content: string;
  created_at: string;
  delivered_at?: string;
  acked_at?: string;
  ack_result?: "done" | "deferred" | "ignored";
  deferred_until?: string;
}

interface SpaceMessage {
  author_passport_id: string;
  content: string;
  created_at: string;
  principal_chain?: string[];
  author_autonomous?: boolean;
}

interface JoinedSpaceSummary {
  name: string;
  presence: PresenceRecord[];
  recentMessages: SpaceMessage[];
  unreachable?: boolean;
}

type FetchErrorKind = "sandbox_denied" | "timeout" | "http_error" | "fetch_failed";

interface FetchJsonResult<T> {
  value: T | null;
  errorKind?: FetchErrorKind;
  errorMessage?: string;
}

export interface ContinuityReport {
  passportPath: string;
  /** How the passport path was resolved (omitted only for older callers). */
  passportSource?: PassportSource;
  passport: Passport | null;
  cwd: string;
  root: string;
  rootKind: "git" | "folder";
  /** Prior watermark (ISO-8601) — what the agent saw last time, or undefined on first call. */
  since?: string;
  /** Whether the watermark was advanced (false when --peek). */
  watermarkAdvanced: boolean;
  view: {
    present: boolean;
    manifest?: ViewManifest;
    brief?: ViewBrief;
    signals: ViewSignal[];
    latestPacket?: ContinuityPacket;
    currentRun?: ViewRun;
    latestRun?: ViewRun;
    activeTasks: ViewTask[];
    blockerTasks: ViewTask[];
    openTasksCount: number;
    otherAgents: Array<{
      agent_id: string;
      active_runs: Array<{ run_id: string; goal: string; started_at: string; changed_paths: string[] }>;
      claims: Array<{ signal_id: string; target: string; intent: string; expires_at: string }>;
      in_progress_tasks: Array<{ task_id: string; title: string }>;
    }>;
  };
  /**
   * Cached View audit snapshot (from `.seedrop/view/audit.json`), or null when
   * no View is present. This is the same cached report `context()` surfaces — it
   * is NOT a fresh full-tree re-hash. Callers that need deep, current drift
   * detection must run `seed view audit` explicitly.
   */
  cachedAudit: AuditReport | null;
  /**
   * Dead runs (failed/blocked) in this repo, most recent first. Unscoped here;
   * boot narrows to the paths in play. Empty when no View is present.
   */
  graves: Grave[];
  daemon: {
    url: string;
    reachable: boolean;
    presence: PresenceRecord[];
  };
  inbox: {
    unacked: InboxMention[];
    fetched: boolean;
  };
  joinedSpaces: JoinedSpaceSummary[];
  warnings: string[];
  orientation: OrientationReport;
}

export async function buildContinuity(opts: ContinuityOptions): Promise<ContinuityReport> {
  const warnings: string[] = [];
  const root = opts.root ?? opts.cwd;
  const rootKind = opts.rootKind ?? rootKindFor(opts.cwd, root);
  const passport = await readJson<Passport>(opts.passportPath);
  if (!passport) {
    warnings.push(
      `No passport at ${opts.passportPath}. Run \`seed bootstrap --name <name> --purpose "<purpose>"\` first.`,
    );
  }

  // Resolve watermark: explicit --since wins, else read state file, else undefined (first run).
  let since: string | undefined = opts.since;
  if (!since && passport?.agent_id) {
    const state = await readContinuityState(passport.agent_id);
    since = state?.last_seen_at;
  }

  // Internal consumption: no byte budget — trimming here would starve the
  // router (capped task lists would make blocked_by lookups read as open).
  const viewContext = await WorkspaceView.open({
    root,
    agent: passport?.agent_id ?? "agent",
  }).context({ budgetBytes: 0 });
  const viewPresent = viewContext.view?.present ?? false;
  const manifest = viewContext.manifest as ViewManifest | undefined;
  const viewBrief = viewContext.brief as ViewBrief | undefined;
  const signals = (viewContext.active_signals ?? []) as ViewSignal[];
  const latestPacket = viewContext.latest_continuity as ContinuityPacket | undefined;
  const currentRun = viewContext.current_run as ViewRun | undefined;
  const latestRun = viewContext.latest_run as ViewRun | undefined;
  const activeTasks = (viewContext.active_tasks ?? []) as ViewTask[];
  const blockerTasks = await loadReferencedBlockerTasks(root, activeTasks);
  const openTasksCount = typeof viewContext.open_tasks_count === "number" ? viewContext.open_tasks_count : 0;
  const otherAgents = (viewContext.other_agents ?? []) as ContinuityReport["view"]["otherAgents"];
  // Reuse the cached audit context() already loaded. Boot consumes this instead
  // of running a fresh full-tree hash audit, which on large roots (worst case a
  // stray $HOME View) takes tens of seconds and made boot unusable.
  const cachedAudit: AuditReport | null = viewPresent ? (viewContext.latest_audit ?? null) : null;
  // Dead runs. Loaded unscoped and cheaply here; boot narrows them to the paths
  // the agent is actually about to touch. This is the one class of evidence that
  // cannot be recovered from git — the repo records what survived, never what
  // was tried and abandoned.
  const graves: Grave[] = viewPresent
    ? await WorkspaceView.open({ root, agent: passport?.agent_id ?? "agent" })
        .listGraves({ limit: 20 })
        .catch(() => [])
    : [];
  if (!viewPresent) {
    warnings.push(`No .seedrop/view in ${root}. Run \`seed bootstrap\` to link this root to your passport.`);
  }
  const preflightChecks: ViewCheck[] = viewContext.preflight?.checks ?? [];
  const viewPreflightFailed = preflightChecks.some((check) => check.status === "fail");
  const viewPreflightWarn = !viewPreflightFailed && preflightChecks.some((check) => check.status === "warn");
  if (viewPreflightFailed) {
    const n = preflightChecks.filter((c) => c.status === "fail").length;
    warnings.push(`View preflight has ${n} failed check${n === 1 ? "" : "s"}. Run \`seed view preflight --json\` for repair details.`);
  } else if (viewPreflightWarn) {
    const n = preflightChecks.filter((c) => c.status === "warn").length;
    warnings.push(`View preflight has ${n} warning${n === 1 ? "" : "s"}. Run \`seed view preflight --json\` for details.`);
  }

  const presenceResult = await fetchJsonResult<{ presence: PresenceRecord[] }>(`${opts.spaceUrl}/presence`);
  const presence = presenceResult.value;
  const daemonReachable = presence !== null;
  if (!daemonReachable) {
    if (presenceResult.errorKind === "sandbox_denied") {
      warnings.push(`Space daemon at ${opts.spaceUrl} could not be reached from this runtime sandbox. Try Seedrop MCP tools or run \`seed continuity\` outside the sandbox.`);
    } else {
      warnings.push(`Space daemon at ${opts.spaceUrl} is not reachable. Try \`seed daemon status\`.`);
    }
  }

  // Auto-register a presence session if this passport has none yet. Combined
  // with the daemon's auto-refresh on every authenticated request, this keeps
  // the agent "online" while it makes any tool calls.
  if (daemonReachable && passport?.agent_id && !opts.peek) {
    const hasSession = (presence?.presence ?? []).some((p) => p.passport_id === passport.agent_id);
    if (!hasSession) {
      await postJson(
        `${opts.spaceUrl}/sessions`,
        { workingOn: "active session" },
        passport.agent_id,
      );
    }
  }

  let inboxMentions: InboxMention[] = [];
  let inboxFetched = false;
  if (daemonReachable && passport?.agent_id) {
    const result = await fetchJson<{ mentions: InboxMention[] }>(
      `${opts.spaceUrl}/inbox/${encodeURIComponent(passport.agent_id)}?unacked_only=true`,
      passport.agent_id,
    );
    if (result) {
      inboxMentions = result.mentions ?? [];
      inboxFetched = true;
    }
  }

  const joinedSpaces: JoinedSpaceSummary[] = [];
  if (daemonReachable && passport?.active_projects) {
    const seen = new Set<string>();
    for (const project of passport.active_projects) {
      if (!project.space || seen.has(project.space)) continue;
      seen.add(project.space);
      const messages = await fetchJson<{ messages: SpaceMessage[] }>(
        `${opts.spaceUrl}/spaces/${encodeURIComponent(project.space)}/messages`,
        passport.agent_id,
      );
      joinedSpaces.push({
        name: project.space,
        presence: (presence?.presence ?? []).filter((p) => true),
        recentMessages: (messages?.messages ?? []).slice(-(opts.messageLimit ?? 5)),
        unreachable: messages === null,
      });
    }
  }

  const watermarkAdvanced = !opts.peek && passport?.agent_id !== undefined;
  if (watermarkAdvanced && passport?.agent_id) {
    await writeContinuityState(passport.agent_id, {
      schema_version: "1.0",
      last_seen_at: new Date().toISOString(),
    });
  }

  const report: Omit<ContinuityReport, "orientation"> = {
    passportPath: opts.passportPath,
    passportSource: opts.passportSource,
    passport,
    cwd: opts.cwd,
    root,
    rootKind,
    since,
    watermarkAdvanced,
    view: {
      present: viewPresent,
      manifest,
      brief: viewBrief,
      signals,
      latestPacket,
      currentRun,
      latestRun,
      activeTasks,
      blockerTasks,
      openTasksCount,
      otherAgents,
    },
    cachedAudit,
    graves,
    daemon: {
      url: opts.spaceUrl,
      reachable: daemonReachable,
      presence: presence?.presence ?? [],
    },
    inbox: {
      unacked: inboxMentions,
      fetched: inboxFetched,
    },
    joinedSpaces,
    warnings,
  };
  return { ...report, orientation: buildOrientation(report, viewPreflightFailed) };
}

async function loadReferencedBlockerTasks(root: string, activeTasks: ViewTask[]): Promise<ViewTask[]> {
  const activeIds = new Set(activeTasks.map((task) => task.task_id));
  const blockerIds = new Set(
    activeTasks
      .flatMap((task) => task.blocked_by ?? [])
      .filter((taskId) => !activeIds.has(taskId)),
  );
  const tasks: ViewTask[] = [];
  for (const taskId of blockerIds) {
    try {
      const raw = await readFile(join(root, ".seedrop", "view", "tasks", `${taskId}.json`), "utf8");
      tasks.push(JSON.parse(raw) as ViewTask);
    } catch {
      // Missing/invalid blocker files are handled conservatively by selectNextAction.
    }
  }
  return tasks;
}

export function renderContinuity(report: ContinuityReport, mode: ContinuityRenderMode = "brief"): string {
  if (mode === "full") return renderContinuityFull(report);
  const lines = renderContinuityBrief(report);
  if (mode === "medium") {
    appendMediumCoordination(lines, report);
  }
  return lines.join("\n");
}

function renderContinuityBrief(report: ContinuityReport): string[] {
  const lines: string[] = [];
  const p = report.passport;
  const agent = p?.agent_id ?? p?.name ?? "(no passport yet)";
  const workspaceFocus = (report.view.brief as { workspace?: { current_focus?: string } } | undefined)?.workspace?.current_focus;
  const unacked = report.inbox.unacked;

  lines.push(`# Continuity — ${agent}`);
  if (report.since) {
    lines.push(`_since last seen ${humanAge(report.since)}_`);
  } else if (report.watermarkAdvanced) {
    lines.push(`_first run on this agent_`);
  }
  lines.push("");

  lines.push("## Identity");
  if (p) {
    lines.push(`  acting as: ${p.agent_id}${formatPassportSourceTag(report.passportSource)}`);
    if (p.name && p.name !== p.agent_id) lines.push(`  name: ${p.name}`);
    if (p.purpose) lines.push(`  purpose: ${p.purpose}`);
    lines.push(`  passport: ${formatPassportLocation(report.passportPath)}`);
  } else {
    lines.push(`  (none — run \`seed bootstrap --name <n> --purpose "<p>"\`)`);
  }
  lines.push("");

  lines.push("## Where you are");
  lines.push(`  cwd: ${report.cwd}`);
  if (report.root !== report.cwd) lines.push(`  root: ${report.root} (${report.rootKind})`);
  lines.push(`  view: ${report.view.present ? `present${report.view.manifest?.workspace_id ? ` (${report.view.manifest.workspace_id})` : ""}` : "absent"}`);
  const gitStatus = report.view.brief?.git_status;
  if (gitStatus?.is_dirty) lines.push(`  git: ${gitStatus.uncommitted_count} uncommitted`);
  else if (gitStatus?.is_repo) lines.push("  git: clean");
  lines.push("");

  lines.push("## Focus");
  lines.push(`  ${workspaceFocus ?? report.view.currentRun?.goal ?? report.view.latestPacket?.mission ?? "(no focus recorded)"}`);
  lines.push("");

  appendGoverningRecords(lines, report, 5);

  lines.push(`## Inbox — ${report.inbox.fetched ? `${unacked.length} unacked` : "unavailable"}`);
  for (const mention of unacked.slice(0, 3)) {
    const where = mention.space_name ? ` in #${mention.space_name}` : "";
    lines.push(`  - [${mention.id.slice(0, 8)}] ${mention.sender_passport_id}${where}: ${truncate(mention.content, 100)}`);
  }
  if (unacked.length > 3) lines.push(`  ...and ${unacked.length - 3} more. \`seed inbox\` to read all.`);
  lines.push("");

  lines.push("## Next move");
  lines.push(`  ${formatNextAction(report.orientation.next_action)}`);
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("## Heads-up");
    for (const warning of report.warnings.slice(0, 3)) {
      const referent = continuityWarningReferent(warning);
      for (const claim of splitContinuityClaims(warning)) {
        lines.push(`  Warning about ${referent}: ${claim}`);
      }
    }
  }
  lines.push("");
  return lines;
}

function appendMediumCoordination(lines: string[], report: ContinuityReport): void {
  lines.push("## Active coordination");
  if (report.view.currentRun) {
    lines.push(`  current run: ${report.view.currentRun.run_id}`);
    lines.push(`    goal: ${report.view.currentRun.goal}`);
  } else {
    lines.push("  current run: none");
  }
  const myAgentId = report.passport?.agent_id;
  const myTasks = myAgentId ? report.view.activeTasks.filter((task) => task.owner === myAgentId && task.status !== "open") : [];
  lines.push(`  your tasks: ${myTasks.length}`);
  for (const task of myTasks.slice(0, 5)) {
    lines.push(`    - [${task.task_id.slice(0, 8)}] ${task.status}: ${truncate(task.title, 80)}`);
  }
  if (report.view.otherAgents.length > 0) {
    lines.push("  other agents:");
    for (const other of report.view.otherAgents) {
      const active = other.active_runs[0];
      const claim = other.claims[0];
      if (active) lines.push(`    ${other.agent_id}: run "${truncate(active.goal, 70)}" (${active.run_id.slice(0, 8)})`);
      if (claim) lines.push(`    ${other.agent_id}: claim on ${claim.target}`);
    }
  }
  lines.push("");
}

interface FocusSignal {
  target: string;
  type: "claim" | "lock";
  owner?: string;
  intent?: string;
}

interface ScopedSignals {
  /** True when the current run gives us paths to scope collisions against. */
  hasFocusTargets: boolean;
  /** Signals worth surfacing for the current focus. */
  relevant: FocusSignal[];
  /** Count of other-agent signals not relevant to the focus (shown as a tally). */
  elsewhere: number;
}

/** Directory-aware path overlap, matching on "/" boundaries in both directions. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Reduce the active signal set to the collisions that matter for the current
 * focus: other agents' signals that either touch a path the current run is
 * changing, or are locks (always high-risk). Everything else is counted but
 * not listed — it stays fully visible in `seed continuity`. This is
 * mission-scoping, not suppression of state.
 */
function scopeSignalsToFocus(report: ContinuityReport): ScopedSignals {
  const me = report.passport?.agent_id;
  const focusTargets = report.view.currentRun?.changed_paths ?? [];
  const others = report.view.signals.filter((s) => s.owner !== me);
  if (focusTargets.length === 0) {
    // No current run → no focus paths to scope against; tally only.
    return { hasFocusTargets: false, relevant: [], elsewhere: others.length };
  }
  const relevant = others.filter(
    (s) => s.type === "lock" || focusTargets.some((ft) => pathsOverlap(ft, s.target)),
  );
  return {
    hasFocusTargets: true,
    relevant: relevant.map((s) => ({ target: s.target, type: s.type, owner: s.owner, intent: s.intent })),
    elsewhere: others.length - relevant.length,
  };
}

interface FocusProjection {
  focus: string | null;
  nextAction: OrientationNextAction;
  scoped: ScopedSignals;
  reads: Array<{ path: string; reason: string; priority: number }>;
  inboxUnacked: number;
  viewPresent: boolean;
  passport: Passport | null;
  passportSource?: PassportSource;
  watermarkAdvanced: boolean;
}

/**
 * Shared projection behind both the text and --json focus output, so the two
 * never drift. Pure read over an already-built ContinuityReport.
 */
function focusProjection(report: ContinuityReport): FocusProjection {
  const me = report.passport?.agent_id;
  const workspaceFocus = (report.view.brief as { workspace?: { current_focus?: string } } | undefined)?.workspace?.current_focus;
  const inProgressTask = me
    ? report.view.activeTasks.find((t) => t.owner === me && t.status === "in_progress")
    : undefined;
  const reads = (
    (report.view.brief as { manifest?: { recommended_reads?: Array<{ path: string; reason: string; priority: number }> } } | undefined)
      ?.manifest?.recommended_reads ?? []
  )
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3);
  return {
    focus:
      workspaceFocus ??
      report.view.currentRun?.goal ??
      inProgressTask?.title ??
      report.view.latestPacket?.mission ??
      null,
    nextAction: report.orientation.next_action,
    scoped: scopeSignalsToFocus(report),
    reads,
    inboxUnacked: report.inbox.unacked.length,
    viewPresent: report.view.present,
    passport: report.passport,
    passportSource: report.passportSource,
    watermarkAdvanced: report.watermarkAdvanced,
  };
}

/**
 * Render the compact, mission-scoped pre-flight packet (~400 tokens): identity,
 * focus, the single next action, only the collisions touching that focus, the
 * top recommended reads, and an inbox flag. A cheap first read before the agent
 * decides whether it needs full `seed continuity`.
 */
export function renderFocus(report: ContinuityReport): string {
  const fp = focusProjection(report);
  const p = fp.passport;
  const agent = p?.agent_id ?? p?.name ?? "(no passport yet)";
  const lines: string[] = [];

  lines.push(`# Focus — ${agent}`);
  if (p) lines.push(`  acting as: ${p.agent_id}${formatPassportSourceTag(fp.passportSource)}`);
  lines.push(`  focus: ${fp.focus ?? "(no focus recorded)"}`);
  lines.push(`  next:  ${formatNextAction(fp.nextAction)}`);

  if (fp.viewPresent) {
    const s = fp.scoped;
    if (!s.hasFocusTargets) {
      lines.push(
        `  collisions: ${s.elsewhere === 0 ? "none" : `${s.elsewhere} active signal(s) — no current run to scope against (\`seed continuity\`)`}`,
      );
    } else if (s.relevant.length === 0) {
      lines.push(`  collisions: none touching your focus${s.elsewhere > 0 ? ` (${s.elsewhere} elsewhere)` : ""}`);
    } else {
      lines.push("  collisions:");
      for (const sig of s.relevant.slice(0, 5)) {
        const lock = sig.type === "lock" ? "🔒 " : "";
        const owner = sig.owner ? ` (${sig.owner})` : "";
        const intent = sig.intent ? ` — ${truncate(sig.intent, 50)}` : "";
        lines.push(`    - ${lock}${sig.target}${owner}${intent}`);
      }
      if (s.elsewhere > 0) lines.push(`    (+${s.elsewhere} elsewhere — \`seed continuity\`)`);
    }
  }

  if (fp.viewPresent && fp.reads.length > 0) {
    lines.push("  reads:");
    for (const r of fp.reads) lines.push(`    - ${r.path} — ${truncate(r.reason, 70)}`);
  }

  if (fp.inboxUnacked > 0) {
    lines.push(`  inbox: ⚠ ${fp.inboxUnacked} unacked mention(s) — \`seed inbox\``);
  }

  lines.push("");
  return lines.join("\n");
}

function renderContinuityFull(report: ContinuityReport): string {
  const lines: string[] = [];
  const p = report.passport;
  const agent = p?.agent_id ?? p?.name ?? "(no passport yet)";
  const since = report.since;
  const sinceMs = since ? new Date(since).getTime() : undefined;
  const isNew = (iso?: string): boolean => {
    if (!sinceMs || !iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t > sinceMs;
  };

  lines.push(`# Continuity — ${agent}`);
  if (since) {
    lines.push(`_since last seen ${humanAge(since)}_`);
  } else if (report.watermarkAdvanced) {
    lines.push(`_first run on this agent_`);
  }
  lines.push("");

  lines.push("## Identity");
  if (p) {
    lines.push(`  acting as: ${p.agent_id}${formatPassportSourceTag(report.passportSource)}`);
    if (p.name && p.name !== p.agent_id) lines.push(`  name: ${p.name}`);
    if (p.purpose) lines.push(`  purpose: ${p.purpose}`);
    if (p.issued_by) lines.push(`  issued_by: ${p.issued_by}`);
    if (p.autonomous) lines.push(`  autonomous: true`);
    lines.push(`  passport: ${formatPassportLocation(report.passportPath)}`);
    lines.push(`  active_projects: ${p.active_projects?.length ?? 0}`);
  } else {
    lines.push(`  (none — run \`seed bootstrap --name <n> --purpose "<p>"\`)`);
  }
  lines.push("");

  if (report.inbox.fetched && report.inbox.unacked.length > 0) {
    const unacked = report.inbox.unacked;
    const newCount = unacked.filter((m) => isNew(m.created_at)).length;
    const oldest = unacked[0];
    const age = oldest ? humanAge(oldest.created_at) : "?";
    const header = newCount > 0
      ? `## Inbox — ${unacked.length} unacked (${newCount} new, oldest ${age})`
      : `## Inbox — ${unacked.length} unacked${unacked.length > 1 ? ` (oldest ${age})` : ""}`;
    lines.push(header);
    for (const m of unacked.slice(0, 3)) {
      const sender = m.sender_principal_chain && m.sender_principal_chain.length > 1
        ? `${m.sender_principal_chain[0]} (via ${m.sender_principal_chain.slice(1).join(" ← ")})`
        : m.sender_passport_id;
      const where = m.space_name ? ` in #${m.space_name}` : "";
      const marker = isNew(m.created_at) ? " ⭑" : "";
      lines.push(`  - [${m.id.slice(0, 8)}]${marker} ${sender}${where}: ${truncate(m.content, 100)}`);
    }
    if (unacked.length > 3) {
      lines.push(`  …and ${unacked.length - 3} more. \`seed inbox\` to read all.`);
    }
    lines.push(`  → ack with: seed inbox ack <id> [--result done|deferred|ignored]`);
    lines.push("");
  }

  lines.push(`## Where you are`);
  lines.push(`  cwd: ${report.cwd}`);
  if (report.root !== report.cwd) lines.push(`  root: ${report.root} (${report.rootKind})`);
  if (report.view.present) {
    const m = report.view.manifest;
    lines.push(`  view: present (workspace_id: ${m?.workspace_id ?? "?"}, ${m?.files_count ?? m?.files?.length ?? 0} tracked files)`);
    if (report.view.brief?.success?.level) {
      const success = report.view.brief.success;
      lines.push(`  view success: ${success.level}${success.label ? ` ${success.label}` : ""}${success.required_level ? ` (requires ${success.required_level})` : ""}`);
    }
    const workspaceFocus = (report.view.brief as { workspace?: { current_focus?: string } } | undefined)?.workspace?.current_focus;
    if (workspaceFocus) {
      lines.push(`  focus: ${workspaceFocus}`);
    }
    const gitStatus = report.view.brief?.git_status;
    if (gitStatus?.is_dirty) {
      const sample = (gitStatus.uncommitted_paths ?? []).slice(0, 3).join(", ");
      const more = gitStatus.uncommitted_count > 3 ? `, +${gitStatus.uncommitted_count - 3} more` : "";
      lines.push(`  git: ${gitStatus.uncommitted_count} uncommitted (${sample}${more})`);
    } else if (gitStatus?.is_repo) {
      lines.push(`  git: clean`);
    }
    if (report.view.signals.length > 0) {
      lines.push(`  open signals: ${report.view.signals.length}`);
      for (const s of report.view.signals.slice(0, 5)) {
        lines.push(`    - [${s.type}] ${s.target} — ${s.intent ?? "(no intent)"}`);
      }
    } else {
      lines.push(`  open signals: 0`);
    }
    if (report.view.latestPacket) {
      const pkt = report.view.latestPacket;
      lines.push(`  last continuity packet: ${pkt.created_at ?? "?"}`);
      if (pkt.mission) lines.push(`    mission: ${pkt.mission}`);
      if (pkt.summary) lines.push(`    summary: ${pkt.summary}`);
      if (pkt.git_status?.is_dirty) {
        const sample = (pkt.git_status.uncommitted_paths ?? []).slice(0, 3).join(", ");
        const more = pkt.git_status.uncommitted_count > 3 ? `, +${pkt.git_status.uncommitted_count - 3} more` : "";
        lines.push(`    git at write: ${pkt.git_status.uncommitted_count} uncommitted (${sample}${more})`);
      }
      if (pkt.next_actions?.length) {
        lines.push(`    next_actions:`);
        for (const a of pkt.next_actions) lines.push(`      - ${a}`);
      }
    }
    if (report.view.currentRun) {
      const run = report.view.currentRun;
      lines.push(`  current run: ${run.run_id}`);
      lines.push(`    goal: ${run.goal}`);
      if (run.validation?.length) {
        const latestValidation = run.validation.at(-1);
        lines.push(`    latest validation: ${latestValidation?.status ?? "unknown"} — ${latestValidation?.command ?? ""}`);
      }
    }
    const myAgentId = report.passport?.agent_id;
    const yoursActive = report.view.activeTasks.filter((t) => t.owner === myAgentId && t.status !== "open");
    const pendingAccept = report.view.activeTasks.filter((t) => t.owner === myAgentId && t.assigned_by && t.assigned_by !== myAgentId);
    if (yoursActive.length > 0) {
      lines.push(`  your tasks: ${yoursActive.length}`);
      for (const task of yoursActive.slice(0, 3)) {
        const from = task.from_knowledge ? ` (from ${task.from_knowledge})` : "";
        lines.push(`    - [${task.task_id.slice(0, 8)}] ${task.status}: ${truncate(task.title, 80)}${from}`);
      }
    }
    if (pendingAccept.length > 0) {
      lines.push(`  assigned to you (pending accept): ${pendingAccept.length}`);
      for (const task of pendingAccept.slice(0, 3)) {
        lines.push(`    - [${task.task_id.slice(0, 8)}] by ${task.assigned_by}: ${truncate(task.title, 80)}`);
      }
    }
    if (report.view.openTasksCount > 0) {
      lines.push(`  open tasks (unclaimed): ${report.view.openTasksCount}`);
    }
    if (report.view.otherAgents.length > 0) {
      lines.push(`  other agents:`);
      for (const other of report.view.otherAgents) {
        for (const run of other.active_runs.slice(0, 1)) {
          const paths = run.changed_paths.slice(0, 3).join(", ");
          const morePaths = run.changed_paths.length > 3 ? `, +${run.changed_paths.length - 3} more` : "";
          lines.push(`    ${other.agent_id}: active run "${truncate(run.goal, 60)}" (${run.run_id.slice(0, 8)}${paths ? `, ${paths}${morePaths}` : ""})`);
        }
        for (const task of other.in_progress_tasks.slice(0, 1)) {
          lines.push(`    ${other.agent_id}: task "${truncate(task.title, 60)}" in_progress (${task.task_id.slice(0, 8)})`);
        }
        for (const claim of other.claims.slice(0, 1)) {
          lines.push(`    ${other.agent_id}: claim on ${claim.target} (intent: "${truncate(claim.intent, 50)}")`);
        }
      }
    }
  } else {
    lines.push(`  view: absent`);
  }
  lines.push("");

  appendGoverningRecords(lines, report, 5);

  if (p?.active_projects?.length) {
    lines.push(`## Active projects`);
    for (const proj of p.active_projects) {
      const here = proj.root === report.root || proj.root === report.cwd ? " ← you are here" : "";
      const marker = isNew(proj.last_seen_at) ? " ⭑" : "";
      lines.push(`  - ${proj.id}${marker} @ ${proj.root}${here}`);
      if (proj.current_focus) lines.push(`      focus: ${proj.current_focus}`);
      if (proj.space) lines.push(`      space: ${proj.space}`);
      if (proj.last_seen_at) lines.push(`      last_seen: ${proj.last_seen_at}`);
    }
    lines.push("");
  }

  lines.push(`## Daemon`);
  lines.push(`  url: ${report.daemon.url}`);
  lines.push(`  reachable: ${report.daemon.reachable ? "yes" : "no"}`);
  if (report.daemon.reachable) {
    const online = report.daemon.presence.filter((p) => p.online);
    lines.push(`  presence: ${online.length} online of ${report.daemon.presence.length} session(s)`);
    for (const sess of online.slice(0, 5)) {
      lines.push(`    - ${sess.passport_id}${sess.working_on ? ` — ${sess.working_on}` : ""}`);
    }
  }
  lines.push("");

  if (report.joinedSpaces.length > 0) {
    lines.push(`## Joined spaces`);
    for (const s of report.joinedSpaces) {
      lines.push(`  ${s.name}`);
      if (s.unreachable) {
        lines.push(`    (could not fetch messages)`);
        continue;
      }
      if (s.recentMessages.length === 0) {
        lines.push(`    (no messages yet)`);
      } else {
        const newCount = s.recentMessages.filter((m) => isNew(m.created_at)).length;
        if (newCount > 0) {
          lines.push(`    (${newCount} new since you were last here)`);
        }
        for (const m of s.recentMessages) {
          const t = m.created_at?.slice(0, 19) ?? "?";
          const marker = isNew(m.created_at) ? " ⭑" : "";
          lines.push(`    [${t}]${marker} ${formatAuthor(m)}: ${truncate(m.content, 100)}`);
        }
      }
    }
    lines.push("");
  }

  lines.push(`## Next move`);
  lines.push(`  ${formatNextAction(report.orientation.next_action)}`);
  lines.push("");

  if (report.warnings.length > 0) {
    lines.push(`## Heads-up`);
    for (const warning of report.warnings) {
      const referent = continuityWarningReferent(warning);
      for (const claim of splitContinuityClaims(warning)) {
        lines.push(`  Warning about ${referent}: ${claim}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function appendGoverningRecords(
  lines: string[],
  report: ContinuityReport,
  limit: number,
): void {
  const packet = report.view.latestPacket;
  if (!packet?.id || !packet.decisions?.length) return;
  lines.push("## Governing records");
  const claims = packet.decisions.flatMap(splitContinuityClaims).slice(0, limit);
  for (const claim of claims) {
    lines.push(`  Governing record: continuity ${packet.id} — ${claim}`);
  }
  lines.push("");
}

export function splitContinuityClaims(value: string): string[] {
  return value
    .split(/\s*;\s*|(?<=[.!?])\s+(?=[A-Z`])/u)
    .map((claim) => claim.trim())
    .filter(Boolean);
}

export function continuityWarningReferent(warning: string): string {
  if (/^No passport at /i.test(warning)) {
    return warning.slice("No passport at ".length).split(". Run `seed", 1)[0]!.trim();
  }
  if (/^No \.seedrop\/view in /i.test(warning)) {
    return `.seedrop/view in ${warning.slice("No .seedrop/view in ".length).split(". Run `seed", 1)[0]!.trim()}`;
  }
  const daemon = warning.match(/^(Space daemon at \S+)/i)?.[1];
  if (daemon) return daemon.replace(/[.,]$/, "");
  if (/^View preflight\b/i.test(warning)) return "View preflight";
  return "Seedrop continuity state";
}

export function selectNextAction(report: Omit<ContinuityReport, "orientation">): OrientationNextAction {
  const p = report.passport;
  if (!p) {
    return {
      kind: "setup",
      command: "seed bootstrap --name <name> --purpose \"<purpose>\"",
      reason: "Create a Seedrop passport for this machine before orienting work.",
      source: "identity",
      risk: "low",
      requires_human: true,
    };
  }
  if (!report.view.present) {
    const project = nearestActiveProject(report.passport?.active_projects ?? [], report.cwd);
    if (sameDirectory(report.cwd, homedir()) && project) {
      return {
        kind: "setup",
        command: `cd ${project.root} && seed bootstrap`,
        reason: `Home directory has no repo View. Use active project ${project.id} at ${project.root}.`,
        source: "view",
        risk: "low",
        requires_human: false,
      };
    }
    return {
      kind: "setup",
      command: "seed bootstrap",
      reason: "Create and link `.seedrop/view` for this root.",
      source: "view",
      risk: "low",
      requires_human: false,
    };
  }

  const myAgentId = report.passport?.agent_id;

  // In-progress task with no current run → start tracking it. Structured task
  // state beats an inbox DM: committed work outranks new chatter.
  if (myAgentId && !report.view.currentRun) {
    const inProgress = report.view.activeTasks.find(
      (t) => t.owner === myAgentId && t.status === "in_progress",
    );
    if (inProgress) {
      const shortId = inProgress.task_id.slice(0, 8);
      return {
        kind: "run",
        command: `seed run start --task ${inProgress.task_id} --goal "${inProgress.title}"`,
        reason: `Continue in-progress task [${shortId}] "${truncate(inProgress.title, 80)}" — no run is tracking it yet.`,
        source: "run",
        risk: "medium",
        requires_human: false,
      };
    }
  }

  if (report.inbox.unacked.length > 0) {
    const oldest = report.inbox.unacked[0]!;
    return {
      kind: "inbox",
      command: `seed inbox ack ${oldest.id.slice(0, 8)} --result done`,
      reason: `Process inbox: ${report.inbox.unacked.length} unacked mention(s). Start with [${oldest.id.slice(0, 8)}] from ${oldest.sender_passport_id}.`,
      source: "inbox",
      risk: "medium",
      requires_human: false,
    };
  }

  if (report.view.signals.length > 0) {
    const signal = report.view.signals[0]!;
    return {
      kind: "signal",
      command: `seed view signals`,
      reason: `Resolve open signal: ${signal.target} (${signal.intent ?? "no intent"}).`,
      source: "signal",
      risk: signal.type === "lock" ? "high" : "medium",
      requires_human: false,
    };
  }

  const latestValidation = report.view.currentRun?.validation?.at(-1) ?? report.view.latestRun?.validation?.at(-1);
  if (latestValidation?.status === "failed") {
    return {
      kind: "verify",
      command: latestValidation.command,
      reason: `Resolve failed validation from the latest run: ${latestValidation.command}.`,
      source: "run",
      risk: "high",
      requires_human: false,
    };
  }

  if (report.view.latestRun?.status === "blocked" || report.view.latestRun?.status === "failed") {
    return {
      kind: "run",
      command: "seed run finish --status blocked --handoff-to <agent> --handoff-note \"...\"",
      reason: `Latest run is ${report.view.latestRun.status}: ${report.view.latestRun.goal}. Hand off as an assigned task.`,
      source: "run",
      risk: report.view.latestRun.status === "failed" ? "high" : "medium",
      requires_human: false,
    };
  }

  if (report.view.currentRun) {
    const run = report.view.currentRun;
    const action = run.next_actions?.[0];
    return {
      kind: "run",
      command: action?.command ?? `seed run log --summary "..."`,
      reason: action ? `Continue current run "${run.goal}": ${action.reason}.` : `Continue current run "${run.goal}", then log progress.`,
      source: "run",
      risk: "medium",
      requires_human: false,
    };
  }

  // Claimed task ready to start. Surface the task's own state — including open
  // blockers — instead of any DM that might have nudged the work.
  const taskLookup = [...report.view.activeTasks, ...report.view.blockerTasks];
  if (myAgentId) {
    const claimed = report.view.activeTasks.find(
      (t) => t.owner === myAgentId && t.status === "claimed",
    );
    if (claimed) {
      const shortId = claimed.task_id.slice(0, 8);
      const openBlockers = openTaskBlockers(claimed, taskLookup);
      if (openBlockers.length > 0) {
        return {
          kind: "run",
          command: `seed task show ${openBlockers[0]!.slice(0, 8)}`,
          reason: `Task [${shortId}] "${truncate(claimed.title, 80)}" is blocked by ${openBlockers.length === 1 ? "" : `${openBlockers.length} tasks, starting with `}${openBlockers[0]!.slice(0, 8)}. Resolve blockers first.`,
          source: "run",
          risk: "medium",
          requires_human: false,
        };
      }
      const assignedFrom = claimed.assigned_by && claimed.assigned_by !== myAgentId ? ` (assigned by ${claimed.assigned_by})` : "";
      return {
        kind: "run",
        command: `seed task start ${claimed.task_id}`,
        reason: `Start claimed task [${shortId}] "${truncate(claimed.title, 80)}"${assignedFrom}.`,
        source: "run",
        risk: "medium",
        requires_human: false,
      };
    }
  }

  // Unclaimed queue: open, unblocked tasks are queued work — never report
  // "no queued work" while the View holds tasks anyone could claim.
  const unclaimedReady = report.view.activeTasks.filter(
    (t) => t.status === "open" && openTaskBlockers(t, taskLookup).length === 0,
  );
  if (unclaimedReady.length > 0) {
    const next = unclaimedReady[0]!;
    const shortId = next.task_id.slice(0, 8);
    return {
      kind: "run",
      command: `seed task claim ${shortId}`,
      reason: `${unclaimedReady.length} unclaimed task(s) queued. Claim [${shortId}] "${truncate(next.title, 80)}".`,
      source: "run",
      risk: "low",
      requires_human: false,
    };
  }

  const pkt = report.view.latestPacket;
  if (pkt?.next_actions?.length) {
    return {
      kind: "continuity",
      reason: `Continue last continuity packet: "${pkt.next_actions[0]}".`,
      source: "continuity",
      risk: "low",
      requires_human: false,
    };
  }

  const lastMsg = report.joinedSpaces.flatMap((s) => s.recentMessages).slice(-1)[0];
  if (lastMsg && p.agent_id && lastMsg.author_passport_id !== p.agent_id) {
    return {
      kind: "space",
      command: "seed space messages <space>",
      reason: `Reply to ${lastMsg.author_passport_id} in space: "${truncate(lastMsg.content, 60)}".`,
      source: "space",
      risk: "low",
      requires_human: false,
    };
  }

  return {
    kind: "focus",
    command: `seed run start --goal "..."`,
    reason: `No queued work. Pick a focus, then start a run or log orientation.`,
    source: "view",
    risk: "low",
    requires_human: false,
  };
}

function openTaskBlockers(task: ViewTask, lookup: ViewTask[]): string[] {
  return (task.blocked_by ?? []).filter((blockerId) => {
    const blocker = lookup.find((t) => t.task_id === blockerId);
    // If the blocker can't be read, assume it's open (we can't see its state).
    return !blocker || (blocker.status !== "done" && blocker.status !== "dropped");
  });
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function nearestActiveProject(projects: NonNullable<Passport["active_projects"]>, cwd: string): NonNullable<Passport["active_projects"]>[number] | undefined {
  return projects
    .filter((project) => typeof project.root === "string" && project.root.length > 0)
    .sort((a, b) => activeProjectRank(b, cwd) - activeProjectRank(a, cwd))[0];
}

function activeProjectRank(project: NonNullable<Passport["active_projects"]>[number], cwd: string): number {
  const root = resolve(project.root);
  const base = resolve(cwd);
  const underCwd = root === base || root.startsWith(`${base}/`) ? 1_000_000 : 0;
  const seen = project.last_seen_at ? new Date(project.last_seen_at).getTime() : 0;
  return underCwd + (Number.isFinite(seen) ? seen / 1_000_000_000 : 0);
}

function buildOrientation(report: Omit<ContinuityReport, "orientation">, viewPreflightFailed: boolean): OrientationReport {
  const latestRun = report.view.latestRun ?? report.view.currentRun;
  return {
    schema_version: "1.0",
    identity: {
      present: report.passport !== null,
      agent_id: report.passport?.agent_id ?? null,
      passport_path: report.passportPath,
      source: report.passport ? "passport" : "missing",
    },
    place: {
      cwd: report.cwd,
      root: report.root,
      root_kind: report.rootKind,
      view_present: report.view.present,
      workspace_id: report.view.manifest?.workspace_id ?? null,
    },
    traces: {
      latest_continuity_at: report.view.latestPacket?.created_at ?? null,
      current_run_id: report.view.currentRun?.run_id ?? null,
      current_run_goal: report.view.currentRun?.goal ?? null,
      latest_run_status: latestRun?.status ?? null,
      open_signals: report.view.signals.length,
    },
    coordination: {
      daemon_reachable: report.daemon.reachable,
      inbox_unacked: report.inbox.unacked.length,
      joined_spaces: report.joinedSpaces.map((space) => space.name),
      online_sessions: report.daemon.presence.filter((presence) => presence.online).length,
    },
    health: {
      warnings: report.warnings,
      view_preflight_failed: viewPreflightFailed,
      view_success_level: report.view.brief?.success?.level ?? null,
      view_success_required: report.view.brief?.success?.required_level ?? null,
      view_success_meets_required: report.view.brief?.success?.meets_required ?? null,
    },
    next_action: selectNextAction(report),
  };
}

function formatNextAction(action: OrientationNextAction): string {
  return action.command ? `${action.reason} Run: \`${action.command}\`.` : action.reason;
}

function resolveOrientationRoot(cwd: string): { root: string; kind: "git" | "folder" } {
  const absolute = resolve(cwd);
  const result = spawnSync("git", ["-C", absolute, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const gitRoot = result.status === 0 ? result.stdout.trim() : "";
  return gitRoot ? { root: resolve(gitRoot), kind: "git" } : { root: absolute, kind: "folder" };
}

function rootKindFor(cwd: string, root: string): "git" | "folder" {
  return resolveOrientationRoot(cwd).root === resolve(root) ? resolveOrientationRoot(cwd).kind : "folder";
}

function humanAge(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "?";
  const diffMs = Date.now() - ts;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function formatPassportSourceTag(source: PassportSource | undefined): string {
  if (!source) return "";
  if (source === "active") return " (via active passport — `seed login`)";
  if (source === "env") return " (via SEEDROP_PASSPORT env)";
  return " (operator default)";
}

export function formatPassportLocation(absPath: string): string {
  const home = homedir();
  if (absPath.startsWith(`${home}/`) || absPath === home) {
    return `~${absPath.slice(home.length)}`;
  }
  return absPath;
}

function formatAuthor(m: SpaceMessage): string {
  const chain = m.principal_chain ?? [m.author_passport_id];
  if (m.author_autonomous) return `${chain[0]} [autonomous]`;
  if (chain.length <= 1) return chain[0] ?? m.author_passport_id;
  const tail = chain.slice(1).join(" ← ");
  return `${chain[0]} (via ${tail})`;
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readViewSignals(dir: string): Promise<ViewSignal[]> {
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir);
    const signals: ViewSignal[] = [];
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const sig = await readJson<ViewSignal>(join(dir, entry));
      if (!sig) continue;
      if (sig.expires_at && new Date(sig.expires_at).getTime() < now) continue;
      signals.push(sig);
    }
    return signals;
  } catch {
    return [];
  }
}

async function readLatestContinuity(dir: string): Promise<ContinuityPacket | null> {
  if (!existsSync(dir)) return null;
  try {
    const entries = await readdir(dir);
    const sorted = entries.filter((e) => e.endsWith(".json")).sort();
    const latest = sorted[sorted.length - 1];
    if (!latest) return null;
    return await readJson<ContinuityPacket>(join(dir, latest));
  } catch {
    return null;
  }
}

async function readViewRuns(dir: string): Promise<ViewRun[]> {
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir);
    const runs: ViewRun[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const run = await readJson<ViewRun>(join(dir, entry));
      if (run?.run_id && run.agent_id && run.status) runs.push(run);
    }
    return runs.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  } catch {
    return [];
  }
}

async function fetchJson<T>(url: string, passportId?: string): Promise<T | null> {
  return (await fetchJsonResult<T>(url, passportId)).value;
}

async function fetchJsonResult<T>(url: string, passportId?: string): Promise<FetchJsonResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: passportId ? { "x-seedrop-passport": passportId } : {},
    });
    if (!response.ok) {
      return { value: null, errorKind: "http_error", errorMessage: `HTTP ${response.status}` };
    }
    return { value: (await response.json()) as T };
  } catch (error) {
    return {
      value: null,
      errorKind: classifyFetchError(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyFetchError(error: unknown): FetchErrorKind {
  if (isAbortError(error)) return "timeout";
  if (errorChain(error).some((record) => record.code === "EPERM" || record.errno === "EPERM")) {
    return "sandbox_denied";
  }
  return "fetch_failed";
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError";
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    const record = current as Record<string, unknown>;
    records.push(record);
    current = record.cause;
  }
  return records;
}

async function postJson(url: string, body: unknown, passportId: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-seedrop-passport": passportId },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
  } catch {
    // Best-effort; never block continuity on a side-effect failure.
  }
}

export async function runContinuity(
  argv: readonly string[],
  io: RunCliIO,
  opts: { defaultPassport: string; defaultPassportSource?: PassportSource; defaultUrl: string },
): Promise<number> {
  // If --passport overrides the default, the resolution source from the
  // outer resolver no longer describes what we're using. Treat an explicit
  // override as "env-equivalent" (an out-of-band, caller-supplied path).
  const explicit = readFlag(argv, "passport");
  const passportPath = explicit ?? opts.defaultPassport;
  const passportSource: PassportSource = explicit ? "env" : (opts.defaultPassportSource ?? "operator");
  const spaceUrl = readFlag(argv, "url") ?? opts.defaultUrl;
  const cwd = resolve(readFlag(argv, "cwd") ?? process.cwd());
  const place = resolveOrientationRoot(cwd);
  const json = argv.includes("--json");
  const peek = argv.includes("--peek");
  const since = readFlag(argv, "since");
  const mode: ContinuityRenderMode = argv.includes("--full") ? "full" : argv.includes("--medium") ? "medium" : "brief";
  const limit = Number(readFlag(argv, "messages") ?? "5");

  const budgetFlag = readFlag(argv, "budget");
  const budgetBytes = budgetFlag === undefined ? undefined : Number(budgetFlag);
  if (budgetBytes !== undefined && (!Number.isFinite(budgetBytes) || budgetBytes < 0)) {
    io.stderr.write(`--budget must be a non-negative byte count (got '${budgetFlag}').\n`);
    return 1;
  }

  const report = await buildContinuity({ passportPath, passportSource, spaceUrl, cwd, root: place.root, rootKind: place.kind, messageLimit: limit, json, peek, since });
  if (json) {
    if (budgetBytes) {
      // Budgeted output is compact: indentation would spend the budget on whitespace.
      io.stdout.write(JSON.stringify(applyContinuityBudget(report, budgetBytes)) + "\n");
    } else {
      io.stdout.write(JSON.stringify(report, null, 2) + "\n");
    }
  } else {
    io.stdout.write(renderContinuity(report, mode));
  }
  return 0;
}

/**
 * Trim a continuity report to a compact-JSON byte budget at print time. The
 * report has already been routed, so trimming here cannot starve the router —
 * it only shrinks what the caller pays to read.
 */
export function applyContinuityBudget(
  report: ContinuityReport,
  limitBytes: number,
): ContinuityReport & { budget?: { limit_bytes: number; bytes: number; stages_applied: string[]; exceeded: boolean } } {
  const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(report) <= limitBytes) {
    return { ...report, budget: { limit_bytes: limitBytes, bytes: size(report), stages_applied: [], exceeded: false } };
  }
  const out = structuredClone(report) as ContinuityReport & { budget?: { limit_bytes: number; bytes: number; stages_applied: string[]; exceeded: boolean } };
  const applied: string[] = [];
  const stages: Array<{ id: string; apply: () => boolean }> = [
    {
      id: "task_descriptions_truncated",
      apply: () => {
        let touched = false;
        for (const task of [...out.view.activeTasks, ...out.view.blockerTasks] as Array<{ description?: string }>) {
          if (task.description && task.description.length > 160) {
            task.description = `${task.description.slice(0, 159)}…`;
            touched = true;
          }
        }
        return touched;
      },
    },
    {
      id: "space_messages_capped",
      apply: () => {
        let touched = false;
        for (const space of out.joinedSpaces) {
          if (space.recentMessages.length > 3) {
            space.recentMessages = space.recentMessages.slice(-3);
            touched = true;
          }
        }
        return touched;
      },
    },
    {
      id: "active_tasks_capped",
      apply: () => {
        if (out.view.activeTasks.length <= 8) return false;
        out.view.activeTasks = out.view.activeTasks.slice(0, 8);
        return true;
      },
    },
  ];
  for (const stage of stages) {
    if (size(out) <= limitBytes) break;
    if (stage.apply()) applied.push(stage.id);
  }
  const bytes = size(out);
  out.budget = { limit_bytes: limitBytes, bytes, stages_applied: applied, exceeded: bytes > limitBytes };
  return out;
}

export async function runFocus(
  argv: readonly string[],
  io: RunCliIO,
  opts: { defaultPassport: string; defaultPassportSource?: PassportSource; defaultUrl: string },
): Promise<number> {
  // Mirrors runContinuity's resolution, but focus is a cheap pre-flight: it
  // NEVER advances the continuity watermark (peek: true), so calling it does
  // not consume "what's new since I last looked".
  const explicit = readFlag(argv, "passport");
  const passportPath = explicit ?? opts.defaultPassport;
  const passportSource: PassportSource = explicit ? "env" : (opts.defaultPassportSource ?? "operator");
  const spaceUrl = readFlag(argv, "url") ?? opts.defaultUrl;
  const cwd = resolve(readFlag(argv, "cwd") ?? process.cwd());
  const place = resolveOrientationRoot(cwd);
  const json = argv.includes("--json");

  const report = await buildContinuity({ passportPath, passportSource, spaceUrl, cwd, root: place.root, rootKind: place.kind, peek: true });
  if (json) {
    const fp = focusProjection(report);
    io.stdout.write(
      JSON.stringify(
        {
          agent: report.passport?.agent_id ?? null,
          focus: fp.focus,
          next_action: fp.nextAction,
          collisions: fp.scoped.relevant,
          collisions_elsewhere: fp.scoped.elsewhere,
          reads: fp.reads,
          inbox_unacked: fp.inboxUnacked,
          watermark_advanced: fp.watermarkAdvanced,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    io.stdout.write(renderFocus(report));
  }
  return 0;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) return undefined;
    return next;
  }
  return undefined;
}
