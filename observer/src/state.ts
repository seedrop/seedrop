import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PassportSchema, type ActiveProject, type Passport } from "@seedrop/id";
import {
  WorkspaceView,
  type NextAction,
  type RunJournal,
  type RunValidationEntry,
  type Task,
  type WorkspaceContext,
} from "@seedrop/space";

export type BenchProjectStatus = "broken" | "attention" | "active" | "quiet";

export type BenchAttentionKind =
  | "missing_root"
  | "missing_view"
  | "view_error"
  | "active_run"
  | "active_signal"
  | "active_task"
  | "preflight_failed"
  | "view_success_below_required"
  | "manifest_stale"
  | "dirty_git"
  | "open_task"
  | "daemon_unreachable";

export interface BenchAttentionFactor {
  kind: BenchAttentionKind;
  label: string;
  score: number;
  severity: "critical" | "high" | "medium" | "low";
}

export interface BenchProjectAttention {
  score: number;
  primary?: BenchAttentionFactor;
  factors: BenchAttentionFactor[];
}

export interface BenchProjectViewState {
  present: boolean;
  successLevel?: string;
  successRequired?: string;
  successMeetsRequired?: boolean;
  preflightOk?: boolean;
  issueCodes: string[];
}

export interface BenchValidationSummary {
  command: string;
  status: "passed" | "failed" | "skipped";
  recordedAt: string;
  notes?: string;
}

export interface BenchRunSummary {
  id: string;
  goal: string;
  status: string;
  agent: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  changedPaths: string[];
  validation: BenchValidationSummary[];
  latestValidation?: BenchValidationSummary;
}

export interface BenchTaskSummary {
  id: string;
  title: string;
  description?: string;
  status: string;
  owner?: string;
  blockedByCount: number;
  relatedRuns: string[];
}

export interface BenchSignalSummary {
  id: string;
  type: "claim" | "lock";
  target: string;
  owner: string;
  intent: string;
  expiresAt: string;
}

export interface BenchNextActionSummary {
  kind: string;
  reason: string;
  risk: string;
  requiresHuman: boolean;
  command?: string;
  path?: string;
}

export interface BenchProjectInspectors {
  runs: {
    current?: BenchRunSummary;
    latest?: BenchRunSummary;
    active: BenchRunSummary[];
  };
  tasks: {
    openCount: number;
    active: BenchTaskSummary[];
  };
  signals: BenchSignalSummary[];
  validation: {
    status: "passed" | "failed" | "skipped" | "unknown";
    latest?: BenchValidationSummary;
  };
  nextActions: BenchNextActionSummary[];
}

export interface BenchProjectAgent {
  agent_id: string;
  name: string;
  passportPath: string;
  role?: string;
  currentFocus?: string;
}

export type BenchProjectAgentSource = "linked" | "view" | "task" | "claim";

export interface BenchProjectContributor {
  agent_id: string;
  name: string;
  linked: boolean;
  legacy: boolean;
  status: "active" | "linked" | "seen" | "legacy";
  sources: BenchProjectAgentSource[];
  viewRuns: number;
  activeRuns: number;
  openTasks: number;
  claims: number;
  lastSeenAt?: string;
  currentFocus?: string;
  role?: string;
}

export interface BenchSituationMetric {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}

export interface BenchProjectBlocker {
  label: string;
  detail?: string;
  severity: "critical" | "high" | "medium" | "low";
  source: "view" | "task" | "git" | "space";
}

export type BenchResumptionReadiness = "ready" | "active" | "review" | "blocked" | "unknown";

export type BenchDegradedFactSeverity = "critical" | "high" | "medium" | "low";

export type BenchEvidenceSource = "passport" | "view" | "git" | "space" | "validation" | "bench";

export type BenchEvidenceScope = "project" | "machine";

export interface BenchDegradedFact {
  kind: string;
  severity: BenchDegradedFactSeverity;
  source: BenchEvidenceSource;
  scope: BenchEvidenceScope;
  label: string;
  detail?: string;
  evidencePath?: string;
  observedAt?: string;
}

export interface BenchRecommendedRepair {
  kind: string;
  label: string;
  reason: string;
  source: BenchEvidenceSource;
  priority: number;
  command?: string;
}

export interface BenchResumptionState {
  readiness: BenchResumptionReadiness;
  label: "Ready" | "Active" | "Review" | "Blocked" | "Unknown";
  summary: string;
  degraded: BenchDegradedFact[];
  recommendedRepair?: BenchRecommendedRepair;
}

export interface BenchProjectSituation {
  summary: string;
  resumption: BenchResumptionState;
  repo: BenchSituationMetric[];
  agents: BenchProjectContributor[];
  tasks: {
    open: number;
    active: number;
    blocked: number;
    unowned: number;
    assigned: number;
    next?: BenchTaskSummary;
  };
  blockers: BenchProjectBlocker[];
  next?: BenchNextActionSummary;
}

export interface BenchProject {
  id: string;
  label: string;
  root: string;
  status: BenchProjectStatus;
  reasons: string[];
  role?: string;
  currentFocus?: string;
  space?: string;
  viewPath?: string;
  lastSeenAt?: string;
  view: BenchProjectViewState;
  counts: {
    activeRuns: number;
    openTasks: number;
    activeSignals: number;
    dirtyFiles: number;
  };
  attention: BenchProjectAttention;
  nextAction?: NextAction;
  inspectors: BenchProjectInspectors;
  agents: BenchProjectAgent[];
  situation: BenchProjectSituation;
}

export interface BenchDaemonState {
  url?: string;
  reachable: boolean;
  service?: string;
  version?: string;
  registeredPassports: number;
  error?: string;
}

export interface BenchInboxItem {
  id: string;
  space?: string;
  sender: string;
  content: string;
  createdAt: string;
  ackedAt?: string;
}

export interface BenchInboxState {
  reachable: boolean;
  unread: number;
  items: BenchInboxItem[];
  source?: string;
  error?: string;
}

export interface BenchState {
  schema_version: "1.0";
  generated_at: string;
  passport: {
    agent_id: string;
    name: string;
    path: string;
    active_projects: number;
  };
  inventory: {
    scope: "machine";
    passports: number;
    linked_projects: number;
  };
  daemon: BenchDaemonState;
  summary: {
    total: number;
    broken: number;
    attention: number;
    active: number;
    quiet: number;
  };
  inbox: BenchInboxState;
  groups: BenchProjectGroup[];
  projects: BenchProject[];
  selection?: {
    preferred_project_id?: string;
    preferred_root?: string;
    reason: "cwd";
  };
}

export interface BenchProjectGroup {
  status: BenchProjectStatus;
  label: string;
  count: number;
  projectIds: string[];
}

export interface BenchStateOptions {
  passportPath: string;
  passportSearchRoots?: string[];
  preferredRoot?: string;
  spaceUrl?: string | null;
  now?: () => Date;
  fetch?: typeof fetch;
}

interface BenchProjectCandidate {
  project: ActiveProject;
  agentId: string;
  passportPath: string;
  agent: BenchProjectAgent;
  primary: boolean;
}

const STATUS_WEIGHT: Record<BenchProjectStatus, number> = {
  broken: 0,
  attention: 1,
  active: 2,
  quiet: 3,
};

const GROUP_LABELS: Record<BenchProjectStatus, string> = {
  broken: "Missing",
  attention: "Review",
  active: "Active",
  quiet: "Clear",
};

export function defaultSpaceUrl(): string {
  return process.env.SEEDROP_SPACE_URL ?? "http://127.0.0.1:18791";
}

export async function collectBenchState(options: BenchStateOptions): Promise<BenchState> {
  const now = options.now ?? (() => new Date());
  const spaceUrl = options.spaceUrl === undefined ? defaultSpaceUrl() : options.spaceUrl;
  const fetchImpl = options.fetch ?? fetch;
  const passport = await readPassport(options.passportPath);
  const inventory = await readPassportInventory(options.passportPath, options.passportSearchRoots);
  const knownAgents = knownAgentsFromInventory(inventory);
  const projectCandidates = mergeProjectCandidates(inventory.flatMap((entry) =>
    (entry.passport.active_projects ?? []).filter(isSeedropProjectLink).map((project) => ({
      project,
      agentId: entry.passport.agent_id,
      passportPath: entry.path,
      primary: entry.path === options.passportPath,
      agent: {
        agent_id: entry.passport.agent_id,
        name: entry.passport.name,
        passportPath: entry.path,
        role: project.role,
        currentFocus: project.current_focus,
      },
    })),
  ));
  const daemon = await readDaemon({
    url: spaceUrl,
    fetchImpl,
  });
  const inbox = await readInbox({
    url: spaceUrl,
    passportId: passport.agent_id,
    fetchImpl,
    daemon,
  });
  const rawProjects = await Promise.all(projectCandidates.map((project) => collectProject(project, knownAgents)));
  const projects = rankBenchProjects(rawProjects.map((project) => applyDaemonAttention(project, daemon)));
  const selection = preferredSelection(projects, options.preferredRoot);

  return {
    schema_version: "1.0",
    generated_at: now().toISOString(),
    passport: {
      agent_id: passport.agent_id,
      name: passport.name,
      path: options.passportPath,
      active_projects: passport.active_projects?.length ?? 0,
    },
    inventory: {
      scope: "machine",
      passports: inventory.length,
      linked_projects: projectCandidates.reduce((sum, candidate) => sum + candidate.agents.length, 0),
    },
    daemon,
    summary: summarize(projects),
    inbox,
    groups: groupBenchProjects(projects),
    projects,
    ...(selection ? { selection } : {}),
  };
}

export function rankBenchProjects(projects: BenchProject[]): BenchProject[] {
  return [...projects].sort((a, b) => {
    const byStatus = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
    if (byStatus !== 0) return byStatus;
    const byScore = b.attention.score - a.attention.score;
    if (byScore !== 0) return byScore;
    const byActivity =
      (b.counts.activeRuns + b.counts.activeSignals + b.counts.openTasks)
      - (a.counts.activeRuns + a.counts.activeSignals + a.counts.openTasks);
    if (byActivity !== 0) return byActivity;
    return a.label.localeCompare(b.label);
  });
}

export function groupBenchProjects(projects: BenchProject[]): BenchProjectGroup[] {
  return (["broken", "attention", "active", "quiet"] as BenchProjectStatus[]).map((status) => {
    const matching = projects.filter((project) => project.status === status);
    return {
      status,
      label: GROUP_LABELS[status],
      count: matching.length,
      projectIds: matching.map((project) => project.id),
    };
  });
}

async function readPassport(passportPath: string): Promise<Passport> {
  const raw = JSON.parse(await readFile(passportPath, "utf8")) as unknown;
  return PassportSchema.parse(raw);
}

function knownAgentsFromInventory(inventory: Array<{ path: string; passport: Passport }>): Map<string, BenchProjectAgent> {
  const known = new Map<string, BenchProjectAgent>();
  for (const entry of inventory) {
    known.set(entry.passport.agent_id, {
      agent_id: entry.passport.agent_id,
      name: entry.passport.name,
      passportPath: entry.path,
    });
  }
  return known;
}

function preferredSelection(projects: BenchProject[], preferredRoot: string | undefined): BenchState["selection"] | undefined {
  if (!preferredRoot) return undefined;
  const resolved = path.resolve(preferredRoot);
  const preferred = projects.find((project) =>
    resolved === project.root || resolved.startsWith(`${project.root}${path.sep}`),
  );
  if (!preferred) return undefined;
  return {
    preferred_project_id: preferred.id,
    preferred_root: resolved,
    reason: "cwd",
  };
}

async function readPassportInventory(primaryPassportPath: string, searchRoots?: string[]): Promise<Array<{ path: string; passport: Passport }>> {
  const paths = await discoverPassportPaths(primaryPassportPath, searchRoots);
  const passports = await Promise.all(paths.map(async (passportPath) => {
    try {
      return { path: passportPath, passport: await readPassport(passportPath) };
    } catch {
      return null;
    }
  }));
  const valid = passports.filter((entry): entry is { path: string; passport: Passport } => entry !== null);
  return valid.sort((a, b) => {
    if (a.path === primaryPassportPath) return -1;
    if (b.path === primaryPassportPath) return 1;
    return a.passport.agent_id.localeCompare(b.passport.agent_id);
  });
}

async function discoverPassportPaths(primaryPassportPath: string, searchRoots?: string[]): Promise<string[]> {
  const roots = searchRoots ?? defaultPassportSearchRoots(primaryPassportPath);
  const paths = new Set<string>([path.resolve(primaryPassportPath)]);
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const operatorPassport = path.join(resolvedRoot, "passport.json");
    if (existsSync(operatorPassport)) paths.add(operatorPassport);
    const agentsDir = path.join(resolvedRoot, "agents");
    if (!existsSync(agentsDir)) continue;
    try {
      for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          paths.add(path.join(agentsDir, entry.name));
        }
      }
    } catch {
      continue;
    }
  }
  return [...paths];
}

function defaultPassportSearchRoots(primaryPassportPath: string): string[] {
  const resolved = path.resolve(primaryPassportPath);
  const parent = path.dirname(resolved);
  return path.basename(parent) === "agents" ? [path.dirname(parent)] : [parent];
}

function isSeedropProjectLink(project: ActiveProject): boolean {
  return !project.view || project.view === ".seedrop/view" || project.view.endsWith("/.seedrop/view");
}

function mergeProjectCandidates(candidates: BenchProjectCandidate[]): Array<BenchProjectCandidate & { agents: BenchProjectAgent[] }> {
  const grouped = new Map<string, BenchProjectCandidate & { agents: BenchProjectAgent[] }>();
  for (const candidate of candidates) {
    const key = `${path.resolve(candidate.project.root)}\u0000${candidate.project.view ?? ".seedrop/view"}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...candidate, project: { ...candidate.project }, agents: [candidate.agent] });
      continue;
    }
    const alreadyListed = existing.agents.some((agent) =>
      agent.agent_id === candidate.agent.agent_id && agent.passportPath === candidate.agent.passportPath,
    );
    if (!alreadyListed) existing.agents.push(candidate.agent);
    if (!existing.primary && candidate.primary) {
      existing.project = { ...candidate.project };
      existing.agentId = candidate.agentId;
      existing.passportPath = candidate.passportPath;
      existing.primary = true;
    }
  }
  return uniquifyProjectIds([...grouped.values()]);
}

function uniquifyProjectIds(candidates: Array<BenchProjectCandidate & { agents: BenchProjectAgent[] }>): Array<BenchProjectCandidate & { agents: BenchProjectAgent[] }> {
  const used = new Map<string, number>();
  return candidates.map((candidate) => {
    const baseId = candidate.project.id;
    const count = used.get(baseId) ?? 0;
    used.set(baseId, count + 1);
    if (count === 0) return candidate;
    const suffix = path.basename(path.resolve(candidate.project.root)).replace(/[^a-zA-Z0-9._-]+/g, "-") || String(count + 1);
    return {
      ...candidate,
      project: { ...candidate.project, id: `${baseId}-${suffix}` },
    };
  });
}

async function readDaemon(input: { url: string | null; fetchImpl: typeof fetch }): Promise<BenchDaemonState> {
  if (input.url === null) {
    return { reachable: false, registeredPassports: 0, error: "daemon check skipped" };
  }
  try {
    const response = await input.fetchImpl(`${input.url.replace(/\/+$/, "")}/health`);
    if (!response.ok) {
      return {
        url: input.url,
        reachable: false,
        registeredPassports: 0,
        error: `health returned ${response.status}`,
      };
    }
    const body = await response.json() as {
      service?: string;
      version?: string;
      registered_passports?: unknown[];
      registeredPassports?: unknown[];
    };
    return {
      url: input.url,
      reachable: true,
      service: body.service,
      version: body.version,
      registeredPassports: (body.registered_passports ?? body.registeredPassports ?? []).length,
    };
  } catch (error) {
    return {
      url: input.url,
      reachable: false,
      registeredPassports: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readInbox(input: {
  url: string | null;
  passportId: string;
  fetchImpl: typeof fetch;
  daemon: BenchDaemonState;
}): Promise<BenchInboxState> {
  if (input.url === null) {
    return { reachable: false, unread: 0, items: [], error: "daemon check skipped" };
  }
  if (!input.daemon.reachable) {
    return {
      reachable: false,
      unread: 0,
      items: [],
      source: `${input.url.replace(/\/+$/, "")}/inbox/${input.passportId}`,
      error: input.daemon.error ?? "daemon unreachable",
    };
  }
  const baseUrl = input.url.replace(/\/+$/, "");
  const source = `${baseUrl}/inbox/${input.passportId}`;
  try {
    const response = await input.fetchImpl(`${source}?unacked_only=true&limit=10`, {
      headers: { "x-seedrop-passport": input.passportId },
    });
    if (!response.ok) {
      return { reachable: true, unread: 0, items: [], source, error: `inbox returned ${response.status}` };
    }
    const body = await response.json() as { mentions?: unknown };
    const items = Array.isArray(body.mentions) ? body.mentions.flatMap(normalizeInboxItem) : [];
    return { reachable: true, unread: items.filter((item) => !item.ackedAt).length, items, source };
  } catch (error) {
    return {
      reachable: false,
      unread: 0,
      items: [],
      source,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectProject(candidate: BenchProjectCandidate & { agents?: BenchProjectAgent[] }, knownAgents: Map<string, BenchProjectAgent>): Promise<BenchProject> {
  const project = candidate.project;
  const agentId = candidate.agentId;
  const root = path.resolve(project.root);
  const linkedAgents = candidate.agents ?? [candidate.agent];
  const base = projectBase(project, root, linkedAgents);
  if (!existsSync(root)) {
    const view = { present: false, issueCodes: ["missing_root"] };
    const counts = { activeRuns: 0, openTasks: 0, activeSignals: 0, dirtyFiles: 0 };
    const projectAttention = attention([factor("missing_root", "Project root missing", 1000, "critical")]);
    return {
      ...base,
      status: "broken",
      reasons: ["Project root missing"],
      view,
      counts,
      attention: projectAttention,
      inspectors: emptyInspectors(),
      situation: buildProjectSituation({
        root,
        status: "broken",
        reasons: ["Project root missing"],
        linkedAgents,
        knownAgents,
        view,
        counts,
        attention: projectAttention,
      }),
    };
  }

  const viewDir = path.join(root, project.view ?? ".seedrop/view");
  if (!existsSync(viewDir)) {
    const view = { present: false, issueCodes: ["missing_view"] };
    const counts = { activeRuns: 0, openTasks: 0, activeSignals: 0, dirtyFiles: 0 };
    const projectAttention = attention([factor("missing_view", "View missing", 900, "critical")]);
    return {
      ...base,
      status: "broken",
      reasons: ["View missing"],
      view,
      counts,
      attention: projectAttention,
      inspectors: emptyInspectors(),
      situation: buildProjectSituation({
        root,
        status: "broken",
        reasons: ["View missing"],
        linkedAgents,
        knownAgents,
        view,
        counts,
        attention: projectAttention,
      }),
    };
  }

  try {
    const workspaceView = WorkspaceView.open({ root, agent: agentId, dataDir: project.view ?? ".seedrop/view" });
    const [context, runs, tasks] = await Promise.all([
      workspaceView.context({ budgetBytes: 0 }),
      workspaceView.listRuns().catch(() => [] as RunJournal[]),
      workspaceView.listTasks().catch(() => [] as Task[]),
    ]);
    const classified = classifyContext(context);
    const view: BenchProjectViewState = {
      present: context.view?.present ?? true,
      successLevel: context.brief?.success?.level,
      successRequired: context.brief?.success?.required_level,
      successMeetsRequired: context.brief?.success?.meets_required,
      preflightOk: context.preflight?.ok,
      issueCodes: context.preflight?.issues.map((issue) => issue.code) ?? [],
    };
    const counts = {
      activeRuns: context.active_runs?.length ?? 0,
      openTasks: context.open_tasks_count ?? 0,
      activeSignals: context.active_signals.length,
      dirtyFiles: context.brief?.git_status?.uncommitted_count ?? 0,
    };
    const projectAttention = attention(classified.factors);
    return {
      ...base,
      status: classified.status,
      reasons: classified.reasons,
      view,
      counts,
      attention: projectAttention,
      nextAction: context.next_actions?.[0],
      inspectors: inspectContext(context),
      situation: buildProjectSituation({
        root,
        status: classified.status,
        reasons: classified.reasons,
        linkedAgents,
        knownAgents,
        view,
        counts,
        attention: projectAttention,
        context,
        runs,
        tasks,
        nextAction: context.next_actions?.[0],
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const view = { present: true, issueCodes: ["view_read_failed"] };
    const counts = { activeRuns: 0, openTasks: 0, activeSignals: 0, dirtyFiles: 0 };
    const projectAttention = attention([factor("view_error", message, 850, "critical")]);
    return {
      ...base,
      status: "broken",
      reasons: [message],
      view,
      counts,
      attention: projectAttention,
      inspectors: emptyInspectors(),
      situation: buildProjectSituation({
        root,
        status: "broken",
        reasons: [message],
        linkedAgents,
        knownAgents,
        view,
        counts,
        attention: projectAttention,
      }),
    };
  }
}

function projectBase(project: ActiveProject, root: string, agents: BenchProjectAgent[]): Omit<BenchProject, "status" | "reasons" | "view" | "counts" | "attention" | "inspectors" | "situation"> {
  return {
    id: project.id,
    label: project.id,
    root,
    role: project.role,
    currentFocus: project.current_focus,
    space: project.space,
    viewPath: project.view,
    lastSeenAt: project.last_seen_at,
    agents,
  };
}

function buildProjectSituation(input: {
  root: string;
  status: BenchProjectStatus;
  reasons: string[];
  linkedAgents: BenchProjectAgent[];
  knownAgents: Map<string, BenchProjectAgent>;
  view: BenchProjectViewState;
  counts: BenchProject["counts"];
  attention: BenchProjectAttention;
  context?: WorkspaceContext;
  runs?: RunJournal[];
  tasks?: Task[];
  nextAction?: NextAction;
}): BenchProjectSituation {
  const tasks = input.tasks ?? [];
  const taskSummary = summarizeTaskState(tasks);
  const blockers = summarizeBlockers(input.reasons, input.attention, tasks);
  const contributors = summarizeContributors({
    linkedAgents: input.linkedAgents,
    knownAgents: input.knownAgents,
    runs: input.runs ?? [],
    tasks,
    signals: input.context?.active_signals ?? [],
    otherAgents: input.context?.other_agents ?? [],
  });
  const resumption = buildResumptionState({
    root: input.root,
    status: input.status,
    view: input.view,
    counts: input.counts,
    attention: input.attention,
    context: input.context,
    tasks,
    taskSummary,
    contributors,
  });
  return {
    summary: resumption.summary,
    resumption,
    repo: [
      { label: "View", value: input.view.present ? "present" : "missing", tone: input.view.present ? "good" : "bad" },
      { label: "Git", value: input.counts.dirtyFiles > 0 ? `${input.counts.dirtyFiles} dirty` : "clean", tone: input.counts.dirtyFiles > 0 ? "warn" : "good" },
      { label: "Tasks", value: `${taskSummary.open} open`, tone: taskSummary.blocked > 0 ? "warn" : "neutral" },
      { label: "Validation", value: input.context?.latest_run?.validation.at(-1)?.status ?? "unknown", tone: validationTone(input.context?.latest_run?.validation.at(-1)?.status) },
    ],
    agents: contributors,
    tasks: taskSummary,
    blockers,
    next: input.nextAction ? summarizeNextAction(input.nextAction) : undefined,
  };
}

function buildResumptionState(input: {
  root: string;
  status: BenchProjectStatus;
  view: BenchProjectViewState;
  counts: BenchProject["counts"];
  attention: BenchProjectAttention;
  context?: WorkspaceContext;
  tasks: Task[];
  taskSummary: BenchProjectSituation["tasks"];
  contributors: BenchProjectContributor[];
}): BenchResumptionState {
  const degraded = collectDegradedFacts(input);
  const readiness = decideReadiness(input.status, degraded, input.taskSummary);
  const recommendedRepair = selectRecommendedRepair(degraded);
  return {
    readiness,
    label: readinessLabel(readiness),
    summary: resumptionSummary(readiness, degraded, input.taskSummary),
    degraded,
    ...(recommendedRepair ? { recommendedRepair } : {}),
  };
}

function collectDegradedFacts(input: {
  root: string;
  view: BenchProjectViewState;
  counts: BenchProject["counts"];
  attention: BenchProjectAttention;
  context?: WorkspaceContext;
  tasks: Task[];
  taskSummary: BenchProjectSituation["tasks"];
  contributors: BenchProjectContributor[];
}): BenchDegradedFact[] {
  const facts = new Map<string, BenchDegradedFact>();
  const add = (fact: BenchDegradedFact) => {
    if (!facts.has(factKey(fact))) facts.set(factKey(fact), fact);
  };

  if (input.view.issueCodes.includes("missing_root")) {
    add({
      kind: "missing_root",
      severity: "critical",
      source: "passport",
      scope: "project",
      label: "Project root missing",
      detail: input.root,
    });
  }
  if (input.view.issueCodes.includes("missing_view")) {
    add({
      kind: "missing_view",
      severity: "critical",
      source: "view",
      scope: "project",
      label: "View missing",
      detail: ".seedrop/view is not present for this project.",
      evidencePath: path.join(input.root, ".seedrop", "view"),
    });
  }
  if (input.view.issueCodes.includes("view_read_failed") || input.attention.factors.some((entry) => entry.kind === "view_error")) {
    const reason = input.attention.factors.find((entry) => entry.kind === "view_error")?.label;
    add({
      kind: "view_read_failed",
      severity: "critical",
      source: "view",
      scope: "project",
      label: "View unreadable",
      detail: reason ?? "Bench could not read the project View.",
      evidencePath: path.join(input.root, ".seedrop", "view"),
    });
  }
  for (const factorEntry of input.attention.factors) {
    if (factorEntry.kind === "preflight_failed") {
      const lowerLabel = factorEntry.label.toLowerCase();
      if (lowerLabel.includes("active run") || lowerLabel.includes("git worktree")) continue;
      add({
        kind: "preflight_failed",
        severity: factorEntry.severity,
        source: "view",
        scope: "project",
        label: "Preflight failed",
        detail: factorEntry.label,
        evidencePath: ".seedrop/view",
      });
    }
    if (factorEntry.kind === "view_success_below_required") {
      add({
        kind: "view_success_below_required",
        severity: "medium",
        source: "view",
        scope: "project",
        label: "View below policy",
        detail: factorEntry.label,
        evidencePath: ".seedrop/view/policy.json",
      });
    }
    if (factorEntry.kind === "manifest_stale") {
      add({
        kind: "stale_manifest",
        severity: "medium",
        source: "view",
        scope: "project",
        label: "Manifest stale",
        detail: factorEntry.label,
        evidencePath: ".seedrop/view/manifest.json",
      });
    }
    if (factorEntry.kind === "daemon_unreachable") {
      add({
        kind: "daemon_unreachable",
        severity: "medium",
        source: "space",
        scope: "machine",
        label: "Space offline",
        detail: factorEntry.label,
      });
    }
  }

  const latestValidation = input.context?.latest_run?.validation.at(-1);
  if (latestValidation?.status === "failed") {
    add({
      kind: "validation_failed",
      severity: "high",
      source: "validation",
      scope: "project",
      label: "Validation failed",
      detail: latestValidation.command,
      observedAt: latestValidation.recorded_at,
    });
  } else if (latestValidation?.status === "skipped") {
    add({
      kind: "validation_skipped",
      severity: "low",
      source: "validation",
      scope: "project",
      label: "Validation skipped",
      detail: latestValidation.command,
      observedAt: latestValidation.recorded_at,
    });
  } else if (
    !latestValidation
    && input.view.present
    && input.view.successMeetsRequired !== false
    && input.counts.activeRuns === 0
    && input.taskSummary.active === 0
  ) {
    add({
      kind: "validation_unknown",
      severity: "low",
      source: "validation",
      scope: "project",
      label: "Validation unknown",
      detail: "No latest run validation was found.",
    });
  }

  const gitDirty = gitDirtyEvidence(input.context, input.counts.dirtyFiles);
  if (gitDirty.tracked > 0) {
    add({
      kind: "dirty_git_tracked",
      severity: "medium",
      source: "git",
      scope: "project",
      label: "Tracked changes",
      detail: `${gitDirty.tracked} tracked change${gitDirty.tracked === 1 ? "" : "s"}${gitDirty.untracked > 0 ? `, ${gitDirty.untracked} untracked` : ""}.`,
    });
  } else if (gitDirty.untracked > 0) {
    add({
      kind: "dirty_git_untracked",
      severity: "low",
      source: "git",
      scope: "project",
      label: "Untracked files",
      detail: `${gitDirty.untracked} untracked file${gitDirty.untracked === 1 ? "" : "s"}.`,
    });
  } else if (gitDirty.unknownDirty > 0) {
    add({
      kind: "dirty_git",
      severity: "medium",
      source: "git",
      scope: "project",
      label: "Dirty worktree",
      detail: `${gitDirty.unknownDirty} dirty file${gitDirty.unknownDirty === 1 ? "" : "s"}.`,
    });
  }

  for (const task of input.tasks) {
    const blockerCount = task.blocked_by?.length ?? 0;
    if (task.status !== "blocked" && blockerCount === 0) continue;
    add({
      kind: task.task_id === input.taskSummary.next?.id ? "next_task_blocked" : "blocked_task",
      severity: task.task_id === input.taskSummary.next?.id ? "high" : "medium",
      source: "view",
      scope: "project",
      label: task.task_id === input.taskSummary.next?.id ? "Next task blocked" : "Task blocked",
      detail: `${task.task_id.slice(0, 8)} ${task.title}`,
      evidencePath: `.seedrop/view/tasks/${task.task_id}.json`,
    });
  }

  if (input.taskSummary.unowned > 0) {
    add({
      kind: "open_unowned_tasks",
      severity: "low",
      source: "view",
      scope: "project",
      label: "Unowned tasks",
      detail: `${input.taskSummary.unowned} task${input.taskSummary.unowned === 1 ? "" : "s"} not assigned.`,
      evidencePath: ".seedrop/view/tasks",
    });
  }

  for (const contributor of input.contributors) {
    if (!contributor.linked && contributor.status !== "legacy") {
      add({
        kind: "agent_seen_not_linked",
        severity: "medium",
        source: "passport",
        scope: "project",
        label: "Agent seen, not linked",
        detail: `${contributor.name} appears in View evidence but is not linked from a passport for this project.`,
      });
    }
    if (contributor.legacy) {
      add({
        kind: "legacy_agent_identity",
        severity: "medium",
        source: "view",
        scope: "project",
        label: "Legacy agent identity",
        detail: `${contributor.name} appears as legacy agent identity.`,
      });
    }
  }

  return [...facts.values()].sort((a, b) => {
    const bySeverity = severityWeight(a.severity) - severityWeight(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.label.localeCompare(b.label);
  });
}

function decideReadiness(
  status: BenchProjectStatus,
  degraded: BenchDegradedFact[],
  taskSummary: BenchProjectSituation["tasks"],
): BenchResumptionReadiness {
  if (degraded.some((fact) => fact.severity === "critical")) return "blocked";
  if (degraded.some((fact) => fact.kind === "validation_failed" || fact.kind === "next_task_blocked")) return "blocked";
  if (taskSummary.next?.status === "in_progress" || status === "active") return "active";
  if (degraded.length > 0) return "review";
  if (status === "broken") return "unknown";
  return "ready";
}

function selectRecommendedRepair(degraded: BenchDegradedFact[]): BenchRecommendedRepair | undefined {
  const repairs = degraded.flatMap((fact): BenchRecommendedRepair[] => {
    if (fact.kind === "missing_root") {
      return [repair(fact, 10, "Locate or unlink project", "The passport points to a root Bench cannot read.")];
    }
    if (fact.kind === "missing_view") {
      return [repair(fact, 20, "Initialize View", "The project has no Seedrop View.", "seed view init")];
    }
    if (fact.kind === "view_read_failed") {
      return [repair(fact, 25, "Repair View", "The project View could not be parsed.", "seed view preflight --json")];
    }
    if (fact.kind === "validation_failed") {
      return [repair(fact, 30, "Review failed validation", "The latest recorded validation failed.")];
    }
    if (fact.kind === "next_task_blocked") {
      return [repair(fact, 35, "Inspect blockers", "The selected next task is blocked.")];
    }
    if (fact.kind === "preflight_failed" || fact.kind === "view_success_below_required" || fact.kind === "stale_manifest") {
      return [repair(fact, 40, "Refresh View evidence", "Bench found View evidence that does not yet meet policy.", "seed view preflight --json")];
    }
    if (fact.kind === "dirty_git_tracked" || fact.kind === "dirty_git") {
      return [repair(fact, 50, "Inspect dirty state", "Tracked local changes affect safe handoff.", "git status")];
    }
    if (fact.kind === "agent_seen_not_linked" || fact.kind === "legacy_agent_identity") {
      return [repair(fact, 60, "Reconcile agents", "Agent provenance is visible but not fully canonical.")];
    }
    if (fact.kind === "validation_unknown" || fact.kind === "validation_skipped") {
      return [repair(fact, 70, "Record validation", "The project lacks a passed validation point.")];
    }
    if (fact.kind === "open_unowned_tasks") {
      return [repair(fact, 80, "Review task queue", "Open tasks are present without ownership.")];
    }
    if (fact.kind === "daemon_unreachable") {
      return [repair(fact, 90, "Check Space daemon", "Machine coordination is offline.", "seed daemon status")];
    }
    return [];
  });
  return repairs.sort((a, b) => a.priority - b.priority)[0];
}

function repair(
  fact: BenchDegradedFact,
  priority: number,
  label: string,
  reason: string,
  command?: string,
): BenchRecommendedRepair {
  return {
    kind: fact.kind,
    label,
    reason,
    source: fact.source,
    priority,
    ...(command ? { command } : {}),
  };
}

function readinessLabel(readiness: BenchResumptionReadiness): BenchResumptionState["label"] {
  if (readiness === "ready") return "Ready";
  if (readiness === "active") return "Active";
  if (readiness === "review") return "Review";
  if (readiness === "blocked") return "Blocked";
  return "Unknown";
}

function resumptionSummary(
  readiness: BenchResumptionReadiness,
  degraded: BenchDegradedFact[],
  taskSummary: BenchProjectSituation["tasks"],
): string {
  if (readiness === "blocked") {
    const primary = degraded.find((fact) => fact.severity === "critical" || fact.severity === "high") ?? degraded[0];
    return primary ? `Blocked by ${primary.label.toLowerCase()}.` : "Blocked.";
  }
  if (readiness === "review") {
    const primary = degraded[0];
    if (primary) return `Review ${primary.label.toLowerCase()} before handoff.`;
    return "Review recommended.";
  }
  if (readiness === "active") {
    if (taskSummary.next) return `Resume ${shortTask(taskSummary.next)}.`;
    return "Active work can be resumed.";
  }
  if (readiness === "ready") {
    if (taskSummary.next) return `Ready to resume ${shortTask(taskSummary.next)}.`;
    return "Ready to resume.";
  }
  return "Not enough evidence to resume safely.";
}

function gitDirtyEvidence(context: WorkspaceContext | undefined, fallbackDirtyFiles: number): {
  tracked: number;
  untracked: number;
  unknownDirty: number;
} {
  const details = context?.preflight?.checks.find((check) => check.id === "git_dirty")?.details;
  const tracked = arrayField(details, "tracked").length;
  const untracked = arrayField(details, "untracked").length;
  if (tracked > 0 || untracked > 0) return { tracked, untracked, unknownDirty: 0 };
  return { tracked: 0, untracked: 0, unknownDirty: fallbackDirtyFiles };
}

function arrayField(value: Record<string, unknown> | undefined, key: string): unknown[] {
  const field = value?.[key];
  return Array.isArray(field) ? field : [];
}

function severityWeight(severity: BenchDegradedFactSeverity): number {
  if (severity === "critical") return 0;
  if (severity === "high") return 1;
  if (severity === "medium") return 2;
  return 3;
}

function factKey(fact: BenchDegradedFact): string {
  return `${fact.kind}\u0000${fact.label}\u0000${fact.detail ?? ""}`;
}

function summarizeTaskState(tasks: Task[]): BenchProjectSituation["tasks"] {
  const unfinished = tasks.filter((task) => task.status !== "done" && task.status !== "dropped");
  const active = unfinished.filter((task) => task.status === "claimed" || task.status === "in_progress").length;
  const blocked = unfinished.filter((task) => task.status === "blocked" || (task.blocked_by?.length ?? 0) > 0).length;
  const open = tasks.filter((task) => task.status === "open").length;
  const unowned = unfinished.filter((task) => !task.owner).length;
  const assigned = unfinished.filter((task) => Boolean(task.owner)).length;
  const nextTask = unfinished.find((task) => task.status === "in_progress")
    ?? unfinished.find((task) => task.status === "claimed")
    ?? unfinished.find((task) => task.status === "open" && (task.blocked_by?.length ?? 0) === 0)
    ?? unfinished.find((task) => task.status === "blocked" || (task.blocked_by?.length ?? 0) > 0);
  return {
    open,
    active,
    blocked,
    unowned,
    assigned,
    ...(nextTask ? { next: summarizeTask(nextTask) } : {}),
  };
}

function summarizeContributors(input: {
  linkedAgents: BenchProjectAgent[];
  knownAgents: Map<string, BenchProjectAgent>;
  runs: RunJournal[];
  tasks: Task[];
  signals: WorkspaceContext["active_signals"];
  otherAgents: NonNullable<WorkspaceContext["other_agents"]>;
}): BenchProjectContributor[] {
  const contributors = new Map<string, BenchProjectContributor>();
  const upsert = (agentId: string): BenchProjectContributor => {
    const known = input.linkedAgents.find((agent) => agent.agent_id === agentId) ?? input.knownAgents.get(agentId);
    const existing = contributors.get(agentId);
    if (existing) return existing;
    const created: BenchProjectContributor = {
      agent_id: agentId,
      name: known?.name ?? agentId,
      linked: false,
      legacy: agentId === "agent",
      status: agentId === "agent" ? "legacy" : "seen",
      sources: [],
      viewRuns: 0,
      activeRuns: 0,
      openTasks: 0,
      claims: 0,
      currentFocus: known?.currentFocus,
      role: known?.role,
    };
    contributors.set(agentId, created);
    return created;
  };

  for (const agent of input.linkedAgents) {
    const contributor = upsert(agent.agent_id);
    contributor.linked = true;
    contributor.name = agent.name;
    contributor.role = agent.role;
    contributor.currentFocus = agent.currentFocus;
    addSource(contributor, "linked");
  }
  for (const run of input.runs) {
    const contributor = upsert(run.agent_id);
    contributor.viewRuns += 1;
    if (run.status === "in_progress") contributor.activeRuns += 1;
    contributor.lastSeenAt = maxIso(contributor.lastSeenAt, run.finished_at ?? run.updated_at ?? run.started_at);
    addSource(contributor, "view");
  }
  for (const task of input.tasks) {
    if (!task.owner || task.status === "done" || task.status === "dropped") continue;
    const contributor = upsert(task.owner);
    contributor.openTasks += 1;
    contributor.lastSeenAt = maxIso(contributor.lastSeenAt, task.updated_at);
    addSource(contributor, "task");
  }
  for (const signal of input.signals) {
    const contributor = upsert(signal.owner);
    contributor.claims += 1;
    addSource(contributor, "claim");
  }
  for (const other of input.otherAgents) {
    const contributor = upsert(other.agent_id);
    contributor.activeRuns += other.active_runs.length;
    contributor.openTasks += other.in_progress_tasks.length;
    contributor.claims += other.claims.length;
    if (other.active_runs.length > 0) addSource(contributor, "view");
    if (other.in_progress_tasks.length > 0) addSource(contributor, "task");
    if (other.claims.length > 0) addSource(contributor, "claim");
  }

  for (const contributor of contributors.values()) {
    if (contributor.activeRuns > 0 || contributor.openTasks > 0 || contributor.claims > 0) {
      contributor.status = "active";
    } else if (contributor.linked) {
      contributor.status = "linked";
    } else if (contributor.legacy) {
      contributor.status = "legacy";
    } else {
      contributor.status = "seen";
    }
  }

  return [...contributors.values()].sort((a, b) => {
    const weight = (entry: BenchProjectContributor): number =>
      entry.status === "active" ? 0 : entry.linked ? 1 : entry.status === "seen" ? 2 : 3;
    const byWeight = weight(a) - weight(b);
    if (byWeight !== 0) return byWeight;
    return a.agent_id.localeCompare(b.agent_id);
  });
}

function summarizeBlockers(reasons: string[], attentionState: BenchProjectAttention, tasks: Task[]): BenchProjectBlocker[] {
  const blockers = new Map<string, BenchProjectBlocker>();
  for (const factorEntry of attentionState.factors) {
    const blockerKinds: BenchAttentionKind[] = [
      "missing_root",
      "missing_view",
      "view_error",
      "preflight_failed",
      "view_success_below_required",
      "daemon_unreachable",
    ];
    if (!blockerKinds.includes(factorEntry.kind)) continue;
    if (factorEntry.severity !== "critical" && factorEntry.severity !== "high") continue;
    blockers.set(factorEntry.label, {
      label: factorEntry.label,
      severity: factorEntry.severity,
      source: factorEntry.kind === "daemon_unreachable" ? "space" : "view",
    });
  }
  for (const reason of reasons) {
    if (!reason.toLowerCase().includes("missing") && !reason.toLowerCase().includes("failed")) continue;
    if (!blockers.has(reason)) blockers.set(reason, { label: reason, severity: "high", source: "view" });
  }
  for (const task of tasks) {
    const blockerCount = task.blocked_by?.length ?? 0;
    if (task.status !== "blocked" && blockerCount === 0) continue;
    blockers.set(task.task_id, {
      label: `Task ${task.task_id.slice(0, 8)} blocked`,
      detail: blockerCount > 0 ? `${blockerCount} blocker${blockerCount === 1 ? "" : "s"}: ${task.title}` : task.title,
      severity: "medium",
      source: "task",
    });
  }
  return [...blockers.values()];
}

function situationSummary(status: BenchProjectStatus, blockerCount: number, nextTask?: BenchTaskSummary): string {
  if (blockerCount > 0) return `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} need review before the project is clear.`;
  if (nextTask) return `Next task is ${shortTask(nextTask)}.`;
  if (status === "active") return "Active work is present.";
  if (status === "quiet") return "No immediate action recorded.";
  return "Review recommended.";
}

function addSource(contributor: BenchProjectContributor, source: BenchProjectAgentSource): void {
  if (!contributor.sources.includes(source)) contributor.sources.push(source);
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!right) return left;
  if (!left) return right;
  return right > left ? right : left;
}

function validationTone(status: BenchValidationSummary["status"] | undefined): BenchSituationMetric["tone"] {
  if (status === "passed") return "good";
  if (status === "failed") return "bad";
  if (status === "skipped") return "warn";
  return "neutral";
}

function shortTask(task: BenchTaskSummary): string {
  return `[${task.id.slice(0, 8)}] ${task.title}`;
}

function inspectContext(context: WorkspaceContext): BenchProjectInspectors {
  const current = context.current_run ? summarizeRun(context.current_run) : undefined;
  const latest = context.latest_run ? summarizeRun(context.latest_run) : current;
  const active = uniqueRuns([
    ...(context.current_run?.status === "in_progress" ? [context.current_run] : []),
    ...(context.active_runs ?? []),
  ]).map(summarizeRun);
  const latestValidation = current?.latestValidation ?? latest?.latestValidation;
  return {
    runs: { current, latest, active },
    tasks: {
      openCount: context.open_tasks_count ?? 0,
      active: (context.active_tasks ?? []).map(summarizeTask),
    },
    signals: context.active_signals.map(summarizeSignal),
    validation: {
      status: latestValidation?.status ?? "unknown",
      latest: latestValidation,
    },
    nextActions: (context.next_actions ?? []).map(summarizeNextAction),
  };
}

function emptyInspectors(): BenchProjectInspectors {
  return {
    runs: { active: [] },
    tasks: { openCount: 0, active: [] },
    signals: [],
    validation: { status: "unknown" },
    nextActions: [],
  };
}

function summarizeRun(run: RunJournal): BenchRunSummary {
  const validation = run.validation.map(summarizeValidation);
  return {
    id: run.run_id,
    goal: run.goal,
    status: run.status,
    agent: run.agent_id,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    finishedAt: run.finished_at,
    changedPaths: run.changed_paths,
    validation,
    latestValidation: validation.at(-1),
  };
}

function summarizeValidation(entry: RunValidationEntry): BenchValidationSummary {
  return {
    command: entry.command,
    status: entry.status,
    recordedAt: entry.recorded_at,
    notes: entry.notes,
  };
}

function summarizeTask(task: NonNullable<WorkspaceContext["active_tasks"]>[number]): BenchTaskSummary {
  return {
    id: task.task_id,
    title: task.title,
    description: task.description,
    status: task.status,
    owner: task.owner,
    blockedByCount: task.blocked_by?.length ?? 0,
    relatedRuns: task.related_runs,
  };
}

function summarizeSignal(signal: WorkspaceContext["active_signals"][number]): BenchSignalSummary {
  return {
    id: signal.id,
    type: signal.type,
    target: signal.target,
    owner: signal.owner,
    intent: signal.intent,
    expiresAt: signal.expires_at,
  };
}

function summarizeNextAction(action: NextAction): BenchNextActionSummary {
  return {
    kind: action.kind,
    reason: action.reason,
    risk: action.risk,
    requiresHuman: action.requires_human,
    command: action.command,
    path: action.path,
  };
}

function uniqueRuns(runs: RunJournal[]): RunJournal[] {
  const seen = new Set<string>();
  const uniqueRunsById: RunJournal[] = [];
  for (const run of runs) {
    if (seen.has(run.run_id)) continue;
    seen.add(run.run_id);
    uniqueRunsById.push(run);
  }
  return uniqueRunsById;
}

function normalizeInboxItem(value: unknown): BenchInboxItem[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const id = stringField(item, "id");
  const sender = stringField(item, "sender_passport_id") ?? stringField(item, "sender");
  const content = stringField(item, "content");
  const createdAt = stringField(item, "created_at") ?? stringField(item, "createdAt");
  if (!id || !sender || !content || !createdAt) return [];
  return [{
    id,
    sender,
    content,
    createdAt,
    space: stringField(item, "space_name") ?? stringField(item, "space_id"),
    ackedAt: stringField(item, "acked_at") ?? stringField(item, "ackedAt"),
  }];
}

function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function classifyContext(context: WorkspaceContext): { status: BenchProjectStatus; reasons: string[]; factors: BenchAttentionFactor[] } {
  const factors: BenchAttentionFactor[] = [];
  const issues = context.preflight?.issues ?? [];
  const issueCodes = new Set(issues.map((issue) => issue.code));
  const hardBroken = issues.some((issue) =>
    issue.severity === "error" && issue.code !== "view_success_below_required"
  );
  if (hardBroken) {
    const hardFactors = issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => factor("view_error", issue.message, 850, "critical"));
    return { status: "broken", reasons: hardFactors.map((entry) => entry.label), factors: hardFactors };
  }
  if ((context.active_runs?.length ?? 0) > 0 || context.current_run) {
    factors.push(factor("active_run", "active run exists", 500, "high"));
  }
  if ((context.active_signals?.length ?? 0) > 0) {
    factors.push(factor("active_signal", "active signals exist", 430, "high"));
  }
  if ((context.active_tasks?.length ?? 0) > 0) {
    factors.push(factor("active_task", "active tasks exist", 420, "high"));
  }

  const hasActiveWork = factors.length > 0;
  if (!context.preflight?.ok) {
    factors.push(...issues.map((issue) => {
      if (issue.code === "view_success_below_required") {
        return factor("view_success_below_required", issue.message, 330, "medium");
      }
      return factor("preflight_failed", issue.message, issue.severity === "error" ? 350 : 230, issue.severity === "error" ? "high" : "medium");
    }));
  }
  if (context.brief?.manifest?.freshness === "stale" || issueCodes.has("manifest_stale")) {
    factors.push(factor("manifest_stale", "manifest is stale", 260, "medium"));
  }
  const dirtyFiles = context.brief?.git_status?.uncommitted_count ?? 0;
  if (dirtyFiles > 0) {
    factors.push(factor("dirty_git", `${dirtyFiles} dirty file${dirtyFiles === 1 ? "" : "s"}`, Math.min(180, dirtyFiles * 5), "low"));
  }
  const openTasks = context.open_tasks_count ?? 0;
  if (openTasks > 0) {
    factors.push(factor("open_task", `${openTasks} open task${openTasks === 1 ? "" : "s"}`, Math.min(160, openTasks * 20), "low"));
  }
  const factorsByScore = attention(factors).factors;
  if (hasActiveWork) return { status: "active", reasons: factorsByScore.map((entry) => entry.label), factors: factorsByScore };
  if (factorsByScore.length > 0) return { status: "attention", reasons: unique(factorsByScore.map((entry) => entry.label)), factors: factorsByScore };

  return { status: "quiet", reasons: ["no immediate attention"], factors: [] };
}

function applyDaemonAttention(project: BenchProject, daemon: BenchDaemonState): BenchProject {
  if (daemon.reachable || !project.space || project.status === "broken") return project;
  const daemonFactor = factor("daemon_unreachable", `Space daemon unreachable for ${project.space}`, 240, "medium");
  const nextFactors = attention([...project.attention.factors, daemonFactor]);
  const status = project.status === "quiet" ? "attention" : project.status;
  const daemonFact: BenchDegradedFact = {
    kind: "daemon_unreachable",
    severity: "medium",
    source: "space",
    scope: "machine",
    label: "Space offline",
    detail: daemonFactor.label,
  };
  const resumption = resumptionWithAdditionalFact(project.situation.resumption, daemonFact, status, project.situation.tasks);
  return {
    ...project,
    status,
    reasons: unique([daemonFactor.label, ...project.reasons.filter((reason) => reason !== "no immediate attention")]),
    attention: nextFactors,
    situation: {
      ...project.situation,
      summary: resumption.summary,
      resumption,
    },
  };
}

function resumptionWithAdditionalFact(
  existing: BenchResumptionState,
  fact: BenchDegradedFact,
  status: BenchProjectStatus,
  taskSummary: BenchProjectSituation["tasks"],
): BenchResumptionState {
  const degraded = [...existing.degraded, fact].filter((entry, index, entries) =>
    entries.findIndex((candidate) => factKey(candidate) === factKey(entry)) === index
  ).sort((a, b) => {
    const bySeverity = severityWeight(a.severity) - severityWeight(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.label.localeCompare(b.label);
  });
  const readiness = decideReadiness(status, degraded, taskSummary);
  const recommendedRepair = selectRecommendedRepair(degraded);
  return {
    readiness,
    label: readinessLabel(readiness),
    summary: resumptionSummary(readiness, degraded, taskSummary),
    degraded,
    ...(recommendedRepair ? { recommendedRepair } : {}),
  };
}

function attention(factors: BenchAttentionFactor[]): BenchProjectAttention {
  const sorted = [...factors].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    return a.label.localeCompare(b.label);
  });
  return {
    score: sorted.reduce((sum, entry) => sum + entry.score, 0),
    primary: sorted[0],
    factors: sorted,
  };
}

function factor(kind: BenchAttentionKind, label: string, score: number, severity: BenchAttentionFactor["severity"]): BenchAttentionFactor {
  return { kind, label, score, severity };
}

function summarize(projects: BenchProject[]): BenchState["summary"] {
  return {
    total: projects.length,
    broken: projects.filter((project) => project.status === "broken").length,
    attention: projects.filter((project) => project.status === "attention").length,
    active: projects.filter((project) => project.status === "active").length,
    quiet: projects.filter((project) => project.status === "quiet").length,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
