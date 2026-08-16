import type { ContinuityPacket, Handoff, NextAction, RunJournal, Signal, ViewPolicy, WorkspaceManifest } from "./schema.js";

export type {
  ArchivedSignal,
  ContinuityPacket,
  ContinuityValidation,
  FileKind,
  Handoff,
  ManifestFile,
  NextAction,
  PathPurpose,
  RecommendedRead,
  RunJournal,
  RunStep,
  RunValidationEntry,
  Signal,
  Task,
  TaskStatus,
  ViewPolicy,
  WorkspaceManifest,
} from "./schema.js";

export type AuditSeverity = "error" | "warning" | "info";

/** Durable View families that can be read independently. */
export type ArtifactFamily =
  | "manifest"
  | "policy"
  | "continuity"
  | "runs"
  | "tasks"
  | "handoffs"
  | "signals"
  | "signals_archive"
  | "knowledge"
  | "resolved_threads";

/**
 * A typed explanation for a durable artifact that could not be returned.
 * `path` is workspace-relative when the artifact lives below the workspace,
 * otherwise it is the resolved absolute path.
 */
export interface ArtifactDiagnostic {
  family: ArtifactFamily;
  path: string;
  code:
    | "invalid_json"
    | "schema_validation"
    | "unsupported_schema_version"
    | "invalid_content"
    | "missing"
    | "unreadable"
    | "io_error";
  reason: string;
}

/**
 * Honest read contract for durable artifacts. A partial read preserves every
 * valid sibling while naming every artifact that could not be returned.
 */
export interface ArtifactReadResult<T> {
  records: T[];
  diagnostics: ArtifactDiagnostic[];
  completeness: "complete" | "partial";
}

export interface AuditIssue {
  severity: AuditSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface AuditReport {
  ok: boolean;
  issues: AuditIssue[];
  checks?: ViewCheck[];
  next_actions?: NextAction[];
}

export interface ViewCheck {
  id: string;
  status: "pass" | "warn" | "fail" | "skipped";
  summary: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface ViewBrief {
  schema_version: "1.0";
  view: {
    present: boolean;
    root: string;
    data_dir: string;
  };
  workspace?: {
    id: string;
    root: string;
    purpose?: string;
    current_focus?: string;
  };
  manifest?: {
    present: boolean;
    updated_at?: string;
    file_count: number;
    recommended_reads: WorkspaceManifest["recommended_reads"];
    important_paths: string[];
    freshness: "fresh" | "stale" | "missing" | "invalid" | "unknown";
    /**
     * How `freshness` was determined. `live` re-hashed the tree; `cached` read a
     * prior audit snapshot; `unknown` means it could not be established at all.
     * Consumers that report trustworthiness must not present a `cached` or
     * `unknown` verdict as though it were `live`.
     */
    freshness_source?: "live" | "cached" | "unknown";
  };
  success: {
    /** The agent whose evidence the level was computed against — L3+ keys on
     * the acting agent's runs, so the same view reads differently per agent. */
    agent: string;
    level: "L0" | "L1" | "L2" | "L3" | "L4";
    label: string;
    summary: string;
    required_level?: "L0" | "L1" | "L2" | "L3" | "L4";
    meets_required: boolean;
  };
  verification_commands: string[];
  known_risks: string[];
  next_actions: NextAction[];
  git_status?: {
    is_repo: boolean;
    is_dirty: boolean;
    uncommitted_count: number;
    uncommitted_paths?: string[];
  };
}

export interface ViewPreflightReport {
  ok: boolean;
  checks: ViewCheck[];
  issues: AuditIssue[];
  next_actions: NextAction[];
}

/**
 * Manifest as it appears in a context payload: per-file entries are never
 * inlined (they dominated the payload — 34KB of 74KB on the seedrop repo).
 * Read `.seedrop/view/manifest.json` directly when the file list is needed.
 */
export interface WorkspaceManifestSummary {
  schema_version: "1.0";
  workspace_id: string;
  root: ".";
  updated_at: string;
  files_count: number;
  path_purposes?: WorkspaceManifest["path_purposes"];
  recommended_reads: WorkspaceManifest["recommended_reads"];
  files_note: string;
}

/** Byte-budget accounting for a context payload. Sizes are compact-JSON bytes. */
export interface ContextBudget {
  limit_bytes: number;
  bytes: number;
  stages_applied: string[];
  exceeded: boolean;
}

export interface WorkspaceContext {
  schema_version?: "1.0";
  view?: {
    present: boolean;
    root: string;
    data_dir: string;
  };
  brief?: ViewBrief;
  manifest?: WorkspaceManifestSummary;
  latest_continuity?: ContinuityPacket;
  active_signals: Signal[];
  current_run?: RunJournal;
  latest_run?: RunJournal;
  active_runs?: RunJournal[];
  active_tasks?: import("./schema.js").Task[];
  open_tasks_count?: number;
  other_agents?: Array<{
    agent_id: string;
    active_runs: Array<{ run_id: string; goal: string; started_at: string; changed_paths: string[] }>;
    claims: Array<{ signal_id: string; target: string; intent: string; expires_at: string }>;
    in_progress_tasks: Array<{ task_id: string; title: string }>;
  }>;
  latest_audit?: AuditReport;
  preflight?: ViewPreflightReport;
  next_actions?: NextAction[];
  budget?: ContextBudget;
}

export interface OpenThread {
  /** Stable short id derived from packet_id + thread text; addressable for resolution. */
  id: string;
  thread: string;
  packet_id: string;
  created_at: string;
  source?: "legacy_continuity" | "run" | "handoff";
}

export interface ResolvedThreadEntry {
  id: string;
  packet_id: string;
  thread: string;
  resolved_at: string;
  note?: string;
}

export interface ThreadList {
  open: OpenThread[];
  resolved: ResolvedThreadEntry[];
}
