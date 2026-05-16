import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceView, type ViewCheck } from "@seedrop/space";
import { readContinuityState, writeContinuityState } from "./continuity-state.js";
import type { RunCliIO } from "./router.js";

export interface ContinuityOptions {
  passportPath: string;
  spaceUrl: string;
  cwd: string;
  messageLimit?: number;
  json?: boolean;
  /** ISO-8601 watermark to compare against. If omitted, reads the per-agent state file. */
  since?: string;
  /** When false (default), the watermark is advanced to "now" after the report is built. */
  peek?: boolean;
}

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
  files?: Array<{ path: string }>;
  updated_at?: string;
}

interface ViewSignal {
  id: string;
  type: "claim" | "lock";
  target: string;
  intent?: string;
  owner?: string;
  created_at?: string;
  expires_at?: string;
}

interface ContinuityPacket {
  mission?: string;
  summary?: string;
  next_actions?: string[];
  open_threads?: string[];
  validation?: { status?: string; commands?: string[] };
  created_at?: string;
}

interface ViewRun {
  run_id: string;
  agent_id: string;
  goal: string;
  status: "in_progress" | "completed" | "blocked" | "failed";
  started_at?: string;
  updated_at?: string;
  open_threads?: string[];
  validation?: Array<{ command: string; status: string; recorded_at: string }>;
  next_actions?: Array<{ command?: string; reason: string; kind: string }>;
}

interface ViewHandoff {
  handoff_id: string;
  source_agent: string;
  recipient: string;
  summary: string;
  status: "pending" | "accepted";
  created_at?: string;
  open_threads?: string[];
  next_actions?: Array<{ command?: string; reason: string; kind: string }>;
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

export interface ContinuityReport {
  passportPath: string;
  passport: Passport | null;
  cwd: string;
  /** Prior watermark (ISO-8601) — what the agent saw last time, or undefined on first call. */
  since?: string;
  /** Whether the watermark was advanced (false when --peek). */
  watermarkAdvanced: boolean;
  view: {
    present: boolean;
    manifest?: ViewManifest;
    signals: ViewSignal[];
    latestPacket?: ContinuityPacket;
    currentRun?: ViewRun;
    pendingHandoffs: ViewHandoff[];
  };
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
}

export async function buildContinuity(opts: ContinuityOptions): Promise<ContinuityReport> {
  const warnings: string[] = [];
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

  const viewContext = await WorkspaceView.open({
    root: opts.cwd,
    agent: passport?.agent_id ?? "agent",
  }).context();
  const viewPresent = viewContext.view?.present ?? false;
  const manifest = viewContext.manifest as ViewManifest | undefined;
  const signals = (viewContext.active_signals ?? []) as ViewSignal[];
  const latestPacket = viewContext.latest_continuity as ContinuityPacket | undefined;
  const currentRun = viewContext.current_run as ViewRun | undefined;
  const pendingHandoffs = (viewContext.pending_handoffs ?? []) as ViewHandoff[];
  if (!viewPresent) {
    warnings.push(`No .seedrop/view in ${opts.cwd}. Run \`seed bootstrap\` to link this repo to your passport.`);
  }
  if (viewContext.preflight?.checks?.some((check: ViewCheck) => check.status === "fail")) {
    warnings.push(`View preflight has failed checks. Run \`seed view preflight --json\` for repair details.`);
  }

  const presence = await fetchJson<{ presence: PresenceRecord[] }>(`${opts.spaceUrl}/presence`);
  const daemonReachable = presence !== null;
  if (!daemonReachable) {
    warnings.push(`Space daemon at ${opts.spaceUrl} is not reachable. Try \`seed daemon status\`.`);
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

  return {
    passportPath: opts.passportPath,
    passport,
    cwd: opts.cwd,
    since,
    watermarkAdvanced,
    view: {
      present: viewPresent,
      manifest,
      signals,
      latestPacket,
      currentRun,
      pendingHandoffs,
    },
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
}

export function renderContinuity(report: ContinuityReport): string {
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
    lines.push(`  agent_id: ${p.agent_id}`);
    if (p.name && p.name !== p.agent_id) lines.push(`  name: ${p.name}`);
    if (p.purpose) lines.push(`  purpose: ${p.purpose}`);
    if (p.issued_by) lines.push(`  issued_by: ${p.issued_by}`);
    if (p.autonomous) lines.push(`  autonomous: true`);
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
  if (report.view.present) {
    const m = report.view.manifest;
    lines.push(`  view: present (workspace_id: ${m?.workspace_id ?? "?"}, ${m?.files?.length ?? 0} tracked files)`);
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
    if (report.view.pendingHandoffs.length > 0) {
      lines.push(`  pending handoffs: ${report.view.pendingHandoffs.length}`);
      for (const handoff of report.view.pendingHandoffs.slice(0, 3)) {
        lines.push(`    - [${handoff.handoff_id.slice(0, 8)}] from ${handoff.source_agent}: ${truncate(handoff.summary, 80)}`);
      }
    }
  } else {
    lines.push(`  view: absent`);
  }
  lines.push("");

  if (p?.active_projects?.length) {
    lines.push(`## Active projects`);
    for (const proj of p.active_projects) {
      const here = proj.root === report.cwd ? " ← you are here" : "";
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
  for (const line of suggestNextMove(report)) lines.push(`  ${line}`);
  lines.push("");

  if (report.warnings.length > 0) {
    lines.push(`## Heads-up`);
    for (const w of report.warnings) lines.push(`  - ${w}`);
    lines.push("");
  }

  return lines.join("\n");
}

function suggestNextMove(report: ContinuityReport): string[] {
  const p = report.passport;
  if (!p) return ["Run `seed bootstrap --name <name> --purpose \"<purpose>\"` to create your passport."];
  if (!report.view.present)
    return ["Run `seed bootstrap` in this repo to link it to your passport and create `.seedrop/view/`."];
  if (!report.daemon.reachable)
    return ["Run `seed daemon status` / `seed daemon install` so the always-on Space coordinator is up."];

  // Inbox takes priority over everything else — process @-mentions first.
  if (report.inbox.unacked.length > 0) {
    const oldest = report.inbox.unacked[0]!;
    return [
      `Process inbox: ${report.inbox.unacked.length} unacked mention(s). Start with [${oldest.id.slice(0, 8)}] from ${oldest.sender_passport_id}.`,
    ];
  }

  const moves: string[] = [];
  if (report.view.signals.length > 0) {
    moves.push(`Resolve open signal: ${report.view.signals[0]?.target} (${report.view.signals[0]?.intent ?? "—"}).`);
  }
  if (report.view.pendingHandoffs.length > 0) {
    const handoff = report.view.pendingHandoffs[0]!;
    moves.push(`Review handoff [${handoff.handoff_id.slice(0, 8)}] from ${handoff.source_agent}: \`seed handoff read ${handoff.handoff_id}\`.`);
  }
  if (report.view.currentRun) {
    const run = report.view.currentRun;
    const action = run.next_actions?.[0];
    if (action) {
      moves.push(`Continue current run "${run.goal}": ${action.command ?? action.reason}.`);
    } else {
      moves.push(`Continue current run "${run.goal}", then log progress with \`seed run log --summary "..."\`.`);
    }
  }
  const pkt = report.view.latestPacket;
  if (pkt?.next_actions?.length) {
    moves.push(`Continue last continuity packet: "${pkt.next_actions[0]}".`);
  }
  const lastMsg = report.joinedSpaces.flatMap((s) => s.recentMessages).slice(-1)[0];
  if (lastMsg && p.agent_id && lastMsg.author_passport_id !== p.agent_id) {
    moves.push(`Reply to ${lastMsg.author_passport_id} in space: "${truncate(lastMsg.content, 60)}".`);
  }
  if (moves.length === 0) {
    moves.push(`No queued work. Pick a focus, then \`seed view log --mission "..." --summary "..."\`.`);
  }
  return moves;
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

async function readViewHandoffs(dir: string): Promise<ViewHandoff[]> {
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir);
    const handoffs: ViewHandoff[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const handoff = await readJson<ViewHandoff>(join(dir, entry));
      if (handoff?.handoff_id && handoff.recipient && handoff.status) handoffs.push(handoff);
    }
    return handoffs.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  } catch {
    return [];
  }
}

async function fetchJson<T>(url: string, passportId?: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: passportId ? { "x-seedrop-passport": passportId } : {},
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
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

export async function runContinuity(argv: readonly string[], io: RunCliIO, opts: { defaultPassport: string; defaultUrl: string }): Promise<number> {
  const passportPath = readFlag(argv, "passport") ?? opts.defaultPassport;
  const spaceUrl = readFlag(argv, "url") ?? opts.defaultUrl;
  const cwd = readFlag(argv, "cwd") ?? process.cwd();
  const json = argv.includes("--json");
  const peek = argv.includes("--peek");
  const since = readFlag(argv, "since");
  const limit = Number(readFlag(argv, "messages") ?? "5");

  const report = await buildContinuity({ passportPath, spaceUrl, cwd, messageLimit: limit, json, peek, since });
  if (json) {
    io.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    io.stdout.write(renderContinuity(report));
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
