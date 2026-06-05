import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { WorkspaceView, type AuditReport } from "@seedrop/space";
import type { PassportSource } from "./active-passport.js";
import { buildContinuity, type ContinuityReport } from "./continuity.js";
import type { RunCliIO } from "./router.js";

export type BootRisk = "low" | "medium" | "high";
export type BootNextActionKind = "setup" | "inbox" | "handoff" | "run" | "verify" | "safety" | "sync" | "focus";
export type BootNextActionSource = "identity" | "view" | "inbox" | "handoff" | "run" | "audit" | "git" | "continuity";
export type BootEvidenceSource = "passport" | "view" | "audit" | "git" | "inbox" | "run" | "handoff" | "daemon" | "continuity";
export type BootLossTerm =
  | "lost_work"
  | "unsafe_context_switch"
  | "unverified_changes"
  | "stale_assumption"
  | "coordination_lag"
  | "duplicate_exploration"
  | "identity_error"
  | "missing_view"
  | "token_time_waste";

export interface BootObjectiveTerm {
  term: BootLossTerm;
  weight: number;
  reason: string;
}

export interface BootNextAction {
  candidate_id: string;
  kind: BootNextActionKind;
  command?: string;
  reason: string;
  source: BootNextActionSource;
  risk: BootRisk;
  requires_human: boolean;
  priority: number;
}

export interface BootCandidate {
  id: string;
  kind: BootNextActionKind;
  command?: string;
  reason: string;
  source: BootNextActionSource;
  risk: BootRisk;
  requires_human: boolean;
  base_priority: number;
  blocks_work: boolean;
  evidence: Array<{
    source: BootEvidenceSource;
    ref?: string;
    summary: string;
  }>;
}

export interface BootDecisionTrace {
  policy_version: "boot-next-action-v1";
  objective_version: "boot-objective-v1";
  generated_at: string;
  winner: string;
  candidates: Array<{
    candidate_id: string;
    kind: BootNextActionKind;
    command?: string;
    reason: string;
    source: BootNextActionSource;
    risk: BootRisk;
    evidence: BootCandidate["evidence"];
    objectives: BootObjectiveTerm[];
    base_priority: number;
    final_priority: number;
    selected: boolean;
    modifiers: Array<{
      rule: string;
      effect: "promote" | "demote" | "suppress" | "block";
      delta?: number;
      reason: string;
    }>;
    rejected_because?: string;
  }>;
}

export type BootOutcomeObservationKind =
  | "run_started"
  | "run_completed"
  | "validation_passed"
  | "validation_failed"
  | "inbox_acked"
  | "handoff_accepted"
  | "identity_created"
  | "view_bootstrapped"
  | "git_clean"
  | "work_preserved"
  | "context_switched"
  | "audit_clean"
  | "audit_failed";

export interface BootOutcomeObservation {
  kind: BootOutcomeObservationKind;
  ref?: string;
  summary?: string;
}

export interface BootOutcomeScore {
  policy_version: "boot-outcome-v1";
  scored_at: string;
  boot_generated_at: string;
  boot_policy_version: BootDecisionTrace["policy_version"];
  boot_objective_version: BootDecisionTrace["objective_version"];
  selected_candidate_id: string;
  selected_kind: BootNextActionKind;
  selected_source: BootNextActionSource;
  status: "reduced_loss" | "mixed" | "increased_loss" | "inconclusive";
  confidence: "high" | "medium" | "low";
  loss_terms: Array<{
    term: BootLossTerm;
    weight: number;
    expected: "reduce" | "avoid" | "inspect";
    observed: "reduced" | "increased" | "unknown";
    evidence: string[];
    rationale: string;
  }>;
  total: {
    reduced_weight: number;
    increased_weight: number;
    unknown_weight: number;
    net_weight: number;
  };
  notes: string[];
}

export interface BootReport {
  schema_version: "1.0";
  generated_at: string;
  identity: {
    present: boolean;
    agent_id: string | null;
    passport_path: string;
    source: PassportSource | "missing";
  };
  place: {
    cwd: string;
    root: string;
    root_kind: "git" | "folder";
    view_present: boolean;
    workspace_id: string | null;
  };
  mission: {
    current_focus: string | null;
    current_run: { run_id: string; goal: string } | null;
    latest_run: { run_id: string; goal: string; status: string } | null;
    latest_continuity: { id: string; mission: string; summary: string; created_at: string | null } | null;
  };
  freshness: {
    manifest: "fresh" | "stale" | "missing" | "invalid" | "unknown";
    knowledge: {
      stale: number;
      superseded: number;
    };
    audit: {
      ok: boolean | null;
      warnings: number;
      errors: number;
    };
  };
  coordination: {
    daemon_reachable: boolean;
    inbox_unacked: number;
    pending_handoffs: number;
    active_signals: number;
    other_agents: number;
  };
  safety: {
    git_dirty: boolean;
    uncommitted_count: number;
    uncommitted_paths: string[];
    preflight_failed: boolean;
    warnings: string[];
  };
  trust: Array<{
    label: "live_local" | "committed_proof" | "stale" | "untrusted" | "sandbox_limited";
    summary: string;
  }>;
  next_action: BootNextAction;
  alternate_actions: BootNextAction[];
  decision_trace: BootDecisionTrace;
  continuity: ContinuityReport["orientation"];
}

export async function buildBootReport(opts: {
  passportPath: string;
  passportSource?: PassportSource;
  spaceUrl: string;
  cwd: string;
  root?: string;
  rootKind?: "git" | "folder";
  messageLimit?: number;
  since?: string;
  peek?: boolean;
}): Promise<BootReport> {
  const place = opts.root && opts.rootKind ? { root: opts.root, kind: opts.rootKind } : resolveOrientationRoot(opts.cwd);
  const continuity = await buildContinuity({
    passportPath: opts.passportPath,
    passportSource: opts.passportSource,
    spaceUrl: opts.spaceUrl,
    cwd: opts.cwd,
    root: place.root,
    rootKind: place.kind,
    messageLimit: opts.messageLimit,
    since: opts.since,
    peek: opts.peek,
  });
  const audit = continuity.view.present
    ? await WorkspaceView.open({ root: continuity.root, agent: continuity.passport?.agent_id ?? "agent" }).audit({ writeCache: false })
    : null;
  return buildBootReportFromContinuity(continuity, audit);
}

export function buildBootReportFromContinuity(continuity: ContinuityReport, audit: AuditReport | null, generatedAt = new Date().toISOString()): BootReport {
  const knowledgeIssues = audit?.issues.filter((issue) => issue.code === "knowledge_stale" || issue.code === "knowledge_superseded") ?? [];
  const report: Omit<BootReport, "next_action" | "alternate_actions" | "decision_trace"> = {
    schema_version: "1.0",
    generated_at: generatedAt,
    identity: {
      present: continuity.passport !== null,
      agent_id: continuity.passport?.agent_id ?? null,
      passport_path: continuity.passportPath,
      source: continuity.passport ? (continuity.passportSource ?? "operator") : "missing",
    },
    place: {
      cwd: continuity.cwd,
      root: continuity.root,
      root_kind: continuity.rootKind,
      view_present: continuity.view.present,
      workspace_id: continuity.view.manifest?.workspace_id ?? null,
    },
    mission: {
      current_focus: continuity.passport?.continuity?.current_focus ?? continuity.passport?.active_projects?.find((project) => sameDirectory(project.root, continuity.root))?.current_focus ?? null,
      current_run: continuity.view.currentRun ? { run_id: continuity.view.currentRun.run_id, goal: continuity.view.currentRun.goal } : null,
      latest_run: continuity.view.latestRun
        ? { run_id: continuity.view.latestRun.run_id, goal: continuity.view.latestRun.goal, status: continuity.view.latestRun.status }
        : null,
      latest_continuity: continuity.view.latestPacket?.id
        ? {
          id: continuity.view.latestPacket.id,
          mission: continuity.view.latestPacket.mission ?? "",
          summary: continuity.view.latestPacket.summary ?? "",
          created_at: continuity.view.latestPacket.created_at ?? null,
        }
        : null,
    },
    freshness: {
      manifest: manifestFreshness(continuity, audit),
      knowledge: {
        stale: knowledgeIssues.filter((issue) => issue.code === "knowledge_stale").length,
        superseded: knowledgeIssues.filter((issue) => issue.code === "knowledge_superseded").length,
      },
      audit: {
        ok: audit?.ok ?? null,
        warnings: audit?.issues.filter((issue) => issue.severity === "warning").length ?? 0,
        errors: audit?.issues.filter((issue) => issue.severity === "error").length ?? 0,
      },
    },
    coordination: {
      daemon_reachable: continuity.daemon.reachable,
      inbox_unacked: continuity.inbox.unacked.length,
      pending_handoffs: continuity.view.pendingHandoffs.length,
      active_signals: continuity.view.signals.length,
      other_agents: continuity.view.otherAgents.length,
    },
    safety: {
      git_dirty: continuity.view.brief?.git_status?.is_dirty ?? false,
      uncommitted_count: continuity.view.brief?.git_status?.uncommitted_count ?? 0,
      uncommitted_paths: continuity.view.brief?.git_status?.uncommitted_paths ?? [],
      preflight_failed: continuity.orientation.health.view_preflight_failed,
      warnings: [
        ...continuity.warnings,
        ...(audit?.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message) ?? []),
      ],
    },
    trust: trustLabels(continuity, audit),
    continuity: continuity.orientation,
  };
  const candidates = collectBootCandidates(report, continuity, audit);
  const evaluation = evaluateBootCandidates(candidates, report, continuity, generatedAt);
  const actions = evaluation.actions;
  return {
    ...report,
    next_action: actions[0] ?? candidateToAction(fallbackCandidate, fallbackCandidate.base_priority),
    alternate_actions: actions.slice(1, 6),
    decision_trace: evaluation.trace,
  };
}

export function resolveBootNextAction(report: BootReport): BootNextAction {
  return report.next_action;
}

export function scoreBootOutcome(
  report: BootReport,
  observations: readonly BootOutcomeObservation[],
  scoredAt = new Date().toISOString(),
): BootOutcomeScore {
  const selected = report.decision_trace.candidates.find((candidate) => candidate.candidate_id === report.decision_trace.winner)
    ?? report.decision_trace.candidates.find((candidate) => candidate.selected);
  const objectives = selected?.objectives.length ? selected.objectives : [{ term: "token_time_waste" as const, weight: 1, reason: "No explicit objective terms were attached to the selected candidate." }];
  const lossTerms = objectives.map((objective) => scoreObjectiveTerm(objective, observations));
  const reducedWeight = sumWeights(lossTerms, "reduced");
  const increasedWeight = sumWeights(lossTerms, "increased");
  const unknownWeight = sumWeights(lossTerms, "unknown");
  return {
    policy_version: "boot-outcome-v1",
    scored_at: scoredAt,
    boot_generated_at: report.generated_at,
    boot_policy_version: report.decision_trace.policy_version,
    boot_objective_version: report.decision_trace.objective_version,
    selected_candidate_id: selected?.candidate_id ?? report.next_action.candidate_id,
    selected_kind: selected?.kind ?? report.next_action.kind,
    selected_source: selected?.source ?? report.next_action.source,
    status: outcomeStatus(reducedWeight, increasedWeight),
    confidence: outcomeConfidence(lossTerms, observations),
    loss_terms: lossTerms,
    total: {
      reduced_weight: reducedWeight,
      increased_weight: increasedWeight,
      unknown_weight: unknownWeight,
      net_weight: reducedWeight - increasedWeight,
    },
    notes: outcomeNotes(report, selected, observations),
  };
}

export function renderBoot(report: BootReport): string {
  const lines = [
    "Seedrop Boot",
    "",
    `Identity: ${report.identity.agent_id ?? "missing"} (${report.identity.source})`,
    `Repo: ${report.place.workspace_id ?? "<unlinked>"} at ${report.place.root}`,
    `View: ${report.place.view_present ? report.continuity.health.view_success_level ?? "present" : "missing"}`,
    `Git: ${report.safety.git_dirty ? `${report.safety.uncommitted_count} uncommitted path(s)` : "clean"}`,
    `Inbox: ${report.coordination.inbox_unacked} unacked`,
    `Handoffs: ${report.coordination.pending_handoffs} pending`,
    `Signals: ${report.coordination.active_signals} active`,
  ];
  if (report.freshness.knowledge.stale + report.freshness.knowledge.superseded > 0) {
    lines.push(`Knowledge: ${report.freshness.knowledge.stale} stale, ${report.freshness.knowledge.superseded} superseded`);
  }
  const staleTrust = report.trust.filter((entry) => entry.label === "stale" || entry.label === "untrusted" || entry.label === "sandbox_limited");
  for (const entry of staleTrust.slice(0, 3)) {
    lines.push(`Risk: ${entry.summary}`);
  }
  lines.push("", "Next action:", `  ${formatBootAction(report.next_action)}`);
  const winner = report.decision_trace.candidates.find((candidate) => candidate.selected);
  if (winner) {
    const notable = winner.modifiers[0]?.reason ?? `Selected by ${report.decision_trace.policy_version} at priority ${winner.final_priority}.`;
    lines.push("", "Why this?", `  ${notable}`);
  }
  if (report.alternate_actions.length > 0) {
    lines.push("", "Also visible:");
    for (const action of report.alternate_actions.slice(0, 3)) {
      lines.push(`  - ${action.reason}${action.command ? ` (${action.command})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runBoot(
  argv: readonly string[],
  io: RunCliIO,
  opts: { defaultPassport: string; defaultPassportSource?: PassportSource; defaultUrl: string },
): Promise<number> {
  const explicit = readFlag(argv, "passport");
  const passportPath = explicit ?? opts.defaultPassport;
  const passportSource: PassportSource = explicit ? "env" : (opts.defaultPassportSource ?? "operator");
  const cwd = resolve(readFlag(argv, "cwd") ?? process.cwd());
  const report = await buildBootReport({
    passportPath,
    passportSource,
    spaceUrl: readFlag(argv, "url") ?? opts.defaultUrl,
    cwd,
    messageLimit: Number(readFlag(argv, "messages") ?? "5"),
    since: readFlag(argv, "since"),
    peek: argv.includes("--peek"),
  });
  if (argv.includes("--json")) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(renderBoot(report));
  }
  return 0;
}

function collectBootCandidates(
  report: Omit<BootReport, "next_action" | "alternate_actions" | "decision_trace">,
  continuity: ContinuityReport,
  audit: AuditReport | null,
): BootCandidate[] {
  const out: BootCandidate[] = [];
  const push = (candidate: BootCandidate) => out.push(candidate);
  if (!report.identity.present) {
    push({
      id: "identity:setup",
      kind: "setup",
      command: "seed bootstrap --name <name> --purpose \"<purpose>\"",
      reason: "Create a Seedrop passport before orienting work.",
      source: "identity",
      risk: "low",
      requires_human: true,
      base_priority: 10,
      blocks_work: true,
      evidence: [{ source: "passport", ref: report.identity.passport_path, summary: "No readable active passport." }],
    });
  }
  if (!report.place.view_present) {
    push({
      id: "view:bootstrap",
      kind: "setup",
      command: "seed bootstrap",
      reason: "Create and link `.seedrop/view` for this root.",
      source: "view",
      risk: "low",
      requires_human: false,
      base_priority: 20,
      blocks_work: true,
      evidence: [{ source: "view", ref: report.place.root, summary: "Repo-local View is absent." }],
    });
  }
  if (continuity.inbox.unacked.length > 0) {
    const oldest = continuity.inbox.unacked[0]!;
    push({
      id: `inbox:${oldest.id}`,
      kind: "inbox",
      command: `seed inbox ack ${oldest.id.slice(0, 8)} --result done`,
      reason: `Process inbox: ${continuity.inbox.unacked.length} unacked mention(s). Start with [${oldest.id.slice(0, 8)}] from ${oldest.sender_passport_id}.`,
      source: "inbox",
      risk: "medium",
      requires_human: false,
      base_priority: 30,
      blocks_work: false,
      evidence: [{ source: "inbox", ref: oldest.id, summary: `${continuity.inbox.unacked.length} unacked mention(s), oldest from ${oldest.sender_passport_id}.` }],
    });
  }
  if (continuity.view.pendingHandoffs.length > 0) {
    const handoff = continuity.view.pendingHandoffs[0]!;
    push({
      id: `handoff:${handoff.handoff_id}`,
      kind: "handoff",
      command: `seed handoff read ${handoff.handoff_id}`,
      reason: `Review handoff [${handoff.handoff_id.slice(0, 8)}] from ${handoff.source_agent}: ${handoff.summary}.`,
      source: "handoff",
      risk: "medium",
      requires_human: false,
      base_priority: 40,
      blocks_work: false,
      evidence: [{ source: "handoff", ref: handoff.handoff_id, summary: `Pending handoff from ${handoff.source_agent}.` }],
    });
  }
  if (continuity.view.currentRun) {
    const run = continuity.view.currentRun;
    const action = run.next_actions?.[0];
    push({
      id: `active_run:${run.run_id}`,
      kind: "run",
      command: action?.command ?? `seed run log --summary "..."`,
      reason: action ? `Continue current run "${run.goal}": ${action.reason}.` : `Continue current run "${run.goal}", then log progress.`,
      source: "run",
      risk: "medium",
      requires_human: false,
      base_priority: 50,
      blocks_work: Boolean((run.changed_paths?.length ?? 0) > 0 || (run.validation?.length ?? 0) > 0 || (run.next_actions?.length ?? 0) > 0),
      evidence: [
        { source: "run", ref: run.run_id, summary: `Current run is in progress: ${run.goal}.` },
        ...(run.changed_paths?.length ? [{ source: "git" as const, summary: `Run tracks ${run.changed_paths.length} changed path(s).` }] : []),
      ],
    });
  }
  const latestValidation = continuity.view.currentRun?.validation?.at(-1) ?? continuity.view.latestRun?.validation?.at(-1);
  if (latestValidation?.status === "failed") {
    push({
      id: `failed_validation:${latestValidation.command}`,
      kind: "verify",
      command: latestValidation.command,
      reason: `Resolve failed validation from the latest run: ${latestValidation.command}.`,
      source: "run",
      risk: "high",
      requires_human: false,
      base_priority: 25,
      blocks_work: true,
      evidence: [{ source: "run", ref: latestValidation.command, summary: "Latest validation failed." }],
    });
  }
  const unsafeIssue = audit?.issues.find((issue) =>
    issue.severity === "error" ||
    issue.code === "knowledge_stale" ||
    issue.code === "knowledge_superseded" ||
    issue.code === "signal_expired"
  );
  if (report.safety.preflight_failed || unsafeIssue) {
    push({
      id: unsafeIssue ? `audit:${unsafeIssue.code}` : "preflight:failed",
      kind: unsafeIssue?.code === "signal_expired" ? "safety" : "sync",
      command: unsafeIssue?.code === "signal_expired" ? "seed view release --expired --dry-run" : "seed view audit --json",
      reason: unsafeIssue ? unsafeIssue.message : "View preflight has failed checks. Inspect before continuing.",
      source: "audit",
      risk: unsafeIssue?.severity === "error" ? "high" : "medium",
      requires_human: false,
      base_priority: unsafeIssue?.severity === "error" ? 25 : 60,
      blocks_work: unsafeIssue?.severity === "error" || report.safety.preflight_failed,
      evidence: [{ source: "audit", ref: unsafeIssue?.code, summary: unsafeIssue ? unsafeIssue.message : "Preflight failed." }],
    });
  }
  if (report.safety.git_dirty) {
    push({
      id: "git:dirty",
      kind: "safety",
      command: "git status",
      reason: `${report.safety.uncommitted_count} uncommitted file(s) — ${summarizePaths(report.safety.uncommitted_paths)}`,
      source: "git",
      risk: "medium",
      requires_human: false,
      base_priority: 70,
      blocks_work: false,
      evidence: [{ source: "git", summary: `${report.safety.uncommitted_count} uncommitted file(s).` }],
    });
  }
  const assigned = continuity.view.activeTasks.find((task) =>
    task.owner === report.identity.agent_id && (task.status === "claimed" || task.status === "in_progress")
  ) ?? continuity.view.activeTasks.find((task) => task.status === "open");
  if (assigned) {
    push({
      id: `task:${assigned.task_id}`,
      kind: "run",
      command: assigned.status === "in_progress"
        ? `seed run start --task ${assigned.task_id} --goal "${assigned.title}"`
        : `seed task start ${assigned.task_id}`,
      reason: `${assigned.status === "in_progress" ? "Continue" : "Start"} task [${assigned.task_id.slice(0, 8)}] "${assigned.title}".`,
      source: "run",
      risk: "medium",
      requires_human: false,
      base_priority: 80,
      blocks_work: false,
      evidence: [{ source: "view", ref: assigned.task_id, summary: `Task is ${assigned.status}.` }],
    });
  }
  if (continuity.view.latestPacket?.next_actions?.length) {
    push({
      id: `continuity:${continuity.view.latestPacket.id ?? "latest"}`,
      kind: "run",
      reason: `Continue last continuity packet: "${continuity.view.latestPacket.next_actions[0]}".`,
      source: "continuity",
      risk: "low",
      requires_human: false,
      base_priority: 90,
      blocks_work: false,
      evidence: [{ source: "continuity", ref: continuity.view.latestPacket.id, summary: "Latest continuity packet has next actions." }],
    });
  }
  push(fallbackCandidate);
  return out;
}

function evaluateBootCandidates(
  candidates: BootCandidate[],
  report: Omit<BootReport, "next_action" | "alternate_actions" | "decision_trace">,
  continuity: ContinuityReport,
  generatedAt: string,
): { trace: BootDecisionTrace; actions: BootNextAction[] } {
  const dirtyActiveRun = continuity.view.currentRun && report.safety.git_dirty && (continuity.view.currentRun.changed_paths?.length ?? 0) > 0;
  const evaluated = candidates.map((candidate) => {
    let finalPriority = candidate.base_priority;
    const modifiers: BootDecisionTrace["candidates"][number]["modifiers"] = [];
    if (!report.identity.present && candidate.source !== "identity") {
      modifiers.push({
        rule: "identity_required",
        effect: "suppress",
        reason: "Identity is missing, so repo-local work candidates cannot be trusted yet.",
      });
    }
    if (report.identity.present && !report.place.view_present && candidate.source !== "identity" && candidate.source !== "view") {
      modifiers.push({
        rule: "view_required",
        effect: "suppress",
        reason: "Repo View is missing, so coordination and run candidates are suppressed until bootstrap.",
      });
    }
    if (candidate.id.startsWith("active_run:") && dirtyActiveRun) {
      finalPriority -= 30;
      modifiers.push({
        rule: "protect_dirty_active_run",
        effect: "promote",
        delta: -30,
        reason: "Active run has changed paths and the git worktree is dirty.",
      });
    }
    if (candidate.id.startsWith("inbox:") && dirtyActiveRun) {
      finalPriority += 20;
      modifiers.push({
        rule: "defer_inbox_for_dirty_active_run",
        effect: "demote",
        delta: 20,
        reason: "Inbox is external input; dirty active run is a higher safety obligation.",
      });
    }
    return { candidate, finalPriority, modifiers };
  });

  const selectable = evaluated
    .filter((entry) => !entry.modifiers.some((modifier) => modifier.effect === "suppress" || modifier.effect === "block"))
    .sort((a, b) => a.finalPriority - b.finalPriority || a.candidate.id.localeCompare(b.candidate.id));
  const winner = selectable[0] ?? evaluated.find((entry) => entry.candidate.source === "identity") ?? evaluated[0]!;
  const actions = selectable.map((entry) => candidateToAction(entry.candidate, entry.finalPriority));
  const traceCandidates = evaluated
    .sort((a, b) => a.finalPriority - b.finalPriority || a.candidate.id.localeCompare(b.candidate.id))
    .map((entry) => {
      const selected = entry.candidate.id === winner.candidate.id;
      return {
        candidate_id: entry.candidate.id,
        kind: entry.candidate.kind,
        ...(entry.candidate.command ? { command: entry.candidate.command } : {}),
        reason: entry.candidate.reason,
        source: entry.candidate.source,
        risk: entry.candidate.risk,
        evidence: entry.candidate.evidence,
        objectives: objectiveTermsForCandidate(entry.candidate, report, continuity),
        base_priority: entry.candidate.base_priority,
        final_priority: entry.finalPriority,
        selected,
        modifiers: entry.modifiers,
        ...(selected ? {} : { rejected_because: rejectionReason(entry.candidate, winner.candidate, entry.modifiers) }),
      };
    });
  return {
    actions,
    trace: {
      policy_version: "boot-next-action-v1",
      objective_version: "boot-objective-v1",
      generated_at: generatedAt,
      winner: winner.candidate.id,
      candidates: traceCandidates,
    },
  };
}

function objectiveTermsForCandidate(
  candidate: BootCandidate,
  report: Omit<BootReport, "next_action" | "alternate_actions" | "decision_trace">,
  continuity: ContinuityReport,
): BootObjectiveTerm[] {
  const dirtyActiveRun = candidate.id.startsWith("active_run:")
    && report.safety.git_dirty
    && (continuity.view.currentRun?.changed_paths?.length ?? 0) > 0;
  if (candidate.source === "identity") {
    return [{ term: "identity_error", weight: 5, reason: "Without a trusted agent identity, subsequent repo-local decisions can attach to the wrong principal." }];
  }
  if (candidate.source === "view") {
    return [{ term: "missing_view", weight: 4, reason: "Without a repo View, future agents cannot recover local continuity from one stable surface." }];
  }
  if (candidate.kind === "verify") {
    return [{ term: "unverified_changes", weight: 5, reason: "The latest validation failed; continuing new work would compound an unresolved verification failure." }];
  }
  if (dirtyActiveRun) {
    return [
      { term: "lost_work", weight: 5, reason: "The selected run owns changed paths in a dirty worktree." },
      { term: "unsafe_context_switch", weight: 4, reason: "Switching away from a dirty active run can strand or overwrite in-progress work." },
    ];
  }
  if (candidate.id.startsWith("active_run:")) {
    return [
      { term: "duplicate_exploration", weight: 3, reason: "Resuming the active run should avoid rediscovering the current task state." },
      { term: "token_time_waste", weight: 2, reason: "The active run already contains goal and progress context." },
    ];
  }
  if (candidate.source === "inbox") {
    return [{ term: "coordination_lag", weight: 3, reason: "Unacked inbox mentions may contain coordination updates addressed to this agent." }];
  }
  if (candidate.source === "handoff") {
    return [
      { term: "coordination_lag", weight: 3, reason: "Pending handoff should be accepted or rejected before independent work proceeds." },
      { term: "duplicate_exploration", weight: 2, reason: "Handoff content can prevent a fresh agent from rediscovering work already packaged by another agent." },
    ];
  }
  if (candidate.source === "audit") {
    return [{ term: "stale_assumption", weight: 4, reason: "Audit issues mean the boot context may depend on stale or invalid View evidence." }];
  }
  if (candidate.source === "git") {
    return [
      { term: "lost_work", weight: 3, reason: "Dirty git state is uncommitted local work that should be inspected before context shifts." },
      { term: "unsafe_context_switch", weight: 2, reason: "Unknown uncommitted paths increase the risk of unsafe task switching." },
    ];
  }
  if (candidate.source === "continuity") {
    return [
      { term: "duplicate_exploration", weight: 3, reason: "The latest continuity packet carries explicit next actions from prior work." },
      { term: "token_time_waste", weight: 2, reason: "Following a continuity packet should reduce reorientation cost." },
    ];
  }
  return [{ term: "token_time_waste", weight: 1, reason: "A fallback focus action should reduce idle or unfocused boot time." }];
}

function scoreObjectiveTerm(
  objective: BootObjectiveTerm,
  observations: readonly BootOutcomeObservation[],
): BootOutcomeScore["loss_terms"][number] {
  const reducedKinds = reducedObservationKinds(objective.term);
  const increasedKinds = increasedObservationKinds(objective.term);
  const increased = matchingEvidence(observations, increasedKinds);
  const reduced = matchingEvidence(observations, reducedKinds);
  const observed = increased.length > 0 ? "increased" : reduced.length > 0 ? "reduced" : "unknown";
  return {
    term: objective.term,
    weight: objective.weight,
    expected: expectedDirection(objective.term),
    observed,
    evidence: observed === "increased" ? increased : observed === "reduced" ? reduced : [],
    rationale: objective.reason,
  };
}

function reducedObservationKinds(term: BootLossTerm): BootOutcomeObservationKind[] {
  switch (term) {
    case "identity_error":
      return ["identity_created"];
    case "missing_view":
      return ["view_bootstrapped"];
    case "unverified_changes":
      return ["validation_passed"];
    case "lost_work":
      return ["run_completed", "work_preserved", "git_clean", "validation_passed"];
    case "unsafe_context_switch":
      return ["run_completed", "work_preserved"];
    case "stale_assumption":
      return ["audit_clean"];
    case "coordination_lag":
      return ["inbox_acked", "handoff_accepted"];
    case "duplicate_exploration":
      return ["run_completed", "handoff_accepted"];
    case "token_time_waste":
      return ["run_started", "run_completed", "validation_passed", "inbox_acked", "handoff_accepted"];
  }
}

function increasedObservationKinds(term: BootLossTerm): BootOutcomeObservationKind[] {
  switch (term) {
    case "identity_error":
    case "lost_work":
    case "unsafe_context_switch":
    case "duplicate_exploration":
    case "token_time_waste":
      return ["context_switched"];
    case "unverified_changes":
      return ["validation_failed"];
    case "stale_assumption":
      return ["audit_failed"];
    case "missing_view":
    case "coordination_lag":
      return [];
  }
}

function matchingEvidence(observations: readonly BootOutcomeObservation[], kinds: readonly BootOutcomeObservationKind[]): string[] {
  return observations
    .filter((observation) => kinds.includes(observation.kind))
    .map((observation) => observation.summary ?? `${observation.kind}${observation.ref ? `: ${observation.ref}` : ""}`);
}

function expectedDirection(term: BootLossTerm): BootOutcomeScore["loss_terms"][number]["expected"] {
  if (term === "lost_work" || term === "unsafe_context_switch" || term === "identity_error") return "avoid";
  if (term === "stale_assumption") return "inspect";
  return "reduce";
}

function sumWeights(lossTerms: BootOutcomeScore["loss_terms"], observed: BootOutcomeScore["loss_terms"][number]["observed"]): number {
  return lossTerms.filter((term) => term.observed === observed).reduce((sum, term) => sum + term.weight, 0);
}

function outcomeStatus(reducedWeight: number, increasedWeight: number): BootOutcomeScore["status"] {
  if (reducedWeight > 0 && increasedWeight > 0) return "mixed";
  if (increasedWeight > 0) return "increased_loss";
  if (reducedWeight > 0) return "reduced_loss";
  return "inconclusive";
}

function outcomeConfidence(
  lossTerms: BootOutcomeScore["loss_terms"],
  observations: readonly BootOutcomeObservation[],
): BootOutcomeScore["confidence"] {
  if (observations.length === 0) return "low";
  const unknown = lossTerms.filter((term) => term.observed === "unknown").length;
  if (unknown === 0) return "high";
  if (unknown < lossTerms.length) return "medium";
  return "low";
}

function outcomeNotes(
  report: BootReport,
  selected: BootDecisionTrace["candidates"][number] | undefined,
  observations: readonly BootOutcomeObservation[],
): string[] {
  const notes = [
    `Scored selected candidate ${selected?.candidate_id ?? report.next_action.candidate_id} from ${report.decision_trace.policy_version}.`,
  ];
  if (observations.length === 0) {
    notes.push("No outcome observations were provided; score is only the expected objective surface.");
  }
  if (selected && selected.objectives.length === 0) {
    notes.push("Selected candidate had no explicit objective terms.");
  }
  return notes;
}

function candidateToAction(candidate: BootCandidate, finalPriority: number): BootNextAction {
  return {
    candidate_id: candidate.id,
    kind: candidate.kind,
    ...(candidate.command ? { command: candidate.command } : {}),
    reason: candidate.reason,
    source: candidate.source,
    risk: candidate.risk,
    requires_human: candidate.requires_human,
    priority: finalPriority,
  };
}

function rejectionReason(
  candidate: BootCandidate,
  winner: BootCandidate,
  modifiers: BootDecisionTrace["candidates"][number]["modifiers"],
): string {
  const suppress = modifiers.find((modifier) => modifier.effect === "suppress" || modifier.effect === "block");
  if (suppress) return suppress.reason;
  if (candidate.id.startsWith("inbox:") && winner.id.startsWith("active_run:")) {
    return "Inbox is important, but active dirty run is a higher safety obligation.";
  }
  return `Selected ${winner.id} because it has higher policy priority under boot-next-action-v1.`;
}

const fallbackCandidate: BootCandidate = {
  id: "focus:start",
  kind: "focus",
  command: `seed run start --goal "..."`,
  reason: "No queued work. Pick a focus, then start a run.",
  source: "view",
  risk: "low",
  requires_human: false,
  base_priority: 100,
  blocks_work: false,
  evidence: [{ source: "view", summary: "No higher-priority boot candidates were generated." }],
};

function trustLabels(continuity: ContinuityReport, audit: AuditReport | null): BootReport["trust"] {
  const labels: BootReport["trust"] = [];
  if (continuity.view.present) {
    labels.push({ label: "live_local", summary: ".seedrop/view is live local state for this repo." });
  }
  if (continuity.view.latestPacket?.git_status?.is_dirty === false || continuity.view.latestRun?.status === "completed") {
    labels.push({ label: "committed_proof", summary: "Latest durable trace has validation or completed-run evidence." });
  }
  if ((audit?.issues ?? []).some((issue) => issue.code === "knowledge_stale" || issue.code === "knowledge_superseded" || issue.code === "manifest_age_stale")) {
    labels.push({ label: "stale", summary: "Some View knowledge or manifest evidence is stale." });
  }
  if ((audit?.issues ?? []).some((issue) => issue.severity === "error")) {
    labels.push({ label: "untrusted", summary: "View audit has errors; inspect before trusting orientation." });
  }
  if (continuity.warnings.some((warning) => /sandbox/i.test(warning))) {
    labels.push({ label: "sandbox_limited", summary: "Runtime sandbox limits daemon proof from this process." });
  }
  return labels;
}

function formatBootAction(action: BootNextAction): string {
  return action.command ? `${action.reason} Run: \`${action.command}\`.` : action.reason;
}

function summarizePaths(paths: string[]): string {
  if (paths.length === 0) return "unknown paths";
  if (paths.length <= 3) return paths.join(", ");
  return `${paths.slice(0, 3).join(", ")}, +${paths.length - 3} more`;
}

function manifestFreshness(continuity: ContinuityReport, audit: AuditReport | null): BootReport["freshness"]["manifest"] {
  if (!continuity.view.present || !continuity.view.manifest) return "missing";
  if ((audit?.issues ?? []).some((issue) => issue.code === "manifest_missing" || issue.code === "manifest_file_missing" || issue.code === "policy_malformed")) {
    return "invalid";
  }
  if ((audit?.issues ?? []).some((issue) => issue.code === "file_missing_from_manifest" || issue.code === "file_hash_changed" || issue.code === "manifest_age_stale")) {
    return "stale";
  }
  return audit ? "fresh" : "unknown";
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

function sameDirectory(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
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
