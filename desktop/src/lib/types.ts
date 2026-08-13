export type BucketId = "ongoing" | "needs_attention" | "up_next" | "quiet";

export interface AdapterSituationProjection {
  adapter_version: "1.0.0";
  situation_id: string;
  decision_id: string;
  semantic_digest: string;
  bucket: BucketId;
  readiness: "ready" | "active" | "review" | "blocked" | "unknown";
  health: {
    state: "healthy" | "degraded" | "blocked" | "unknown";
    substrate: string;
    freshness: string;
    completeness: string;
    degraded_source_ids: readonly string[];
    quarantine_count: number;
    unresolved_disagreement_count: number;
  };
  decision: {
    disposition: "recommend" | "refuse" | "unknown";
    action: string | null;
    reason: string | null;
    smallest_repair: string | null;
    display: string;
  };
  orientation: {
    intent: unknown;
    risk: unknown;
    delivery: unknown;
    grave: unknown;
    source_health: unknown;
    next_action: unknown;
  };
  trust: Record<string, unknown>;
  budget: Record<string, unknown>;
  warnings: readonly string[];
  mutation_capability: "read_only";
}

export type AdapterSituationSelection =
  | { mode: "v2"; reason: null; warning: null; served: { kind: "v2_situation"; payload: AdapterSituationProjection } }
  | { mode: "v1_fallback"; reason: string; warning: string; served: { kind: "v1"; payload: unknown } };

export interface RuntimeComponent {
  id: string;
  ok: boolean;
  path: string;
  message: string;
}

export interface ExistingInstallEvidence {
  id: string;
  label: string;
  path: string;
  detail: string;
  ownership: "desktop" | "external" | "shared" | string;
}

export interface ExistingCliCandidate {
  path: string;
  target: string;
  kind: "desktop" | "npm" | "source_link" | "unknown" | string;
}

export interface ExistingInstallScan {
  schemaVersion: string;
  status: "none" | "desktop_managed" | "existing_ready" | "existing_partial" | string;
  detected: boolean;
  canAdopt: boolean;
  requiresChoice: boolean;
  summary: string;
  operatorName?: string | null;
  operatorPurpose?: string | null;
  daemonRunning: boolean;
  daemonOwnership: "none" | "desktop" | "external" | string;
  cliCandidates: ExistingCliCandidate[];
  configuredClients: string[];
  wouldReplace: string[];
  evidence: ExistingInstallEvidence[];
}

export interface RuntimeStatus {
  ok: boolean;
  ready: boolean;
  phase: "not_installed" | "setup_required" | "repair_required" | "ready" | string;
  arch: string;
  runtimeVersion?: string | null;
  runtimeRoot?: string | null;
  nodePath?: string | null;
  seedPath?: string | null;
  mcpPath?: string | null;
  observerPath?: string | null;
  wizardCompleted: boolean;
  setupPhase: string;
  setupMode?: "managed" | "adopted_existing" | string | null;
  existingInstall: ExistingInstallScan;
  message: string;
  components: RuntimeComponent[];
}

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface ObserverTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  owner?: string;
  blockedByCount: number;
  relatedRuns: string[];
}

export interface ObserverRun {
  id: string;
  goal: string;
  status: string;
  agent: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface ObserverProject {
  id: string;
  label: string;
  root: string;
  status: "broken" | "attention" | "active" | "quiet";
  currentFocus?: string;
  lastSeenAt?: string;
  counts: {
    activeRuns: number;
    openTasks: number;
    activeSignals: number;
    dirtyFiles: number;
  };
  attention: {
    score: number;
    primary?: { kind: string; label: string };
  };
  inspectors: {
    runs: {
      current?: ObserverRun;
      latest?: ObserverRun;
      active: ObserverRun[];
    };
    tasks: {
      openCount: number;
      active: ObserverTask[];
    };
  };
  situation: {
    summary: string;
    tasks: {
      open: number;
      active: number;
      blocked: number;
      unowned: number;
      assigned: number;
      next?: ObserverTask;
    };
  };
  adapter_situation?: AdapterSituationSelection;
}

export interface ObserverState {
  schema_version?: string;
  generated_at?: string;
  passport?: { agent_id: string; name?: string; active_projects: number };
  summary?: {
    total: number;
    broken: number;
    attention: number;
    active: number;
    quiet: number;
  };
  daemon?: { reachable: boolean; url?: string; error?: string };
  projects: ObserverProject[];
  adapter_contract?: {
    version: "1.0.0";
    enabled: boolean;
    v2_projects: number;
    fallback_projects: number;
  };
}

export interface DoctorReport {
  ok?: boolean;
  checks?: Array<{
    id?: string;
    status?: string;
    summary?: string;
    name?: string;
  }>;
  [key: string]: unknown;
}
