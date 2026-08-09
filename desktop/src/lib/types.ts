export type BucketId = "ongoing" | "needs_attention" | "up_next" | "quiet";

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
