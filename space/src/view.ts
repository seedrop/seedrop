import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z, type ZodType } from "zod";
import {
  TaskBlockedError,
  TaskConflictError,
  TaskNotFoundError,
  InvalidTaskTransitionError,
  InvalidRunTransitionError,
  WorkspaceRunClaimConflictError,
  WorkspaceRunDirtyTreeError,
  WorkspaceRunMissingCauseError,
  WorkspaceRunOwnershipError,
  WorkspaceRunTaskConflictError,
  WorkspaceRunUnloggedChangesError,
  WorkspaceViewError,
  WorkspaceViewParseError,
  WorkspaceViewValidationError,
  SchemaVersionUnsupportedError,
} from "./errors.js";
import { parseAndMigrate, type MigrationChain } from "./migrations.js";
import {
  ContinuityPacketMigrationChain,
  RunJournalMigrationChain,
  TaskMigrationChain,
} from "./schema-migrations.js";
import {
  ContinuityPacketSchema,
  HandoffSchema,
  PathPurposeSchema,
  PolicyPathPurposeSchema,
  RunJournalSchema,
  SignalSchema,
  TaskSchema,
  TaskStatusSchema,
  ViewPolicySchema,
  WorkspaceManifestSchema,
  SignalsArchiveSchema,
  ArchivedSignalSchema,
} from "./schema.js";
import {
  ArchivedSignal,
  ArtifactDiagnostic,
  ArtifactFamily,
  ArtifactReadResult,
  AuditReport,
  ContextBudget,
  ContinuityPacket,
  Handoff,
  ManifestFile,
  NextAction,
  OpenThread,
  PathPurpose,
  RecommendedRead,
  ResolvedThreadEntry,
  RunJournal,
  Signal,
  Task,
  TaskStatus,
  ThreadList,
  ViewBrief,
  WorkspaceContext,
  WorkspaceManifest,
  WorkspaceManifestSummary,
  ViewCheck,
  ViewPolicy,
  ViewPreflightReport,
} from "./types.js";

export type {
  AuditIssue,
  AuditReport,
  AuditSeverity,
  ArtifactDiagnostic,
  ArtifactFamily,
  ArtifactReadResult,
  ContinuityPacket,
  ContinuityValidation,
  FileKind,
  Handoff,
  ManifestFile,
  NextAction,
  OpenThread,
  PathPurpose,
  RecommendedRead,
  ResolvedThreadEntry,
  RunJournal,
  RunStep,
  RunValidationEntry,
  Signal,
  Task,
  TaskStatus,
  ThreadList,
  ViewBrief,
  ViewCheck,
  ViewPolicy,
  ViewPreflightReport,
  WorkspaceContext,
  WorkspaceManifest,
} from "./types.js";
export {
  ContinuityPacketSchema,
  ContinuityValidationSchema,
  FileKindSchema,
  ManifestFileSchema,
  HandoffSchema,
  NextActionSchema,
  PathPurposeSchema,
  PolicyPathPurposeSchema,
  RecommendedReadSchema,
  RunJournalSchema,
  RunStepSchema,
  RunValidationEntrySchema,
  SignalSchema,
  TaskSchema,
  TaskStatusSchema,
  ViewPolicySchema,
  WorkspaceManifestSchema,
} from "./schema.js";
export {
  TaskBlockedError,
  TaskConflictError,
  TaskNotFoundError,
  InvalidTaskTransitionError,
  InvalidRunTransitionError,
  WorkspaceRunClaimConflictError,
  WorkspaceRunDirtyTreeError,
  WorkspaceRunMissingCauseError,
  WorkspaceRunOwnershipError,
  WorkspaceRunTaskConflictError,
  WorkspaceRunUnloggedChangesError,
  WorkspaceViewError,
  WorkspaceViewParseError,
  WorkspaceViewValidationError,
  SchemaVersionUnsupportedError,
} from "./errors.js";

export interface WorkspaceViewOptions {
  root?: string;
  dataDir?: string;
  agent?: string;
  now?: () => Date;
}

export interface SyncOptions {
  ignore?: string[];
  workspaceId?: string;
  /** Override the pathological-root guard (home dir / filesystem root). */
  force?: boolean;
}

export interface LogInput {
  mission: string;
  summary: string;
  decisions?: string[];
  assumptions?: string[];
  openThreads?: string[];
  validation?: {
    status?: ContinuityPacket["validation"]["status"];
    commands?: string[];
    notes?: string;
  };
  changedPaths?: string[];
  agent?: string;
}

export interface SignalInput {
  type?: Signal["type"];
  target: string;
  owner?: string;
  ttlMs?: number;
  intent: string;
  recovery?: string;
  details?: Record<string, unknown>;
}

export interface ReleaseSignalInput {
  id?: string;
  type?: Signal["type"];
  target?: string;
  owner?: string;
  expiredOnly?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export interface RunStartInput {
  goal: string;
  agent?: string;
  newRun?: boolean;
  taskId?: string;
  claim?: string[];
  force?: boolean;
}

export interface RunUpdateInput {
  summary?: string;
  decision?: string;
  assumption?: string;
  thread?: string;
  changedPaths?: string[];
  nextActions?: NextAction[];
  agent?: string;
  /**
   * Target a specific run instead of "latest active run for this agent."
   * Required when the caller knows the run_id (e.g., they started it
   * earlier in the session). Prevents cross-agent run confusion when
   * identity changes mid-session orphan a run under the old identity
   * while a different run is active under the new identity.
   * Accepts a UUID or a >=4-char unique prefix.
   */
  runId?: string;
}

export interface RunVerifyInput {
  command: string;
  status: "passed" | "failed" | "skipped";
  notes?: string;
  agent?: string;
  runId?: string;
}

/**
 * A dead run, reduced to what a later agent actually needs: what was attempted,
 * what killed it, and where it touched. The negative counterpart to git history
 * — git records what survived, the graveyard records what was tried and abandoned.
 */
export interface Grave {
  run_id: string;
  agent_id: string;
  goal: string;
  status: "failed" | "blocked";
  /** One-line cause of death; null only for runs recorded before causes were required. */
  cause: string | null;
  /** True when a sweeper inferred the death rather than the agent reporting it. */
  swept: boolean;
  finished_at: string;
  changed_paths: string[];
  /** Present only when the query was path-scoped: which of `paths` this grave touches. */
  overlapping_paths?: string[];
}

export interface RunFinishInput {
  status: "completed" | "blocked" | "failed";
  nextActions?: NextAction[];
  agent?: string;
  force?: boolean;
  runId?: string;
  /**
   * Cause of death, required for `failed` and `blocked`. One line. This is the
   * only gate on a non-completed finish — see WorkspaceRunMissingCauseError.
   */
  cause?: string;
  /** Create a task assigned to this agent carrying the run's evidence (ADR 0001: handoffs are tasks). */
  handoffTo?: string;
  /** Optional note for the assigned handoff task; defaults to the run goal. */
  handoffNote?: string;
}

export interface RunStartResult {
  run: RunJournal;
  warnings: string[];
  next_actions: NextAction[];
}

export interface TaskCreateInput {
  title: string;
  description?: string;
  dedupKey?: string;
  fromKnowledge?: string;
  blockedBy?: string[];
  agent?: string;
}

export interface TaskAssignInput {
  taskId: string;
  to: string;
  note?: string;
  agent?: string;
}

export interface TaskDeclineInput {
  taskId: string;
  reason?: string;
  agent?: string;
}

export interface TaskUpdateInput {
  taskId: string;
  description?: string;
  assignedNote?: string;
  fromKnowledge?: string;
  blockedBy?: string[];
  replaceBlockedBy?: boolean;
  agent?: string;
}

export interface TaskPauseInput {
  taskId: string;
  status?: "blocked" | "open";
  agent?: string;
}

export interface TaskDropInput {
  taskId: string;
  reason?: string;
  agent?: string;
}

export interface TaskListFilter {
  status?: TaskStatus;
  owner?: string;
  fromKnowledge?: string;
}

export interface HandoffCreateInput {
  to: string;
  summary: string;
  agent?: string;
  runId?: string;
  blockers?: string[];
  risks?: string[];
  nextActions?: NextAction[];
}

export interface ViewBriefOptions {
  checkFreshness?: boolean;
}

export interface ViewPreflightOptions {
  checkManifestDrift?: boolean;
}

export interface ViewAuditOptions {
  writeCache?: boolean;
}

export interface KnowledgeArtifact {
  path: string;
  content: string;
  metadata: {
    status?: string;
    superseded_by?: string;
    updated_at?: string;
    validated_by?: string;
  };
}

const DEFAULT_DATA_DIR = ".seedrop/view";
const DEFAULT_IGNORE = new Set([".git", "node_modules", "dist", "target", "coverage", ".seedrop", ".DS_Store"]);
const MAX_HASHED_FILE_BYTES = 50 * 1024 * 1024;
const VIEW_FILE_LOCK_RETRY_MS = 25;
const VIEW_FILE_LOCK_TIMEOUT_MS = 30_000;
const VIEW_FILE_LOCK_STALE_MS = 5 * 60_000;
const SUCCESS_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
const ResolvedThreadEntrySchema = z.object({
  id: z.string().min(1),
  packet_id: z.string().min(1),
  thread: z.string().min(1),
  resolved_at: z.string().datetime(),
  note: z.string().min(1).optional(),
}).strict();
const ResolvedThreadsEnvelopeSchema = z.object({
  schema_version: z.literal("1.0"),
  resolved: z.array(z.unknown()),
}).strict();
type ViewSuccessLevel = (typeof SUCCESS_LEVELS)[number];
type ManifestFreshness = NonNullable<ViewBrief["manifest"]>["freshness"];

export const TASK_TRANSITION_TABLE: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  open: Object.freeze<TaskStatus[]>(["claimed", "in_progress", "dropped"]),
  claimed: Object.freeze<TaskStatus[]>(["open", "in_progress", "done", "dropped"]),
  in_progress: Object.freeze<TaskStatus[]>(["open", "blocked", "done", "dropped"]),
  blocked: Object.freeze<TaskStatus[]>(["open", "in_progress", "done", "dropped"]),
  done: Object.freeze<TaskStatus[]>([]),
  dropped: Object.freeze<TaskStatus[]>([]),
});

type RunStatus = RunJournal["status"];
export const RUN_TRANSITION_TABLE: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  in_progress: Object.freeze<RunStatus[]>(["completed", "blocked", "failed"]),
  completed: Object.freeze<RunStatus[]>([]),
  blocked: Object.freeze<RunStatus[]>([]),
  failed: Object.freeze<RunStatus[]>([]),
});

export class WorkspaceView {
  readonly root: string;
  readonly dataDir: string;
  readonly manifestPath: string;
  readonly continuityDir: string;
  readonly signalsDir: string;
  readonly runsDir: string;
  readonly handoffsDir: string;
  readonly tasksDir: string;
  readonly knowledgeDir: string;
  readonly agentsPath: string;
  readonly policyPath: string;
  readonly auditPath: string;
  readonly resolvedThreadsPath: string;
  readonly signalsArchivePath: string;

  private readonly agent: string;
  private readonly now: () => Date;

  private constructor(options: Required<WorkspaceViewOptions>) {
    this.root = path.resolve(options.root);
    this.dataDir = path.isAbsolute(options.dataDir)
      ? options.dataDir
      : path.join(this.root, options.dataDir);
    this.manifestPath = path.join(this.dataDir, "manifest.json");
    this.continuityDir = path.join(this.dataDir, "continuity");
    this.signalsDir = path.join(this.dataDir, "signals");
    this.runsDir = path.join(this.dataDir, "runs");
    this.handoffsDir = path.join(this.dataDir, "handoffs");
    this.tasksDir = path.join(this.dataDir, "tasks");
    this.knowledgeDir = path.join(this.dataDir, "knowledge");
    this.agentsPath = path.join(this.dataDir, "AGENTS.md");
    this.policyPath = path.join(this.dataDir, "policy.json");
    this.auditPath = path.join(this.dataDir, "audit.json");
    this.resolvedThreadsPath = path.join(this.dataDir, "resolved-threads.json");
    this.signalsArchivePath = path.join(this.dataDir, "signals-archive.json");
    this.agent = options.agent;
    this.now = options.now;
  }

  static open(options: WorkspaceViewOptions = {}): WorkspaceView {
    return new WorkspaceView({
      root: options.root ?? process.cwd(),
      dataDir: options.dataDir ?? DEFAULT_DATA_DIR,
      agent: options.agent ?? "agent",
      now: options.now ?? (() => new Date()),
    });
  }

  async init(workspaceId = path.basename(this.root)): Promise<WorkspaceManifest> {
    await this.ensureDirs();
    await this.seedKnowledgeReadme();
    if (existsSync(this.manifestPath)) return this.readManifest();
    const manifest = this.createEmptyManifest(workspaceId);
    await this.writeJson(this.manifestPath, manifest);
    return manifest;
  }

  private async seedKnowledgeReadme(): Promise<void> {
    const readmePath = path.join(this.knowledgeDir, "README.md");
    if (existsSync(readmePath)) return;
    const body = [
      "# View knowledge folder",
      "",
      "Check in checked-along-with-code planning artifacts here: roadmaps,",
      "ADRs, design sketches, sprint definitions, anything an agent should",
      "read before changing code.",
      "",
      "Point at specific files from `.seedrop/view/policy.json` using",
      "`path_purposes` so they surface in the boot block as recommended reads.",
      "",
      "This is a convention, not a schema — write whatever helps the next",
      "agent (human or otherwise) pick up the work.",
      "",
    ].join("\n");
    await writeFile(readmePath, body);
  }

  async sync(options: SyncOptions = {}): Promise<WorkspaceManifest> {
    if (!options.force) this.assertSafeWorkspaceRoot();
    await this.ensureDirs();
    const previous = await this.readManifestIfPresent();
    const policyResult = await this.readPolicyResult();
    if (policyResult.error) {
      throw policyResult.error;
    }
    const policy = policyResult.value;
    const workspaceId = options.workspaceId ?? previous?.workspace_id ?? path.basename(this.root);
    const previousByPath = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
    const policyPurposes = normalizePolicyPathPurposes(policy);
    const files = await this.scanFiles([...(policy?.ignore ?? []), ...(options.ignore ?? [])]);
    const manifestFiles: ManifestFile[] = [];

    for (const filePath of files) {
      const absolutePath = path.join(this.root, filePath);
      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // File raced (deleted between scan and hash) or became unreadable. Skip.
        if (code === "ENOENT" || code === "EPERM" || code === "EACCES") continue;
        throw error;
      }
      // Huge files (>50MB) are almost never useful for orientation and
      // crash readFile when they cross Node's 2 GiB buffer cap. Drop them
      // from the manifest. Hit in $HOME-as-workspace setups (VM disk
      // images, video libraries) — see #21.
      if (fileStat.size > MAX_HASHED_FILE_BYTES) continue;
      let buffer;
      try {
        buffer = await readFile(absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EPERM" || code === "EACCES") continue;
        throw error;
      }
      const previousFile = previousByPath.get(filePath);
      const annotation = policyPurposes.get(filePath);
      const purpose = annotation?.purpose ?? previousFile?.purpose;
      const owner = annotation?.owner ?? previousFile?.owner;
      const confidence = annotation?.confidence ?? previousFile?.confidence;
      manifestFiles.push({
        path: filePath,
        kind: classifyFile(filePath),
        size_bytes: fileStat.size,
        hash: createHash("sha256").update(buffer).digest("hex"),
        ...(purpose ? { purpose } : {}),
        ...(owner ? { owner } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      });
    }

    const manifest: WorkspaceManifest = {
      schema_version: "1.0",
      workspace_id: workspaceId,
      root: ".",
      updated_at: this.nowIso(),
      files: manifestFiles.sort((a, b) => comparePaths(a.path, b.path)),
      path_purposes: [...policyPurposes.entries()]
        .map(([pathKey, annotation]) => ({
          path: pathKey,
          purpose: annotation.purpose,
          ...(annotation.owner ? { owner: annotation.owner } : {}),
          ...(annotation.confidence !== undefined ? { confidence: annotation.confidence } : {}),
        }))
        .sort((a, b) => comparePaths(a.path, b.path)),
      recommended_reads: this.recommendedReads(manifestFiles, policyPurposes),
    };

    await this.writeJson(this.manifestPath, manifest);

    // Sync is the natural maintenance moment: sweep long-expired signals into
    // the archive so audit warnings clear without manual releases, and fold
    // any legacy pending handoffs into assigned tasks (ADR 0001).
    try {
      await this.gcExpiredSignals();
    } catch {
      // intentional: GC must never fail a sync
    }
    try {
      await this.migratePendingHandoffs();
    } catch {
      // intentional: migration must never fail a sync
    }
    try {
      await this.migrateOpenThreads();
    } catch {
      // intentional: migration must never fail a sync
    }

    return manifest;
  }

  async readManifest(): Promise<WorkspaceManifest> {
    return this.readJson(this.manifestPath, WorkspaceManifestSchema);
  }

  async readManifestArtifact(): Promise<ArtifactReadResult<WorkspaceManifest>> {
    return this.readSingleArtifact("manifest", this.manifestPath, WorkspaceManifestSchema, { required: true });
  }

  async readPolicyArtifact(): Promise<ArtifactReadResult<ViewPolicy>> {
    return this.readSingleArtifact("policy", this.policyPath, ViewPolicySchema);
  }

  async log(input: LogInput): Promise<ContinuityPacket> {
    await this.ensureDirs();
    const packet: ContinuityPacket = {
      schema_version: "1.0",
      id: randomUUID(),
      created_at: this.nowIso(),
      agent: input.agent ?? this.agent,
      mission: input.mission,
      summary: input.summary,
      decisions: input.decisions ?? [],
      assumptions: input.assumptions ?? [],
      open_threads: input.openThreads ?? [],
      validation: {
        status: input.validation?.status ?? "unknown",
        commands: input.validation?.commands ?? [],
        ...(input.validation?.notes ? { notes: input.validation.notes } : {}),
      },
      changed_paths: this.toWorkspaceRelativeMany(input.changedPaths ?? []),
      git_status: this.snapshotGitStatus(),
    };

    const filename = `${compactTimestamp(packet.created_at)}_${sanitizeFilename(input.mission)}.json`;
    await this.writeJson(path.join(this.continuityDir, filename), packet);
    await this.writeAgentsMd(packet);
    for (const thread of packet.open_threads) {
      await this.materializeThreadTask(packet.id, thread, "packet");
    }
    return packet;
  }

  private async writeAgentsMd(latest: ContinuityPacket): Promise<void> {
    let manifest: WorkspaceManifest | undefined;
    try {
      manifest = await this.readManifest();
    } catch {
      manifest = undefined;
    }

    const recommendedReads = manifest?.recommended_reads ?? [];
    const lines = [
      "# Seedrop View",
      "",
      "This file is generated by `seed view log` from `.seedrop/view/` state.",
      "",
      "## Workspace",
      `- root: ${manifest?.root ?? "."}`,
      `- workspace_id: ${manifest?.workspace_id ?? path.basename(this.root)}`,
      `- manifest_updated_at: ${manifest?.updated_at ?? "unknown"}`,
      "",
      "## Latest Continuity",
      `- created_at: ${latest.created_at}`,
      `- agent: ${latest.agent}`,
      `- mission: ${latest.mission}`,
      `- summary: ${latest.summary}`,
      `- validation: ${latest.validation.status}`,
    ];

    if (latest.changed_paths.length > 0) {
      lines.push("- changed_paths:");
      for (const changedPath of latest.changed_paths) lines.push(`  - ${changedPath}`);
    }
    if (latest.open_threads.length > 0) {
      lines.push("- open_threads:");
      for (const thread of latest.open_threads) lines.push(`  - ${thread}`);
    }

    lines.push("", "## Recommended Reads");
    if (recommendedReads.length > 0) {
      for (const read of recommendedReads.slice(0, 8)) {
        lines.push(`- ${read.path}${read.reason ? ` - ${read.reason}` : ""}`);
      }
    } else {
      lines.push("- AGENTS.md");
    }

    lines.push(
      "",
      "## Agent Reflex",
      "- Run `seed continuity` for full orientation.",
      "- Use `seed view context --json` when you need structured state.",
      "- Start or attach a run before meaningful edits.",
      "",
    );

    await writeFile(this.agentsPath, lines.join("\n"), "utf8");
  }

  private snapshotGitStatus(): NonNullable<ContinuityPacket["git_status"]> {
    const dirty = this.gitDirtyState();
    if (!dirty.inside) {
      return { is_repo: false, is_dirty: false, uncommitted_count: 0 };
    }
    // The packet records all dirty paths (tracked + untracked) so the
    // downstream agent sees the full state of the worktree. Only the
    // run-finish gate distinguishes the two — see f3fc8250.
    const paths = [...dirty.tracked, ...dirty.untracked];
    return {
      is_repo: true,
      is_dirty: paths.length > 0,
      uncommitted_count: paths.length,
      ...(paths.length > 0 ? { uncommitted_paths: paths.slice(0, 50) } : {}),
    };
  }

  async claimSignal(input: SignalInput): Promise<Signal> {
    await this.ensureDirs();
    const createdAt = this.now();
    const ttlMs = input.ttlMs ?? 60 * 60 * 1000;
    const signal: Signal = {
      id: randomUUID(),
      type: input.type ?? "claim",
      target: this.toWorkspaceRelative(input.target),
      owner: input.owner ?? this.agent,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + ttlMs).toISOString(),
      intent: input.intent,
      ...(input.recovery ? { recovery: input.recovery } : {}),
      ...(input.details ? { details: input.details } : {}),
    };

    const filename = `${signal.type}_${sanitizeFilename(signal.target)}_${signal.id}.json`;
    await this.writeJson(path.join(this.signalsDir, filename), signal);
    return signal;
  }

  async releaseSignal(input: ReleaseSignalInput): Promise<Signal[]> {
    const signals = this.requireComplete(
      await this.readSignals({ includeExpired: true }),
      "release signals",
    );
    // Relativize target at the input boundary so the comparison in
    // matchesSignal is apples-to-apples with the stored signal.target.
    const normalized: ReleaseSignalInput = input.target
      ? { ...input, target: this.toWorkspaceRelative(input.target) }
      : input;
    const nowMs = this.now().getTime();
    const matched = signals.filter((signal) => {
      if (!matchesSignal(signal, normalized)) return false;
      return !normalized.expiredOnly || Date.parse(signal.expires_at) <= nowMs;
    });
    if (normalized.dryRun) {
      return matched;
    }
    const broadActiveRelease = !normalized.id && !normalized.target && matched.some((signal) => Date.parse(signal.expires_at) > nowMs);
    if (broadActiveRelease && !normalized.force) {
      throw new Error(
        "Refusing to release active signals from a broad match. Use --expired to clean only expired signals, --target/--id to narrow the match, or --force to release active matches.",
      );
    }

    const released: Signal[] = [];
    for (const signal of matched) {
      const filename = await this.findSignalFilename(signal.id);
      if (filename) {
        await unlink(path.join(this.signalsDir, filename));
        released.push(signal);
      }
    }

    return released;
  }

  async startRun(input: RunStartInput): Promise<RunStartResult> {
    await this.ensureDirs();
    const agentId = input.agent ?? this.agent;
    const active = this.requireComplete(await this.readRuns(), "start a run")
      .filter((run) => run.agent_id === agentId && run.status === "in_progress");
    if (active.length > 0 && !input.newRun) {
      return {
        run: active.at(-1)!,
        warnings: [`Active run already exists for ${agentId}. Finish it or pass --new to start another run.`],
        next_actions: [
          commandAction("seed run finish --status completed", "medium", `Finish or resume active run ${active.at(-1)!.run_id}.`),
        ],
      };
    }

    const resolvedTaskId = input.taskId ? await this.resolveTaskId(input.taskId) : undefined;

    if (!input.force) {
      if (resolvedTaskId) {
        const task = await this.getTask(resolvedTaskId);
        if (task.owner && task.owner !== agentId && task.status !== "done" && task.status !== "dropped") {
          throw new WorkspaceRunTaskConflictError(task.task_id, task.owner, task.status);
        }
        if (task.blocked_by && task.blocked_by.length > 0) {
          await this.assertNotBlocked(task);
        }
      }
      if (input.claim && input.claim.length > 0) {
        const signals = this.requireComplete(await this.readSignals(), "claim run paths");
        const targets = new Set(this.toWorkspaceRelativeMany(input.claim));
        const conflicts = signals
          .filter((s) => s.owner !== agentId && targets.has(s.target))
          .map((s) => ({
            path: s.target,
            owner: s.owner,
            signalId: s.id,
            intent: s.intent,
            expiresAt: s.expires_at,
          }));
        if (conflicts.length > 0) {
          throw new WorkspaceRunClaimConflictError(conflicts);
        }
      }
    }

    const now = this.nowIso();
    const run: RunJournal = {
      schema_version: "1.0",
      run_id: randomUUID(),
      agent_id: agentId,
      goal: input.goal,
      status: "in_progress",
      started_at: now,
      updated_at: now,
      steps: [],
      decisions: [],
      assumptions: [],
      open_threads: [],
      changed_paths: [],
      validation: [],
      next_actions: [],
    };
    await this.writeRun(run);
    if (resolvedTaskId) {
      await this.linkTaskRun(resolvedTaskId, run.run_id);
    }
    if (input.claim && input.claim.length > 0) {
      for (const target of input.claim) {
        await this.claimSignal({
          target,
          intent: `run ${run.run_id.slice(0, 8)}: ${input.goal}`,
          owner: agentId,
          details: { run_id: run.run_id },
        });
      }
    }
    return { run, warnings: [], next_actions: [] };
  }

  /**
   * Resolve the target run for a mutating verb. Prefers explicit runId
   * (avoids the "latest active run for current agent" foot-gun when
   * identity changes mid-session). Falls back to requireActiveRun.
   */
  private async resolveTargetRun(input: { agent?: string; runId?: string }): Promise<RunJournal> {
    if (input.runId) {
      const fullId = await this.resolveRunId(input.runId);
      const run = this.requireComplete(await this.readRuns(), "target a run").find((r) => r.run_id === fullId);
      if (!run) throw new Error(`Run ${fullId} not found.`);
      // Guard against silent cross-owner takeover: targeting a run by id must
      // not let one identity mutate (log/verify/finish) another agent's run
      // and misattribute the work. The resolving identity is `input.agent ??
      // this.agent`, so the documented `seed run finish --agent <owner>`
      // recovery path still resolves cleanly to the owner.
      const resolvedAgent = input.agent ?? this.agent;
      if (run.agent_id !== resolvedAgent) {
        throw new WorkspaceRunOwnershipError(run.run_id, run.agent_id, resolvedAgent);
      }
      return run;
    }
    return this.requireActiveRun(input.agent);
  }

  async logRun(input: RunUpdateInput): Promise<RunJournal> {
    const selected = await this.resolveTargetRun(input);
    const resolvedAgent = input.agent ?? this.agent;
    // Relativize once at the input boundary so we cannot store a path the
    // RelativePath schema would reject on the next read.
    const relativeChangedPaths = this.toWorkspaceRelativeMany(input.changedPaths ?? []);
    return await this.mutateRun(selected.run_id, async (run) => {
      this.assertRunOwner(run, resolvedAgent);
      if (input.summary) {
        run.steps.push({
          summary: input.summary,
          recorded_at: this.nowIso(),
          changed_paths: relativeChangedPaths,
        });
      }
      if (input.decision) run.decisions.push(input.decision);
      if (input.assumption) run.assumptions.push(input.assumption);
      if (input.thread) run.open_threads.push(input.thread);
      run.changed_paths = uniqueStrings([...run.changed_paths, ...relativeChangedPaths]);
      if (input.nextActions) run.next_actions = input.nextActions;
    });
  }

  async decideRun(decision: string, input: { agent?: string } = {}): Promise<RunJournal> {
    return await this.logRun({ decision, agent: input.agent });
  }

  async threadRun(thread: string, input: { agent?: string } = {}): Promise<RunJournal> {
    const run = await this.logRun({ thread, agent: input.agent });
    await this.materializeThreadTask(run.run_id, thread, "run");
    return run;
  }

  /**
   * ADR 0001: a thread is an ownerless open task. Materialization is
   * idempotent via dedup_key thread:<derived-id> and skips threads already
   * resolved in the legacy ledger.
   */
  private async materializeThreadTask(sourceId: string, thread: string, source: string): Promise<Task | null> {
    const id = threadId(sourceId, thread);
    const resolved = new Set((await this.readResolvedThreads()).map((entry) => entry.id));
    if (resolved.has(id)) return null;
    return await this.createTask({
      title: truncateText(thread, 100),
      description: `Open thread from ${source} ${sourceId}: ${thread}`,
      dedupKey: `thread:${id}`,
    });
  }

  async verifyRun(input: RunVerifyInput): Promise<RunJournal> {
    const selected = await this.resolveTargetRun(input);
    const resolvedAgent = input.agent ?? this.agent;
    return await this.mutateRun(selected.run_id, async (run) => {
      this.assertRunOwner(run, resolvedAgent);
      run.validation.push({
        command: input.command,
        status: input.status,
        recorded_at: this.nowIso(),
        ...(input.notes ? { notes: input.notes } : {}),
      });
    });
  }

  async finishRun(input: RunFinishInput): Promise<RunJournal> {
    const selected = await this.resolveTargetRun(input);
    const resolvedAgent = input.agent ?? this.agent;
    return await this.mutateRun(selected.run_id, async (run) => {
      this.assertRunOwner(run, resolvedAgent);
      this.transitionRun(run, input.status, "finish");
      // Asymmetric on purpose. Completing is gated on committed work; dying only
      // costs one line. Failure has to be the path of least resistance or the
      // graveyard stays empty and the corpus becomes a highlight reel.
      if (input.status === "failed" || input.status === "blocked") {
        const cause = input.cause?.trim();
        if (!cause) throw new WorkspaceRunMissingCauseError(input.status);
        run.cause = cause;
      }
      if (input.status === "completed" && !input.force) {
        const gitDirty = this.gitDirtyState();
        if (gitDirty.inside) {
          if (run.changed_paths.length > 0) {
            // A path the run itself logged is claimed work product, so an
            // untracked one is not scratch — it is new work that would vanish.
            // Gating only on tracked paths (task f3fc8250) let any run whose
            // output was entirely new files complete with nothing committed:
            // 56 runs across this corpus were marked completed while their work
            // never reached git, most of them new untracked files.
            const dirtySet = new Set([...gitDirty.tracked, ...gitDirty.untracked]);
            const dirtyChanged = run.changed_paths.filter((p) => dirtySet.has(p));
            if (dirtyChanged.length > 0) {
              throw new WorkspaceRunDirtyTreeError(dirtyChanged, run.changed_paths);
            }
          } else if (gitDirty.tracked.length > 0) {
            // Nothing was logged, so we cannot tell work product from noise.
            // Only tracked edits are evidence enough to refuse here — untracked
            // files at large really are usually build output or scratch notes.
            throw new WorkspaceRunUnloggedChangesError(gitDirty.tracked);
          }
        }
      }
      run.finished_at = this.nowIso();
      if (input.nextActions) run.next_actions = input.nextActions;

      // A finished run's claims are residue, not active collision warnings —
      // archive them on every terminal status (completed, blocked, failed).
      try {
        await this.releaseRunClaims(run);
      } catch {
        // intentional: claim cleanup must never fail a finish
      }

      if (input.handoffTo) {
        await this.createHandoffTask({
          recipient: input.handoffTo,
          sourceAgent: run.agent_id,
          summary: input.handoffNote ?? run.goal,
          run,
        });
      }

      if (input.status === "completed") {
        // Auto-sync the manifest so the View reflects the post-run state.
        // Swallowed if policy is invalid — `seed view sync` will surface the error explicitly.
        try {
          await this.sync();
        } catch {
          // intentional: dedicated sync command surfaces policy errors
        }

        // Nudge for reasoning when a run changed real code and recorded none.
        //
        // The corpus says this field is where the ledger is thinnest: decisions
        // appear on 16.4% of runs and open_threads on 1.3%, against 100% for
        // changed_paths. So the record captures what moved and almost never why
        // — which is the half a later agent cannot reconstruct from git, and the
        // reason benchmark v2 has 6 independent facts to test instead of 100.
        // Suggested, never required: a run with nothing worth saying should not
        // be forced to invent something.
        if (run.changed_paths.length > 0 && run.decisions.length === 0) {
          const suggestion = commandAction(
            'seed run decision "..."',
            "low",
            "This run changed files but recorded no decision. One line on why you chose this approach is the part git cannot recover.",
          );
          if (!run.next_actions.some((existing) => existing.command === suggestion.command)) {
            run.next_actions = [...run.next_actions, suggestion];
          }
        }

        // Suggest a continuity packet if this run had non-trivial activity
        // and no packet has been written since the run started.
        const nonTrivial =
          run.changed_paths.length > 0 ||
          run.validation.length > 0 ||
          run.decisions.length > 0 ||
          run.open_threads.length > 0 ||
          run.steps.length > 1;
        if (nonTrivial) {
          const packets = await this.safeListContinuityPackets();
          const hasRecentPacket = packets.some((p) => p.created_at >= run.started_at);
          if (!hasRecentPacket) {
            const suggestion = commandAction(
              'seed view log --mission "..." --summary "..."',
              "low",
              "Log a continuity packet to capture this run's outcome — no packet has been written since the run started.",
            );
            if (!run.next_actions.some((existing) => existing.command === suggestion.command)) {
              run.next_actions = [...run.next_actions, suggestion];
            }
          }
        }
      }
    });
  }

  async readRuns(): Promise<ArtifactReadResult<RunJournal>> {
    const result = await this.readArtifactDirectory(
      "runs",
      this.runsDir,
      (filePath) => this.readJsonMigrated(filePath, RunJournalMigrationChain, RunJournalSchema),
    );
    result.records.sort((a, b) => a.started_at.localeCompare(b.started_at));
    return result;
  }

  async listRuns(): Promise<RunJournal[]> {
    const result = await this.readRuns();
    this.reportArtifactDiagnostics(result.diagnostics);
    return result.records;
  }

  /**
   * Mark long-abandoned `in_progress` runs as failed.
   *
   * An agent that crashes, loses its session, or simply moves on leaves a run
   * open forever. Those are the most common real failures and the least likely
   * to be recorded, because nobody comes back to a dead session to file a
   * report. Sweeping them is how the graveyard gets the deaths nobody was
   * around to witness.
   *
   * Swept runs are marked `swept: true` so they read as inferred rather than
   * reported — a later agent should trust a hand-written cause more than
   * "nobody touched this for a week".
   */
  async sweepOrphanedRuns(opts: { olderThanHours?: number; now?: Date } = {}): Promise<RunJournal[]> {
    const olderThanHours = opts.olderThanHours ?? 72;
    const cutoff = (opts.now ?? new Date(this.nowIso())).getTime() - olderThanHours * 3_600_000;
    const runs = this.requireComplete(await this.readRuns(), "sweep orphaned runs");
    const swept: RunJournal[] = [];
    for (const candidate of runs) {
      if (candidate.status !== "in_progress") continue;
      const lastTouched = Date.parse(candidate.updated_at || candidate.started_at);
      if (Number.isNaN(lastTouched) || lastTouched > cutoff) continue;
      const idleHours = Math.floor(((opts.now ?? new Date(this.nowIso())).getTime() - lastTouched) / 3_600_000);
      const updated = await this.mutateRun(candidate.run_id, async (run) => {
        this.transitionRun(run, "failed", "sweep");
        run.finished_at = this.nowIso();
        run.swept = true;
        run.cause = `abandoned: no activity for ${idleHours}h (swept, not reported by the agent)`;
        try {
          await this.releaseRunClaims(run);
        } catch {
          // intentional: claim cleanup must never fail a sweep
        }
      });
      swept.push(updated);
    }
    return swept;
  }

  /**
   * Dead runs relevant to the paths an agent is about to touch.
   *
   * This is the whole point of recording failures. "Three prior approaches
   * touched this area and all three died, here is what killed them" is the one
   * thing a fresh agent cannot derive from git, the repo, or the file it is
   * about to edit — git shows what survived, never what was abandoned.
   *
   * Ranked most-recent-first, filtered to runs whose changed_paths intersect
   * `paths` when given, otherwise the most recent graves overall.
   */
  async listGraves(opts: { paths?: readonly string[]; limit?: number } = {}): Promise<Grave[]> {
    const limit = opts.limit ?? 5;
    const runs = await this.listRuns();
    const scope = opts.paths?.length ? new Set(opts.paths.map((p) => p.replace(/^\.\//, ""))) : null;
    const graves: Grave[] = [];
    for (const run of runs) {
      if (run.status !== "failed" && run.status !== "blocked") continue;
      const overlap = scope ? run.changed_paths.filter((p) => scope.has(p)) : [];
      if (scope && overlap.length === 0) continue;
      graves.push({
        run_id: run.run_id,
        agent_id: run.agent_id,
        goal: run.goal,
        status: run.status,
        cause: run.cause ?? null,
        swept: run.swept === true,
        finished_at: run.finished_at ?? run.updated_at,
        changed_paths: run.changed_paths,
        ...(scope ? { overlapping_paths: overlap } : {}),
      });
    }
    graves.sort((a, b) => b.finished_at.localeCompare(a.finished_at));
    return graves.slice(0, limit);
  }

  async listRunsWithErrors(): Promise<{ runs: RunJournal[]; malformed: Array<{ filename: string; error: string }> }> {
    const result = await this.readRuns();
    this.reportArtifactDiagnostics(result.diagnostics);
    return {
      runs: result.records,
      malformed: result.diagnostics.map((diagnostic) => ({
        filename: path.basename(diagnostic.path),
        error: diagnostic.reason,
      })),
    };
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  private taskPath(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  async createTask(input: TaskCreateInput): Promise<Task> {
    await this.ensureDirs();
    if (input.dedupKey) {
      const existing = this.requireComplete(await this.readTasks(), "deduplicate task creation")
        .find((task) => task.dedup_key === input.dedupKey && task.title === input.title);
      if (existing) return existing;
    }
    const blockedBy = await this.resolveTaskReferences(input.blockedBy ?? []);
    const now = this.nowIso();
    const task: Task = {
      schema_version: "1.0",
      task_id: randomUUID(),
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.dedupKey ? { dedup_key: input.dedupKey } : {}),
      status: "open",
      ...(input.fromKnowledge ? { from_knowledge: input.fromKnowledge } : {}),
      created_at: now,
      updated_at: now,
      ...(blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
      related_runs: [],
    };
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async getTask(taskId: string): Promise<Task> {
    const canonicalTaskId = await this.resolveTaskId(taskId);
    try {
      return await this.readJsonMigrated(this.taskPath(canonicalTaskId), TaskMigrationChain, TaskSchema);
    } catch (error) {
      const causeCode = ((error as Error & { cause?: NodeJS.ErrnoException })?.cause)?.code;
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || causeCode === "ENOENT") {
        throw new TaskNotFoundError(canonicalTaskId);
      }
      throw error;
    }
  }

  /**
   * Resolve a run ID prefix to the full UUID. Accepts the full UUID
   * unchanged or a >=4-char unique prefix. Cross-references the runs
   * directory directly (not just active runs) so finished/blocked runs
   * are resolvable too. Throws Error on ambiguous or no match.
   */
  async resolveRunId(prefixOrFullId: string): Promise<string> {
    const trimmed = prefixOrFullId.trim();
    if (trimmed.length === 0) throw new Error("Empty run id.");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (trimmed.length < 4) {
      throw new Error(`Run id prefix too short (need >=4 chars): ${trimmed}`);
    }
    const runs = this.requireComplete(await this.readRuns(), "resolve a run id");
    const normalizedPrefix = trimmed.toLowerCase();
    const matches = runs.filter((r) => r.run_id.startsWith(normalizedPrefix));
    if (matches.length === 0) {
      throw new Error(`No run matches prefix ${prefixOrFullId}.`);
    }
    if (matches.length > 1) {
      const sample = matches.slice(0, 3).map((m) => `${m.run_id.slice(0, 12)} (${m.goal})`).join("; ");
      throw new Error(`Run id ${prefixOrFullId} is ambiguous — matches ${matches.length}: ${sample}`);
    }
    return matches[0]!.run_id;
  }

  /**
   * Resolve a task ID prefix to the unique full UUID. Accepts the full
   * UUID unchanged, accepts a >=4-char prefix that uniquely identifies a
   * task. Throws TaskNotFoundError on no match or ambiguous match.
   * This is the CLI ergonomics layer — `seed task list` shows 8-char
   * prefixes; users should be able to paste those back without looking
   * up the full UUID.
   */
  async resolveTaskId(prefixOrFullId: string): Promise<string> {
    const trimmed = prefixOrFullId.trim();
    if (trimmed.length === 0) throw new TaskNotFoundError("(empty)");
    // Full UUID: pass through.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (trimmed.length < 4) {
      throw new TaskNotFoundError(`${trimmed} (prefix too short — need at least 4 hex chars)`);
    }
    const tasks = this.requireComplete(await this.readTasks(), "resolve a task id");
    const normalizedPrefix = trimmed.toLowerCase();
    const matches = tasks.filter((t) => t.task_id.startsWith(normalizedPrefix));
    if (matches.length === 0) {
      throw new TaskNotFoundError(prefixOrFullId);
    }
    if (matches.length > 1) {
      const sample = matches.slice(0, 3).map((m) => `${m.task_id.slice(0, 12)} (${m.title})`).join("; ");
      throw new TaskNotFoundError(`${prefixOrFullId} is ambiguous — matches ${matches.length} tasks: ${sample}`);
    }
    return matches[0]!.task_id;
  }

  private async resolveTaskReferences(ids: readonly string[]): Promise<string[]> {
    const canonical: string[] = [];
    for (const id of ids) canonical.push(await this.resolveTaskId(id));
    return [...new Set(canonical)];
  }

  async readTasks(filter: TaskListFilter = {}): Promise<ArtifactReadResult<Task>> {
    const result = await this.readArtifactDirectory(
      "tasks",
      this.tasksDir,
      (filePath) => this.readJsonMigrated(filePath, TaskMigrationChain, TaskSchema),
    );
    result.records = result.records
      .filter((task) => !filter.status || task.status === filter.status)
      .filter((task) => !filter.owner || task.owner === filter.owner)
      .filter((task) => !filter.fromKnowledge || task.from_knowledge === filter.fromKnowledge)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return result;
  }

  async listTasks(filter: TaskListFilter = {}): Promise<Task[]> {
    const result = await this.readTasks(filter);
    this.reportArtifactDiagnostics(result.diagnostics);
    return result.records;
  }

  async claimTask(taskId: string, agent?: string): Promise<Task> {
    const who = agent ?? this.agent;
    const task = await this.getTask(taskId);
    this.transitionTask(task, "claimed", "claim", who);
    task.owner = who;
    delete task.assigned_by;
    delete task.assigned_note;
    delete task.decline_reason;
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async assignTask(input: TaskAssignInput): Promise<Task> {
    const assigner = input.agent ?? this.agent;
    const task = await this.getTask(input.taskId);
    if (task.status === "done" || task.status === "dropped") {
      throw new TaskConflictError(
        `Task ${input.taskId} cannot be assigned (status: ${task.status}).`,
        { taskId: input.taskId, status: task.status, actor: assigner },
      );
    }
    task.owner = input.to;
    task.assigned_by = assigner;
    if (input.note) task.assigned_note = input.note;
    else delete task.assigned_note;
    if (task.status === "open") this.transitionTask(task, "claimed", "assign", assigner);
    delete task.decline_reason;
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async acceptTask(taskId: string, agent?: string): Promise<Task> {
    const who = agent ?? this.agent;
    const task = await this.getTask(taskId);
    if (task.owner !== who) {
      throw new TaskConflictError(
        `Task ${taskId} is owned by ${task.owner ?? "no one"}; only the owner can accept.`,
        { taskId, owner: task.owner, status: task.status, actor: who },
      );
    }
    if (task.status !== "claimed") {
      throw new TaskConflictError(
        `Task ${task.task_id} cannot be accepted (status: ${task.status}); only claimed assignments can be accepted.`,
        { taskId: task.task_id, owner: task.owner, status: task.status, actor: who },
      );
    }
    delete task.assigned_by;
    delete task.assigned_note;
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async declineTask(input: TaskDeclineInput): Promise<Task> {
    const who = input.agent ?? this.agent;
    const task = await this.getTask(input.taskId);
    if (task.owner !== who) {
      throw new TaskConflictError(
        `Task ${input.taskId} is owned by ${task.owner ?? "no one"}; only the owner can decline.`,
        { taskId: input.taskId, owner: task.owner, status: task.status, actor: who },
      );
    }
    this.transitionTask(task, "open", "decline", who);
    delete task.owner;
    delete task.assigned_by;
    delete task.assigned_note;
    if (input.reason) task.decline_reason = input.reason;
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async updateTask(input: TaskUpdateInput): Promise<Task> {
    const who = input.agent ?? this.agent;
    const task = await this.getTask(input.taskId);
    if (task.status === "done" || task.status === "dropped") {
      throw new TaskConflictError(
        `Task ${input.taskId} cannot be updated (status: ${task.status}).`,
        { taskId: input.taskId, owner: task.owner, status: task.status, actor: who },
      );
    }
    if (task.owner && task.owner !== who && task.assigned_by !== who) {
      throw new TaskConflictError(
        `Task ${input.taskId} is owned by ${task.owner}; only the owner or assigner can update metadata.`,
        { taskId: input.taskId, owner: task.owner, status: task.status, actor: who },
      );
    }

    if (input.description !== undefined) task.description = input.description;
    if (input.assignedNote !== undefined) task.assigned_note = input.assignedNote;
    if (input.fromKnowledge !== undefined) task.from_knowledge = input.fromKnowledge;
    if (input.blockedBy !== undefined || input.replaceBlockedBy) {
      const canonicalBlockers = await this.resolveTaskReferences(input.blockedBy ?? []);
      const next = input.replaceBlockedBy
        ? canonicalBlockers
        : [...(task.blocked_by ?? []), ...canonicalBlockers];
      const unique = Array.from(new Set(next));
      if (unique.includes(task.task_id)) {
        throw new TaskConflictError(
          `Task ${task.task_id} cannot block itself.`,
          { taskId: task.task_id, owner: task.owner, status: task.status, actor: who },
        );
      }
      if (unique.length > 0) task.blocked_by = unique;
      else delete task.blocked_by;
    }

    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async startTask(taskId: string, agent?: string): Promise<Task> {
    const who = agent ?? this.agent;
    const task = await this.getTask(taskId);
    if (task.owner && task.owner !== who) {
      throw new TaskConflictError(
        `Task ${taskId} is owned by ${task.owner}; only the owner can start it.`,
        { taskId, owner: task.owner, status: task.status, actor: who },
      );
    }
    await this.assertNotBlocked(task);
    this.transitionTask(task, "in_progress", "start", who);
    if (!task.owner) task.owner = who;
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async pauseTask(input: TaskPauseInput): Promise<Task> {
    const who = input.agent ?? this.agent;
    const task = await this.getTask(input.taskId);
    if (task.owner !== who) {
      throw new TaskConflictError(
        `Task ${input.taskId} is owned by ${task.owner ?? "no one"}; only the owner can pause.`,
        { taskId: input.taskId, owner: task.owner, status: task.status, actor: who },
      );
    }
    this.transitionTask(task, input.status ?? "blocked", "pause", who);
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async doneTask(taskId: string, agent?: string): Promise<Task> {
    const who = agent ?? this.agent;
    const task = await this.getTask(taskId);
    if (task.owner !== who) {
      throw new TaskConflictError(
        `Task ${taskId} is owned by ${task.owner ?? "no one"}; only the owner can complete.`,
        { taskId, owner: task.owner, status: task.status, actor: who },
      );
    }
    await this.assertNotBlocked(task);
    this.transitionTask(task, "done", "complete", who);
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async dropTask(input: TaskDropInput): Promise<Task> {
    const who = input.agent ?? this.agent;
    const task = await this.getTask(input.taskId);
    if (task.owner && task.owner !== who) {
      throw new TaskConflictError(
        `Task ${input.taskId} is owned by ${task.owner}; only the owner can drop.`,
        { taskId: input.taskId, owner: task.owner, status: task.status, actor: who },
      );
    }
    this.transitionTask(task, "dropped", "drop", who);
    if (input.reason) task.drop_reason = input.reason;
    task.updated_at = this.nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
    return task;
  }

  async linkTaskRun(taskId: string, runId: string): Promise<Task> {
    const task = await this.getTask(taskId);
    const canonicalRunId = await this.resolveRunId(runId);
    if (!task.related_runs.includes(canonicalRunId)) {
      task.related_runs.push(canonicalRunId);
      task.updated_at = this.nowIso();
      await this.writeJson(this.taskPath(task.task_id), task);
    }
    return task;
  }

  private transitionTask(task: Task, to: TaskStatus, operation: string, actor?: string): void {
    const allowed = TASK_TRANSITION_TABLE[task.status];
    if (!allowed.includes(to)) {
      throw new InvalidTaskTransitionError(task.task_id, task.status, to, operation, actor);
    }
    task.status = to;
  }

  private transitionRun(run: RunJournal, to: RunStatus, operation: string): void {
    const allowed = RUN_TRANSITION_TABLE[run.status];
    if (!allowed.includes(to)) {
      throw new InvalidRunTransitionError(run.run_id, run.status, to, operation);
    }
    run.status = to;
  }

  private async assertNotBlocked(task: Task): Promise<void> {
    if (!task.blocked_by || task.blocked_by.length === 0) return;
    const openBlockers: string[] = [];
    for (const blockerId of task.blocked_by) {
      try {
        const blocker = await this.getTask(blockerId);
        if (blocker.status !== "done" && blocker.status !== "dropped") {
          openBlockers.push(blockerId);
        }
      } catch {
        // Missing blocker — treat as open (defensive: we don't know the state).
        openBlockers.push(blockerId);
      }
    }
    if (openBlockers.length > 0) {
      throw new TaskBlockedError(task.task_id, openBlockers);
    }
  }

  // ─── Handoffs ─────────────────────────────────────────────────────────────

  /**
   * ADR 0001: a handoff is a task assigned to the recipient. The run's
   * evidence (changed paths, validation, open threads, next actions) is
   * summarized into the task description and linked via related_runs.
   * Idempotent per run through dedup_key.
   */
  private async createHandoffTask(input: {
    recipient: string;
    sourceAgent: string;
    summary: string;
    run?: RunJournal;
    dedupKey?: string;
  }): Promise<Task> {
    const run = input.run;
    const lines = [input.summary];
    if (run) {
      if (run.changed_paths.length > 0) lines.push(`Changed paths: ${run.changed_paths.join(", ")}`);
      const lastValidation = run.validation.at(-1);
      if (lastValidation) lines.push(`Validation: ${lastValidation.command} → ${lastValidation.status}`);
      if (run.open_threads.length > 0) lines.push(`Open threads: ${run.open_threads.join(" | ")}`);
      const action = run.next_actions[0];
      if (action) lines.push(`Next: ${action.command ?? action.reason}`);
    }
    const task = await this.createTask({
      title: `Handoff from ${input.sourceAgent}: ${truncateText(input.summary, 100)}`,
      description: lines.join("\n"),
      dedupKey: input.dedupKey ?? (run ? `handoff:${run.run_id}` : undefined),
    });
    if (task.owner !== input.recipient) {
      await this.assignTask({ taskId: task.task_id, to: input.recipient, agent: input.sourceAgent, note: input.summary });
    }
    if (run) await this.linkTaskRun(task.task_id, run.run_id);
    return await this.getTask(task.task_id);
  }

  /**
   * One-time fold (ADR 0001): convert legacy pending handoffs in handoffs/
   * into assigned tasks. Runs from sync(); idempotent via dedup_key. The
   * legacy files stay frozen on disk — nothing reads them as handoffs anymore.
   */
  private async migratePendingHandoffs(): Promise<void> {
    for (const handoff of await this.listHandoffs()) {
      if (handoff.status !== "pending") continue;
      const run = handoff.related_run_id
        ? (await this.listRuns()).find((candidate) => candidate.run_id === handoff.related_run_id)
        : undefined;
      await this.createHandoffTask({
        recipient: handoff.recipient,
        sourceAgent: handoff.source_agent,
        summary: handoff.summary,
        run,
        dedupKey: `handoff:${handoff.handoff_id}`,
      });
    }
  }

  /** Honest reader for frozen handoffs/ files; used by sync migration and audit. */
  async readHandoffs(): Promise<ArtifactReadResult<Handoff>> {
    const result = await this.readArtifactDirectory(
      "handoffs",
      this.handoffsDir,
      (filePath) => this.readJson(filePath, HandoffSchema),
    );
    result.records.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return result;
  }

  private async listHandoffs(): Promise<Handoff[]> {
    const result = await this.readHandoffs();
    this.reportArtifactDiagnostics(result.diagnostics);
    return result.records;
  }

  async readSignals(options: { includeExpired?: boolean } = {}): Promise<ArtifactReadResult<Signal>> {
    const result = await this.readArtifactDirectory(
      "signals",
      this.signalsDir,
      (filePath) => this.readJson(filePath, SignalSchema),
    );
    const now = this.now().getTime();
    result.records = result.records
      .filter((signal) => options.includeExpired || Date.parse(signal.expires_at) > now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return result;
  }

  async listSignals(options: { includeExpired?: boolean } = {}): Promise<Signal[]> {
    const result = await this.readSignals(options);
    this.reportArtifactDiagnostics(result.diagnostics);
    return result.records;
  }

  /** Read the archive ledger without converting corruption into an empty archive. */
  async readArchivedSignals(): Promise<ArtifactReadResult<ArchivedSignal>> {
    if (!existsSync(this.signalsArchivePath)) return artifactReadResult([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.signalsArchivePath, "utf8"));
    } catch (error) {
      return artifactReadResult([], [this.toArtifactDiagnostic("signals_archive", this.signalsArchivePath, error)]);
    }
    if (!Array.isArray(parsed)) {
      const result = SignalsArchiveSchema.safeParse(parsed);
      const error = result.success
        ? new Error("Signal archive must be an array.")
        : new WorkspaceViewValidationError(result.error.issues, this.signalsArchivePath);
      return artifactReadResult([], [this.toArtifactDiagnostic("signals_archive", this.signalsArchivePath, error)]);
    }
    const records: ArchivedSignal[] = [];
    const diagnostics: ArtifactDiagnostic[] = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const result = ArchivedSignalSchema.safeParse(parsed[index]);
      if (result.success) {
        records.push(result.data);
      } else {
        diagnostics.push(this.toArtifactDiagnostic(
          "signals_archive",
          `${this.signalsArchivePath}#/${index}`,
          new WorkspaceViewValidationError(result.error.issues, `${this.signalsArchivePath}#/${index}`),
        ));
      }
    }
    return artifactReadResult(records, diagnostics);
  }

  async listArchivedSignals(): Promise<ArchivedSignal[]> {
    const result = await this.readArchivedSignals();
    this.reportArtifactDiagnostics(result.diagnostics);
    return result.records;
  }

  /**
   * Sweep signals that expired more than `graceMs` ago into the archive
   * ledger, then delete their live files. Expired-but-within-grace signals
   * stay live (and stay audit-visible) so a crashed owner can still renew.
   * Runs from mutating operations only (sync, and run finish via sync) —
   * bare reads never garbage-collect.
   */
  async gcExpiredSignals(options: { graceMs?: number } = {}): Promise<Signal[]> {
    const graceMs = options.graceMs ?? SIGNAL_GC_GRACE_MS;
    const cutoff = this.now().getTime() - graceMs;
    const expired = this.requireComplete(
      await this.readSignals({ includeExpired: true }),
      "garbage-collect expired signals",
    ).filter(
      (signal) => Date.parse(signal.expires_at) <= cutoff,
    );
    if (expired.length === 0) return [];

    await this.archiveAndRemoveSignals(expired);
    return expired;
  }

  /**
   * Release the claim signals a run created (matched by details.run_id, with
   * an intent-prefix fallback for pre-stamp signals) into the archive ledger.
   * A finished run's claims become queryable residue instead of reading as
   * "another agent is working here" until TTL expiry.
   */
  async releaseRunClaims(run: RunJournal): Promise<Signal[]> {
    const prefix = `run ${run.run_id.slice(0, 8)}:`;
    const claims = this.requireComplete(
      await this.readSignals({ includeExpired: true }),
      "release run claims",
    ).filter(
      (signal) =>
        signal.owner === run.agent_id
        && ((signal.details as { run_id?: string } | undefined)?.run_id === run.run_id
          || signal.intent.startsWith(prefix)),
    );
    if (claims.length === 0) return [];
    await this.archiveAndRemoveSignals(claims);
    return claims;
  }

  /** Append signals to the archive ledger, then delete their live files. */
  private async archiveAndRemoveSignals(signals: Signal[]): Promise<void> {
    const archivedAt = this.nowIso();
    const archive = this.requireComplete(await this.readArchivedSignals(), "append to the signal archive");
    const merged = [
      ...archive,
      ...signals.map((signal) => ({ ...signal, archived_at: archivedAt })),
    ].slice(-SIGNAL_ARCHIVE_CAP);
    await this.writeJson(this.signalsArchivePath, merged);

    for (const signal of signals) {
      const filename = await this.findSignalFilename(signal.id);
      if (filename) await unlink(path.join(this.signalsDir, filename));
    }
  }

  async brief(options: ViewBriefOptions = {}): Promise<ViewBrief> {
    const manifestResult = await this.readManifestResult();
    const policyResult = await this.readPolicyResult();
    const nextActions: NextAction[] = [];
    const viewPresent = existsSync(this.dataDir);
    const policy = policyResult.value;
    const manifest = manifestResult.value;

    if (!viewPresent) {
      nextActions.push(commandAction("seed bootstrap", "low", "Workspace View is missing."));
    } else if (!manifest) {
      nextActions.push(commandAction("seed view sync", "low", "Workspace manifest is missing or invalid."));
    }
    if (!policy) {
      if (policyResult.errorMessage) {
        nextActions.push(commandAction("seed view preflight --json", "high", `policy.json is invalid: ${policyResult.errorMessage}`));
      } else {
        nextActions.push(commandAction("seed view preflight --json", "low", "No repo policy is present; create .seedrop/view/policy.json when repo expectations are known."));
      }
    }

    const verificationCommands = uniqueStrings([
      ...(policy?.preferred_verification_commands ?? []),
      ...(await this.inferVerificationCommands()),
    ]);
    const importantPaths = manifest ? pickImportantPaths(manifest) : [];
    const freshnessSource: "live" | "cached" | "unknown" = !manifest
      ? "unknown"
      : options.checkFreshness === false
        ? "cached"
        : "live";
    const freshness: ManifestFreshness = !manifest
      ? (manifestResult.error ? "invalid" : "missing")
      : options.checkFreshness === false
        ? await this.cachedManifestFreshness(policy, manifest)
        : (await this.hasManifestDrift(manifest))
          ? "stale"
          : "fresh";
    if (freshness === "stale") {
      nextActions.push(commandAction("seed view sync", "low", "Manifest is stale."));
    }
    const success = await this.viewSuccess({
      viewPresent,
      manifest,
      policy,
      freshness,
      verificationCommands,
    });
    if (!success.meets_required) {
      nextActions.push(commandAction("seed view preflight --json", "low", `View is ${success.level}; policy requires ${success.required_level}.`));
    }
    const gitSnapshot = this.snapshotGitStatus();
    if (gitSnapshot.is_dirty) {
      const sample = (gitSnapshot.uncommitted_paths ?? []).slice(0, 3).join(", ");
      const more = gitSnapshot.uncommitted_count > 3 ? `, +${gitSnapshot.uncommitted_count - 3} more` : "";
      nextActions.push(commandAction("git status", "low", `${gitSnapshot.uncommitted_count} uncommitted file(s) — ${sample}${more}`));
    }

    return {
      schema_version: "1.0",
      view: {
        present: viewPresent,
        root: this.root,
        data_dir: this.dataDir,
      },
      ...(manifest
        ? {
            workspace: {
              id: manifest.workspace_id,
              root: manifest.root,
              ...(policy?.purpose ? { purpose: policy.purpose } : {}),
              ...(policy?.current_focus ? { current_focus: policy.current_focus } : {}),
            },
            manifest: {
              present: true,
              updated_at: manifest.updated_at,
              file_count: manifest.files.length,
              recommended_reads: manifest.recommended_reads,
              important_paths: importantPaths,
              freshness,
              freshness_source: freshnessSource,
            },
          }
        : {
            manifest: {
              present: false,
              file_count: 0,
              recommended_reads: [],
              important_paths: [],
              freshness,
              freshness_source: freshnessSource,
            },
          }),
      success,
      verification_commands: verificationCommands,
      known_risks: [...(policy?.danger_zones ?? []), ...(policy?.sensitive_paths ?? [])],
      next_actions: uniqueNextActions(nextActions),
      git_status: gitSnapshot,
    };
  }

  async context(options: { budgetBytes?: number } = {}): Promise<WorkspaceContext> {
    const budgetBytes = options.budgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES;
    const brief = await this.brief({ checkFreshness: false });
    if (!brief.view.present) {
      const preflight = await this.preflight({ checkManifestDrift: false });
      const latestAudit = await this.readCachedAuditReport();
      return {
        schema_version: "1.0",
        view: brief.view,
        brief,
        active_signals: [],
        active_runs: [],
        latest_audit: latestAudit,
        preflight,
        next_actions: uniqueNextActions([...brief.next_actions, ...preflight.next_actions]),
      };
    }

    const manifest = (await this.readManifestResult()).value;
    const packets = await this.safeListContinuityPackets();
    const latestContinuity = packets.at(-1);
    const runs = await this.safeListRuns();
    const activeRuns = runs.filter((run) => run.status === "in_progress");
    const currentRun = activeRuns.filter((run) => run.agent_id === this.agent).at(-1) ?? activeRuns.at(-1);
    const latestRun = runs.at(-1);
    const allTasks = await this.safeListTasks();
    const activeTasks = allTasks.filter(
      (task) =>
        (task.owner === this.agent && (task.status === "claimed" || task.status === "in_progress" || task.status === "blocked"))
        || (task.owner === undefined && task.status === "open"),
    );
    const openTasksCount = allTasks.filter((task) => task.status === "open").length;

    const allSignals = await this.safeListSignals();
    const otherAgentsMap = new Map<string, {
      agent_id: string;
      active_runs: Array<{ run_id: string; goal: string; started_at: string; changed_paths: string[] }>;
      claims: Array<{ signal_id: string; target: string; intent: string; expires_at: string }>;
      in_progress_tasks: Array<{ task_id: string; title: string }>;
    }>();
    const upsert = (id: string) => {
      if (!otherAgentsMap.has(id)) {
        otherAgentsMap.set(id, { agent_id: id, active_runs: [], claims: [], in_progress_tasks: [] });
      }
      return otherAgentsMap.get(id)!;
    };
    for (const run of activeRuns) {
      if (run.agent_id !== this.agent) {
        upsert(run.agent_id).active_runs.push({
          run_id: run.run_id,
          goal: run.goal,
          started_at: run.started_at,
          changed_paths: run.changed_paths,
        });
      }
    }
    for (const signal of allSignals) {
      if (signal.owner !== this.agent) {
        upsert(signal.owner).claims.push({
          signal_id: signal.id,
          target: signal.target,
          intent: signal.intent,
          expires_at: signal.expires_at,
        });
      }
    }
    for (const task of allTasks) {
      if (task.owner && task.owner !== this.agent && task.status === "in_progress") {
        upsert(task.owner).in_progress_tasks.push({ task_id: task.task_id, title: task.title });
      }
    }
    const otherAgents = [...otherAgentsMap.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
    const preflight = await this.preflight({ checkManifestDrift: false });
    const latestAudit = await this.readCachedAuditReport();

    const payload: WorkspaceContext = {
      schema_version: "1.0",
      view: brief.view,
      brief,
      ...(manifest ? { manifest: summarizeManifest(manifest) } : {}),
      ...(latestContinuity ? { latest_continuity: latestContinuity } : {}),
      active_signals: await this.safeListSignals(),
      ...(currentRun ? { current_run: currentRun } : {}),
      ...(latestRun ? { latest_run: latestRun } : {}),
      active_runs: activeRuns,
      ...(activeTasks.length > 0 ? { active_tasks: activeTasks } : {}),
      open_tasks_count: openTasksCount,
      ...(otherAgents.length > 0 ? { other_agents: otherAgents } : {}),
      latest_audit: latestAudit,
      preflight,
      next_actions: uniqueNextActions([...brief.next_actions, ...preflight.next_actions]),
    };
    return applyContextBudget(payload, budgetBytes);
  }

  /**
   * List open threads (resolved ones suppressed) and, optionally, the resolution
   * ledger. Lighter than `context()` — reads only continuity packets, runs, and
   * pending handoffs, the three sources threads can originate from.
   */
  /**
   * One-time fold (ADR 0001): materialize historical unresolved threads from
   * packets and runs into ownerless tasks. Idempotent via dedup_key; entries
   * in the legacy resolution ledger are skipped, not recreated.
   */
  private async migrateOpenThreads(): Promise<void> {
    const [packets, runs] = await Promise.all([
      this.safeListContinuityPackets(),
      this.safeListRuns(),
    ]);
    for (const thread of collectOpenThreads(packets, runs)) {
      await this.materializeThreadTask(thread.packet_id, thread.thread, thread.source ?? "packet");
    }
  }

  async readKnowledgeArtifacts(): Promise<ArtifactReadResult<KnowledgeArtifact>> {
    if (!existsSync(this.knowledgeDir)) return artifactReadResult([]);
    const records: KnowledgeArtifact[] = [];
    const diagnostics: ArtifactDiagnostic[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        diagnostics.push(this.toArtifactDiagnostic("knowledge", directory, error));
        return;
      }
      for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(filePath);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        try {
          const content = await readFile(filePath, "utf8");
          const parsed = parseKnowledgeFrontmatterChecked(content);
          if (parsed.error) {
            const error = Object.assign(new Error(parsed.error), { artifactCode: "invalid_content" as const });
            diagnostics.push(this.toArtifactDiagnostic("knowledge", filePath, error));
          } else {
            records.push({
              path: normalizeRelativePath(path.relative(this.dataDir, filePath)),
              content,
              metadata: parsed.metadata,
            });
          }
        } catch (error) {
          diagnostics.push(this.toArtifactDiagnostic("knowledge", filePath, error));
        }
      }
    };
    await walk(this.knowledgeDir);
    records.sort((a, b) => comparePaths(a.path, b.path));
    return artifactReadResult(records, diagnostics);
  }

  async readResolvedThreadIndex(): Promise<ArtifactReadResult<ResolvedThreadEntry>> {
    if (!existsSync(this.resolvedThreadsPath)) return artifactReadResult([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.resolvedThreadsPath, "utf8"));
    } catch (error) {
      return artifactReadResult([], [this.toArtifactDiagnostic("resolved_threads", this.resolvedThreadsPath, error)]);
    }
    const envelope = ResolvedThreadsEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      return artifactReadResult([], [this.toArtifactDiagnostic(
        "resolved_threads",
        this.resolvedThreadsPath,
        new WorkspaceViewValidationError(envelope.error.issues, this.resolvedThreadsPath),
      )]);
    }
    const records: ResolvedThreadEntry[] = [];
    const diagnostics: ArtifactDiagnostic[] = [];
    for (let index = 0; index < envelope.data.resolved.length; index += 1) {
      const entry = ResolvedThreadEntrySchema.safeParse(envelope.data.resolved[index]);
      if (entry.success) {
        records.push(entry.data);
      } else {
        const pointer = `${this.resolvedThreadsPath}#/resolved/${index}`;
        diagnostics.push(this.toArtifactDiagnostic(
          "resolved_threads",
          pointer,
          new WorkspaceViewValidationError(entry.error.issues, pointer),
        ));
      }
    }
    return artifactReadResult(records, diagnostics);
  }

  private async readResolvedThreads(): Promise<ResolvedThreadEntry[]> {
    return this.requireComplete(await this.readResolvedThreadIndex(), "read the resolved-thread index");
  }

  private async writeResolvedThreads(entries: ResolvedThreadEntry[]): Promise<void> {
    await this.writeJson(this.resolvedThreadsPath, { schema_version: "1.0", resolved: entries });
  }

  async preflight(options: ViewPreflightOptions = {}): Promise<ViewPreflightReport> {
    const checks: ViewCheck[] = [];
    const issues: AuditReport["issues"] = [];
    const nextActions: NextAction[] = [];
    const viewPresent = existsSync(this.dataDir);

    if (!viewPresent) {
      checks.push({
        id: "view_present",
        status: "fail",
        summary: ".seedrop/view is missing.",
        path: this.dataDir,
      });
      issues.push({ severity: "error", code: "view_missing", message: ".seedrop/view is missing.", path: ".seedrop/view" });
      nextActions.push(commandAction("seed bootstrap", "low", "Create and link Workspace View for this repo."));
      return { ok: false, checks, issues, next_actions: nextActions };
    }
    checks.push({ id: "view_present", status: "pass", summary: ".seedrop/view is present.", path: ".seedrop/view" });

    const manifestResult = await this.readManifestResult();
    const manifest = manifestResult.value;
    let manifestFreshness: ManifestFreshness = manifest
      ? "fresh"
      : manifestResult.error
        ? "invalid"
        : "missing";
    if (manifest) {
      checks.push({ id: "manifest", status: "pass", summary: "Manifest parses.", path: "manifest.json" });
      if (options.checkManifestDrift === false) {
        manifestFreshness = await this.cachedManifestFreshness((await this.readPolicyResult()).value, manifest);
        checks.push({ id: "manifest_freshness", status: "skipped", summary: "Manifest freshness check skipped for read-only context.", path: "manifest.json" });
      } else if (await this.hasManifestDrift(manifest)) {
        manifestFreshness = "stale";
        checks.push({ id: "manifest_freshness", status: "warn", summary: "Manifest appears stale.", path: "manifest.json" });
        issues.push({ severity: "warning", code: "manifest_stale", message: "Manifest appears stale.", path: "manifest.json" });
        nextActions.push(commandAction("seed view sync", "low", "Refresh stale manifest."));
      } else {
        checks.push({ id: "manifest_freshness", status: "pass", summary: "Manifest matches current file set." });
      }
    } else {
      checks.push({ id: "manifest", status: "fail", summary: manifestResult.error ?? "Manifest is missing.", path: "manifest.json" });
      issues.push({ severity: "error", code: "manifest_invalid", message: manifestResult.error ?? "Manifest is missing.", path: "manifest.json" });
      nextActions.push(commandAction("seed view sync", "low", "Create or repair the manifest."));
    }

    const gitDirty = this.gitDirtyState();
    if (gitDirty.inside) {
      // Split tracked vs untracked. Tracked changes are a real shipping
      // concern (another agent cloning HEAD won't see them); untracked
      // files are usually scratch/build noise and surface as info only.
      if (gitDirty.tracked.length > 0) {
        checks.push({
          id: "git_dirty",
          status: "warn",
          summary: `Git worktree has ${gitDirty.tracked.length} tracked change(s).`,
          details: { tracked: gitDirty.tracked, untracked: gitDirty.untracked },
        });
        issues.push({ severity: "warning", code: "git_dirty", message: "Git worktree has tracked local changes." });
      } else if (gitDirty.untracked.length > 0) {
        checks.push({
          id: "git_dirty",
          status: "pass",
          summary: `Git worktree is clean apart from ${gitDirty.untracked.length} untracked file(s) (noise).`,
          details: { untracked: gitDirty.untracked },
        });
      } else {
        checks.push({ id: "git_dirty", status: "pass", summary: "Git worktree is clean." });
      }
    } else {
      checks.push({ id: "git_dirty", status: "skipped", summary: "Not inside a git worktree." });
    }

    const signals = await this.listSignals();
    if (signals.length > 0) {
      checks.push({
        id: "active_signals",
        status: "warn",
        summary: `${signals.length} active advisory signal(s).`,
        details: { signals },
      });
      issues.push({ severity: "warning", code: "active_signals", message: "Active advisory claims/locks are present." });
    } else {
      checks.push({ id: "active_signals", status: "pass", summary: "No active advisory signals." });
    }

    const activeRuns = (await this.listRuns()).filter((run) => run.agent_id === this.agent && run.status === "in_progress");
    if (activeRuns.length > 0) {
      checks.push({
        id: "active_run",
        status: "warn",
        summary: `Active run exists for ${this.agent}.`,
        details: { run_ids: activeRuns.map((run) => run.run_id) },
      });
      issues.push({ severity: "warning", code: "active_run", message: `Active run exists for ${this.agent}.` });
      nextActions.push(commandAction("seed run finish --status completed", "medium", "Finish or resume the active run before starting unrelated work."));
    } else {
      checks.push({ id: "active_run", status: "pass", summary: `No active run for ${this.agent}.` });
    }

    // ADR 0001: handoffs are tasks. Legacy pending handoff files only linger
    // until a sync folds them into assigned tasks.
    const legacyPending = (await this.listHandoffs()).filter((handoff) => handoff.status === "pending");
    if (legacyPending.length > 0) {
      checks.push({
        id: "legacy_pending_handoffs",
        status: "warn",
        summary: `${legacyPending.length} legacy pending handoff file(s); a sync will fold them into assigned tasks.`,
        details: { handoff_ids: legacyPending.map((handoff) => handoff.handoff_id) },
      });
      nextActions.push(commandAction("seed view sync", "low", "Fold legacy pending handoffs into assigned tasks (ADR 0001)."));
    } else {
      checks.push({ id: "legacy_pending_handoffs", status: "pass", summary: "No legacy pending handoff files." });
    }

    // Lint: a task that says "blocked by <id>" in prose but lacks the matching
    // entry in `blocked_by` means the dependency can't be enforced. Surface a
    // structured fix (seed task update --blocked-by) so the prose hint and the
    // schema agree.
    const proseLintTasks = await this.safeListTasks();
    const proseLintIssues: Array<{ task_id: string; title: string; missing: string[] }> = [];
    if (proseLintTasks.length > 0) {
      for (const task of proseLintTasks) {
        if (task.status === "done" || task.status === "dropped") continue;
        const candidates = new Set([
          ...findProseBlockerCandidates(task.description),
          ...findProseBlockerCandidates(task.assigned_note),
        ]);
        if (candidates.size === 0) continue;
        const declared = new Set(task.blocked_by ?? []);
        const missing: string[] = [];
        for (const candidate of candidates) {
          const resolved = proseLintTasks.find((other) => other.task_id.startsWith(candidate));
          if (!resolved) continue;
          if (resolved.task_id === task.task_id) continue;
          if (declared.has(resolved.task_id)) continue;
          // Skip already-resolved blockers — encoding them adds noise without
          // changing enforcement (assertNotBlocked already treats them as cleared).
          if (resolved.status === "done" || resolved.status === "dropped") continue;
          missing.push(resolved.task_id);
        }
        if (missing.length > 0) {
          proseLintIssues.push({ task_id: task.task_id, title: task.title, missing });
        }
      }
    }
    if (proseLintIssues.length > 0) {
      checks.push({
        id: "task_prose_blockers",
        status: "warn",
        summary: `${proseLintIssues.length} task(s) reference a blocker in prose without encoding it in blocked_by.`,
        details: { tasks: proseLintIssues },
      });
      issues.push({
        severity: "warning",
        code: "task_prose_blockers",
        message: "Task descriptions or assignment notes name a blocker that is not encoded in blocked_by, so Seedrop cannot enforce the dependency.",
      });
      const first = proseLintIssues[0]!;
      nextActions.push(commandAction(
        `seed task update ${first.task_id.slice(0, 8)} --blocked-by ${first.missing[0]!.slice(0, 8)}`,
        "low",
        `Encode the prose dependency for "${first.title}", or rephrase the description so it doesn't imply a blocker.`,
      ));
    } else {
      checks.push({ id: "task_prose_blockers", status: "pass", summary: "No prose-only task blockers detected." });
    }

    const policyResult = await this.readPolicyResult();
    if (policyResult.value) {
      checks.push({ id: "policy", status: "pass", summary: "Policy parses.", path: "policy.json" });
    } else if (policyResult.errorMessage) {
      checks.push({ id: "policy", status: "fail", summary: policyResult.errorMessage, path: "policy.json" });
      issues.push({ severity: "error", code: "policy_invalid", message: policyResult.errorMessage, path: "policy.json" });
    } else {
      checks.push({ id: "policy", status: "warn", summary: "No policy.json is present.", path: "policy.json" });
      issues.push({ severity: "warning", code: "policy_missing", message: "No .seedrop/view/policy.json is present.", path: "policy.json" });
      nextActions.push(commandAction("seed view preflight --json", "low", "Create .seedrop/view/policy.json when repo working agreements are known."));
    }

    const verificationCommands = uniqueStrings([
      ...(policyResult.value?.preferred_verification_commands ?? []),
      ...(await this.inferVerificationCommands()),
    ]);
    checks.push({
      id: "verification_commands",
      status: verificationCommands.length > 0 ? "pass" : "warn",
      summary: verificationCommands.length > 0 ? "Verification commands are discoverable." : "No verification commands discovered.",
      details: { commands: verificationCommands },
    });

    const success = await this.viewSuccess({
      viewPresent,
      manifest,
      policy: policyResult.value,
      freshness: manifestFreshness,
      verificationCommands,
    });
    const successStatus = success.meets_required ? (success.level === "L0" || success.level === "L1" ? "warn" : "pass") : "fail";
    checks.push({
      id: "view_success",
      status: successStatus,
      summary: `${success.level} ${success.label}: ${success.summary}`,
      details: success,
    });
    if (!success.meets_required) {
      issues.push({
        severity: "error",
        code: "view_success_below_required",
        message: `View is ${success.level}; policy requires ${success.required_level}.`,
      });
      nextActions.push(commandAction("seed view brief --json", "low", "Inspect View success level and missing orientation evidence."));
    }

    return {
      ok: !checks.some((check) => check.status === "fail"),
      checks,
      issues,
      next_actions: uniqueNextActions(nextActions),
    };
  }

  async audit(options: ViewAuditOptions = {}): Promise<AuditReport> {
    const issues: AuditReport["issues"] = [];
    const checks: ViewCheck[] = [];
    const nextActions: NextAction[] = [];
    const [
      manifestRead,
      policyRead,
      continuityRead,
      runsRead,
      tasksRead,
      handoffsRead,
      signalsRead,
      archiveRead,
      knowledgeRead,
      resolvedThreadsRead,
    ] = await Promise.all([
      this.readManifestArtifact(),
      this.readPolicyArtifact(),
      this.readContinuityPackets(),
      this.readRuns(),
      this.readTasks(),
      this.readHandoffs(),
      this.readSignals({ includeExpired: true }),
      this.readArchivedSignals(),
      this.readKnowledgeArtifacts(),
      this.readResolvedThreadIndex(),
    ]);
    const manifest = manifestRead.records[0];
    const policy = policyRead.records[0];

    this.collectArtifactReadAudit("manifest", manifestRead, issues, checks, { required: true, path: "manifest.json" });
    this.collectArtifactReadAudit("policy", policyRead, issues, checks, { path: "policy.json" });
    this.collectArtifactReadAudit("continuity", continuityRead, issues, checks, { path: "continuity/" });
    this.collectArtifactReadAudit("runs", runsRead, issues, checks, { path: "runs/" });
    this.collectArtifactReadAudit("tasks", tasksRead, issues, checks, { path: "tasks/" });
    this.collectArtifactReadAudit("handoffs", handoffsRead, issues, checks, { path: "handoffs/" });
    this.collectArtifactReadAudit("signals", signalsRead, issues, checks, { path: "signals/" });
    this.collectArtifactReadAudit("signals_archive", archiveRead, issues, checks, { path: "signals-archive.json" });
    this.collectArtifactReadAudit("knowledge", knowledgeRead, issues, checks, { path: "knowledge/" });
    this.collectArtifactReadAudit("resolved_threads", resolvedThreadsRead, issues, checks, { path: "resolved-threads.json" });

    if (!manifest) {
      nextActions.push(commandAction("seed view sync", "low", "Create or repair workspace manifest."));
    } else {
      const actualFiles = new Set(await this.scanFiles(policy?.ignore ?? []));
      const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));

      for (const filePath of actualFiles) {
        if (!manifestFiles.has(filePath)) {
          issues.push({
            severity: "warning",
            code: "file_missing_from_manifest",
            message: "File exists on disk but is not listed in the manifest.",
            path: filePath,
          });
        }
      }

      for (const file of manifest.files) {
        const absolutePath = path.join(this.root, file.path);
        try {
          const buffer = await readFile(absolutePath);
          const hash = createHash("sha256").update(buffer).digest("hex");
          if (hash !== file.hash) {
            issues.push({
              severity: "warning",
              code: "file_hash_changed",
              message: "File content changed since the last manifest sync.",
              path: file.path,
            });
          }
        } catch {
          issues.push({
            severity: "error",
            code: "manifest_file_missing",
            message: "Manifest lists a file that no longer exists.",
            path: file.path,
          });
        }
      }
      if (issues.some((issue) => issue.code === "file_missing_from_manifest" || issue.code === "file_hash_changed")) {
        nextActions.push(commandAction("seed view sync", "low", "Refresh manifest drift."));
      }
      const staleByAge = this.manifestStaleByAge(manifest, policy);
      if (staleByAge) {
        issues.push({
          severity: "warning",
          code: "manifest_age_stale",
          message: staleByAge,
          path: "manifest.json",
        });
        nextActions.push(commandAction("seed view sync", "low", "Refresh aged manifest."));
      }

      const unannotated = pickImportantPaths(manifest).filter((filePath) => manifestFiles.has(filePath) && !manifestFiles.get(filePath)?.purpose);
      if (unannotated.length > 0) {
        issues.push({
          severity: "warning",
          code: "manifest_low_signal",
          message: "Important orientation paths are missing purpose annotations.",
        });
        checks.push({
          id: "manifest_signal",
          status: "warn",
          summary: `${unannotated.length} important path(s) lack purpose annotations.`,
          details: { paths: unannotated },
        });
        nextActions.push(commandAction("seed view sync", "low", "Add path_purposes in .seedrop/view/policy.json, then refresh the manifest."));
      } else {
        checks.push({ id: "manifest_signal", status: "pass", summary: "Important paths have purpose annotations." });
      }
    }

    if (!existsSync(this.dataDir)) {
      return {
        ok: !issues.some((issue) => issue.severity === "error"),
        issues,
        checks,
        next_actions: uniqueNextActions(nextActions),
      };
    }

    for (const signal of signalsRead.records) {
      if (Date.parse(signal.expires_at) <= this.now().getTime()) {
        issues.push({
          severity: "warning",
          code: "signal_expired",
          message: `Signal ${signal.id} has expired and should be released or renewed.`,
          path: signal.target,
        });
        nextActions.push(commandAction(`seed view release --id ${signal.id}`, "low", "Release or renew expired signal."));
      }
    }

    this.collectKnowledgeFreshness(knowledgeRead.records, issues, checks, nextActions);
    if (policy) {
      if (!policy.purpose || !policy.current_focus) {
        issues.push({
          severity: "warning",
          code: "policy_low_signal",
          message: "Policy should include purpose and current_focus for one-fetch orientation.",
          path: "policy.json",
        });
        checks.push({
          id: "policy_signal",
          status: "warn",
          summary: "Policy is missing purpose or current_focus.",
          path: "policy.json",
        });
      } else {
        checks.push({ id: "policy_signal", status: "pass", summary: "Policy includes purpose and current focus.", path: "policy.json" });
      }
    } else {
      checks.push({
        id: "policy_signal",
        status: policyRead.completeness === "partial" ? "fail" : "skipped",
        summary: policyRead.completeness === "partial"
          ? "Policy signal cannot be evaluated because policy.json is malformed."
          : "No policy is present; purpose and current focus are unavailable.",
        path: "policy.json",
      });
    }

    const report: AuditReport = {
      ok: !issues.some((issue) => issue.severity === "error"),
      issues,
      checks,
      next_actions: uniqueNextActions(nextActions),
    };
    if (options.writeCache !== false && existsSync(this.dataDir)) {
      await this.writeJson(this.auditPath, report);
    }
    return report;
  }

  private async viewSuccess(input: {
    viewPresent: boolean;
    manifest?: WorkspaceManifest;
    policy?: ViewPolicy;
    freshness: ManifestFreshness;
    verificationCommands: string[];
  }): Promise<ViewBrief["success"]> {
    const policy = input.policy;
    const required = policy?.required_success_level;
    let level: ViewSuccessLevel = "L0";
    let summary = "Workspace View is missing.";

    if (input.viewPresent) {
      level = "L1";
      summary = "Workspace View exists, but it is not yet a useful orientation packet.";
    }

    const l2Ready = Boolean(
      input.manifest &&
      input.freshness === "fresh" &&
      policy?.purpose &&
      input.verificationCommands.length > 0,
    );
    if (l2Ready) {
      level = "L2";
      summary = "View has purpose, fresh manifest, and verification commands.";
    }

    const runs = input.viewPresent ? await this.safeListRuns() : [];
    const activeRun = runs.filter((run) => run.agent_id === this.agent && run.status === "in_progress").at(-1);
    const activeRunHasEvidence = Boolean(
      activeRun &&
      (activeRun.steps.length > 0 ||
        activeRun.changed_paths.length > 0 ||
        activeRun.validation.length > 0 ||
        activeRun.next_actions.length > 0 ||
        activeRun.open_threads.length > 0),
    );
    if (l2Ready && activeRunHasEvidence) {
      level = "L3";
      summary = "Current work is represented by an active run with resume evidence.";
    }

    const packets = input.viewPresent ? await this.safeListContinuityPackets() : [];
    const latestRun = runs.at(-1);
    const handoffReady = Boolean(
      (latestRun &&
          latestRun.validation.length > 0 &&
          (latestRun.next_actions.length > 0 || latestRun.open_threads.length > 0)) ||
        packets.some((packet) => packet.validation.status !== "unknown" && (packet.open_threads.length > 0 || packet.changed_paths.length > 0)),
    );
    if (l2Ready && handoffReady) {
      level = "L4";
      summary = "View has enough validated state for another agent to resume from it.";
    }

    if (compareSuccessLevels(level, "L4") >= 0) {
      const dirty = this.gitDirtyState();
      // Only tracked changes can block L4 — untracked files don't affect
      // whether another agent can resume from git alone. Matches the
      // run-finish gate's tracked-only check (task f3fc8250).
      if (dirty.inside && dirty.tracked.length > 0) {
        const dirtySet = new Set(dirty.tracked);
        const trackedPaths = new Set<string>();
        for (const run of runs) {
          for (const p of run.changed_paths) trackedPaths.add(p);
        }
        const uncommittedTracked = [...trackedPaths].filter((p) => dirtySet.has(p));
        if (uncommittedTracked.length > 0) {
          level = "L3";
          summary = `Run-tracked changes are uncommitted (${uncommittedTracked.length}); another agent cannot resume from git alone.`;
        }
      }
    }

    return {
      level,
      label: successLabel(level),
      summary,
      ...(required ? { required_level: required } : {}),
      meets_required: !required || compareSuccessLevels(level, required) >= 0,
    };
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.dataDir, { recursive: true }),
      mkdir(this.continuityDir, { recursive: true }),
      mkdir(this.signalsDir, { recursive: true }),
      mkdir(this.runsDir, { recursive: true }),
      mkdir(this.handoffsDir, { recursive: true }),
      mkdir(this.tasksDir, { recursive: true }),
      mkdir(this.knowledgeDir, { recursive: true }),
    ]);
  }

  private async readManifestIfPresent(): Promise<WorkspaceManifest | undefined> {
    if (!existsSync(this.manifestPath)) return undefined;
    return this.readManifest();
  }

  private async readManifestResult(): Promise<{ value?: WorkspaceManifest; error?: string }> {
    const result = await this.readManifestArtifact();
    return result.records[0]
      ? { value: result.records[0] }
      : result.diagnostics[0]?.code === "missing"
        ? {}
        : { error: result.diagnostics[0]?.reason };
  }

  private async readPolicyResult(): Promise<{ value?: ViewPolicy; error?: Error; errorMessage?: string }> {
    if (!existsSync(this.policyPath)) return {};
    try {
      return { value: await this.readJson(this.policyPath, ViewPolicySchema) };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { error: err, errorMessage: err.message };
    }
  }

  private createEmptyManifest(workspaceId: string): WorkspaceManifest {
    return {
      schema_version: "1.0",
      workspace_id: workspaceId,
      root: ".",
      updated_at: this.nowIso(),
      files: [],
      recommended_reads: [],
    };
  }

  /**
   * Refuse to treat the user's home directory or the filesystem root as a
   * workspace. Syncing those walks and hashes the entire tree, producing a
   * giant manifest that makes every later orientation (boot/continuity/audit)
   * pathologically slow — the exact failure that wedged boot for 60s+. A repo
   * is the right granularity; pass `force: true` only if you really mean it.
   */
  private assertSafeWorkspaceRoot(): void {
    const root = path.resolve(this.root);
    const home = path.resolve(homedir());
    const fsRoot = path.parse(root).root;
    if (root === home) {
      throw new WorkspaceViewError(
        `Refusing to sync a Workspace View at your home directory (${root}). ` +
          "This would scan and hash every file under $HOME. Run `seed bootstrap` / `seed view sync` " +
          "from inside a specific project instead. Use force only if you truly intend a $HOME-wide View.",
      );
    }
    if (root === fsRoot) {
      throw new WorkspaceViewError(
        `Refusing to sync a Workspace View at the filesystem root (${root}). ` +
          "Run from inside a specific project directory instead.",
      );
    }
  }

  private async scanFiles(extraIgnore: string[]): Promise<string[]> {
    const ignored = new Set([...DEFAULT_IGNORE, ...extraIgnore]);
    const out: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Skip unreadable directories instead of aborting the whole scan.
        // Hit in $HOME-as-workspace setups where macOS guards .Trash (EPERM),
        // and on cross-mount or permission-stripped subtrees in general.
        if (code === "EPERM" || code === "EACCES" || code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name);
        const relativePath = normalizeRelativePath(path.relative(this.root, absolutePath));
        if (isIgnoredPath(entry.name, relativePath, ignored)) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(absolutePath);
        } else if (entry.isFile()) {
          out.push(relativePath);
        }
      }
    };

    await walk(this.root);
    return out.sort(comparePaths);
  }

  private recommendedReads(files: ManifestFile[], policyPurposes = new Map<string, NonNullable<ViewPolicy["path_purposes"]>[string]>()): RecommendedRead[] {
    const available = new Set(files.map((file) => file.path));
    const candidates: RecommendedRead[] = [
      { path: "README.md", reason: "Project overview", priority: 1 },
      { path: "package.json", reason: "Package metadata and scripts", priority: 2 },
      { path: "pyproject.toml", reason: "Python package metadata", priority: 2 },
      { path: "Cargo.toml", reason: "Rust package metadata", priority: 2 },
    ];
    for (const [pathKey, annotation] of policyPurposes) {
      if (!annotation.recommended_read_reason || !available.has(pathKey)) continue;
      candidates.push({
        path: pathKey,
        reason: annotation.recommended_read_reason,
        priority: annotation.recommended_read_priority ?? 10,
      });
    }

    return uniqueRecommendedReads(candidates.filter((candidate) => available.has(candidate.path)));
  }

  async readContinuityPackets(): Promise<ArtifactReadResult<ContinuityPacket>> {
    const result = await this.readArtifactDirectory(
      "continuity",
      this.continuityDir,
      (filePath) => this.readJsonMigrated(filePath, ContinuityPacketMigrationChain, ContinuityPacketSchema),
    );
    result.records.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return result;
  }

  private async safeListContinuityPackets(): Promise<ContinuityPacket[]> {
    return (await this.readContinuityPackets()).records;
  }

  private async safeListRuns(): Promise<RunJournal[]> {
    return (await this.readRuns()).records;
  }

  private async safeListTasks(): Promise<Task[]> {
    return (await this.readTasks()).records;
  }

  private async safeListSignals(options: { includeExpired?: boolean } = {}): Promise<Signal[]> {
    return (await this.readSignals(options)).records;
  }

  private async readCachedAuditReport(): Promise<AuditReport> {
    if (existsSync(this.auditPath)) {
      try {
        const parsed = JSON.parse(await readFile(this.auditPath, "utf8")) as AuditReport;
        return parsed;
      } catch (error) {
        return {
          ok: false,
          issues: [{
            severity: "error",
            code: "audit_cache_malformed",
            message: error instanceof Error ? error.message : String(error),
            path: "audit.json",
          }],
          checks: [{ id: "audit_cache", status: "fail", summary: "Cached audit snapshot is malformed.", path: "audit.json" }],
          next_actions: [commandAction("seed view audit --json", "low", "Regenerate malformed audit snapshot.")],
        };
      }
    }
    return {
      ok: true,
      issues: [],
      checks: [{ id: "audit_cache", status: "skipped", summary: "No cached audit snapshot is present.", path: "audit.json" }],
      next_actions: [commandAction("seed view audit --json", "low", "Generate an audit snapshot when deep validation is needed.")],
    };
  }

  /**
   * Freshness according to the cached audit snapshot, for callers that cannot
   * afford a live re-hash.
   *
   * Fails closed. This previously returned "fresh" when the snapshot was
   * missing or unparseable, so absence of evidence became evidence of
   * freshness — and `context()` reads this path, which meant boot could report
   * L4/meets_required while `view brief` and `view preflight`, which check
   * live, reported L1/below-required on the same repo in the same second.
   *
   * Reporting a *higher* trust level from *weaker* evidence is the one thing an
   * orientation surface must never do; it also contradicted the View's own
   * standing constraint that a stale manifest is not trustworthy orientation.
   * Unknown now stays unknown, and `viewSuccess` only grants L2+ on "fresh".
   */
  private async cachedManifestFreshness(
    policy?: ViewPolicy,
    manifest?: WorkspaceManifest,
  ): Promise<"fresh" | "stale" | "unknown"> {
    // Absent an explicit policy, a manifest younger than this counts as fresh.
    // Some notion of "recent enough" is required, or a View that was just
    // synced but never audited reports unknown and can never reach L2+.
    const DEFAULT_FRESHNESS_TTL_HOURS = 24;
    const ttlMs = (policy?.freshness_ttl_hours ?? DEFAULT_FRESHNESS_TTL_HOURS) * 3_600_000;

    // A recent audit snapshot is the strongest cheap evidence available.
    if (existsSync(this.auditPath)) {
      try {
        const parsed = JSON.parse(await readFile(this.auditPath, "utf8")) as AuditReport;
        const age = Date.parse(this.nowIso()) - (await stat(this.auditPath)).mtimeMs;
        const usable = Number.isFinite(age) && age <= ttlMs;
        if (usable) {
          return parsed.issues.some((issue) =>
            issue.code === "manifest_stale" ||
            issue.code === "file_missing_from_manifest" ||
            issue.code === "file_hash_changed" ||
            issue.code === "manifest_file_missing"
          )
            ? "stale"
            : "fresh";
        }
      } catch {
        // Fall through to the manifest-age rule below.
      }
    }

    // No usable snapshot. Fall back to what the policy itself means by fresh: a
    // manifest younger than freshness_ttl_hours. A just-synced View is fresh by
    // construction and must not be punished for never having been audited.
    if (manifest?.updated_at) {
      const age = Date.parse(this.nowIso()) - Date.parse(manifest.updated_at);
      if (Number.isFinite(age)) return age <= ttlMs ? "fresh" : "unknown";
    }

    // Nothing can establish freshness. Say so rather than assuming the best —
    // this path previously returned "fresh", which let boot report L4 while
    // live-checking surfaces reported L1 on the same repo.
    return "unknown";
  }

  private async activeRun(agent = this.agent): Promise<RunJournal | undefined> {
    return this.requireComplete(await this.readRuns(), "locate the active run")
      .filter((run) => run.agent_id === agent && run.status === "in_progress").at(-1);
  }

  private async requireActiveRun(agent = this.agent): Promise<RunJournal> {
    const run = await this.activeRun(agent);
    if (!run) {
      // Check whether there are malformed run files on disk — if so, the
      // run isn't missing, it's corrupted. Surface that fact instead of
      // misleading the agent into thinking they never started one.
      const { malformed } = await this.listRunsWithErrors();
      const corruptionHint = malformed.length > 0
        ? ` (${malformed.length} run file(s) on disk failed to parse: ${malformed.slice(0, 2).map((m) => m.filename).join(", ")}${malformed.length > 2 ? `, +${malformed.length - 2} more` : ""}. Check ${this.runsDir} for corrupted journals — likely cause: paths stored in non-relative form.)`
        : "";
      throw new Error(`No active run for ${agent}.${corruptionHint} Run \`seed run start --goal "..."\` first.`);
    }
    return run;
  }

  private async updateRun(run: RunJournal): Promise<RunJournal> {
    run.updated_at = this.nowIso();
    await this.writeRun(run);
    return run;
  }

  private async mutateRun(
    runId: string,
    mutate: (run: RunJournal) => Promise<void> | void,
  ): Promise<RunJournal> {
    const filePath = this.runPath(runId);
    return await this.withFileLock(filePath, async () => {
      const run = await this.readJsonMigrated(filePath, RunJournalMigrationChain, RunJournalSchema);
      await mutate(run);
      return await this.updateRun(run);
    });
  }

  private assertRunOwner(run: RunJournal, agent: string): void {
    if (run.agent_id !== agent) {
      throw new WorkspaceRunOwnershipError(run.run_id, run.agent_id, agent);
    }
  }

  private async writeRun(run: RunJournal): Promise<void> {
    await this.writeJson(this.runPath(run.run_id), run);
  }

  /**
   * Normalize a user-provided path to a workspace-relative POSIX string.
   * Absolute paths are relativized against this.root. Throws if the path
   * escapes the workspace root or is empty. This is the *input boundary*
   * for all user-provided paths (run.changed_paths, signal.target,
   * packet.changed_paths, etc.) so the write side cannot produce a path
   * the read-side RelativePath schema would reject.
   */
  private toWorkspaceRelative(input: string): string {
    if (!input || input.trim().length === 0) {
      throw new Error("Path must be non-empty.");
    }
    const trimmed = input.trim();
    const candidate = path.isAbsolute(trimmed)
      ? path.relative(this.root, trimmed)
      : trimmed;
    const normalized = candidate.split(path.sep).join("/").replace(/\/+/g, "/");
    if (normalized.length === 0) {
      throw new Error(`Path resolves to workspace root itself: ${input}`);
    }
    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error(`Path escapes workspace root (${this.root}): ${input}`);
    }
    if (path.isAbsolute(normalized) || normalized.startsWith("/")) {
      throw new Error(`Path could not be made relative to workspace root (${this.root}): ${input}`);
    }
    return normalized;
  }

  private toWorkspaceRelativeMany(inputs: readonly string[]): string[] {
    return inputs.map((input) => this.toWorkspaceRelative(input));
  }

  private runPath(runId: string): string {
    return path.join(this.runsDir, `${runId}.json`);
  }

  private handoffPath(handoffId: string): string {
    return path.join(this.handoffsDir, `${handoffId}.json`);
  }

  private async inferVerificationCommands(): Promise<string[]> {
    const commands: string[] = [];
    const packagePath = path.join(this.root, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
        if (pkg.scripts?.test) commands.push("npm test");
        if (pkg.scripts?.typecheck) commands.push("npm run typecheck");
        if (pkg.scripts?.lint) commands.push("npm run lint");
      } catch {
        // Package metadata is advisory here; malformed JSON is reported by manifest/audit paths if tracked.
      }
    }
    if (existsSync(path.join(this.root, "Cargo.toml"))) commands.push("cargo test");
    if (existsSync(path.join(this.root, "pyproject.toml"))) commands.push("python -m pytest");
    return uniqueStrings(commands);
  }

  /**
   * Git working-tree state split by category.
   *
   * `tracked` = files git already knows about that have local modifications
   * (modified/added/deleted/renamed). These are the real shipping risk: a
   * teammate cloning the repo at HEAD will not see this work, so the
   * finishRun gate refuses on these.
   *
   * `untracked` = files git has never seen (`??` in --porcelain). Usually
   * scratch notes, generated artifacts, or in-progress files outside the
   * project's `.gitignore` policy. We surface them but do not block: another
   * agent CAN resume from HEAD even with untracked junk lying around.
   */
  private gitDirtyState(): { inside: boolean; tracked: string[]; untracked: string[] } {
    const inside = spawnSync("git", ["-C", this.root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    });
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      return { inside: false, tracked: [], untracked: [] };
    }
    const status = spawnSync("git", ["-C", this.root, "status", "--porcelain"], {
      encoding: "utf8",
    });
    if (status.status !== 0) return { inside: true, tracked: [], untracked: [] };
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const line of status.stdout.split("\n")) {
      if (!line) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3).trim();
      if (!p) continue;
      if (code === "??") {
        untracked.push(p);
      } else {
        tracked.push(p);
      }
    }
    return { inside: true, tracked, untracked };
  }

  private async hasManifestDrift(manifest: WorkspaceManifest): Promise<boolean> {
    try {
      const policy = (await this.readPolicyResult()).value;
      if (this.manifestStaleByAge(manifest, policy)) return true;
      const actualFiles = new Set(await this.scanFiles(policy?.ignore ?? []));
      if (actualFiles.size !== manifest.files.length) return true;
      for (const file of manifest.files) {
        if (!actualFiles.has(file.path)) return true;
        const buffer = await readFile(path.join(this.root, file.path));
        const hash = createHash("sha256").update(buffer).digest("hex");
        if (hash !== file.hash) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  private manifestStaleByAge(manifest: WorkspaceManifest, policy?: ViewPolicy): string | undefined {
    if (!policy?.freshness_ttl_hours) return undefined;
    const updatedAt = Date.parse(manifest.updated_at);
    if (Number.isNaN(updatedAt)) return "Manifest updated_at is not a valid timestamp.";
    const maxAgeMs = policy.freshness_ttl_hours * 60 * 60 * 1000;
    const ageMs = this.now().getTime() - updatedAt;
    if (ageMs > maxAgeMs) {
      return `Manifest is older than policy freshness_ttl_hours (${policy.freshness_ttl_hours}).`;
    }
    return undefined;
  }

  private collectArtifactReadAudit<T>(
    family: ArtifactFamily,
    result: ArtifactReadResult<T>,
    issues: AuditReport["issues"],
    checks: ViewCheck[],
    options: { required?: boolean; path: string },
  ): void {
    for (const diagnostic of result.diagnostics) {
      const requiredMissing = options.required && diagnostic.code === "missing";
      issues.push({
        severity: "error",
        code: requiredMissing ? `${family}_missing` : `${family}_malformed`,
        message: requiredMissing && family === "manifest"
          ? "Workspace manifest is missing."
          : diagnostic.reason,
        path: diagnostic.path,
      });
    }
    const absentOptional = !options.required && result.records.length === 0 && result.diagnostics.length === 0;
    checks.push({
      id: family,
      status: result.completeness === "partial" ? "fail" : absentOptional ? "skipped" : "pass",
      summary: result.completeness === "partial"
        ? `${result.diagnostics.length} ${family} artifact(s) could not be read; ${result.records.length} valid record(s) preserved.`
        : absentOptional
          ? `No ${family} artifacts are present.`
          : `${result.records.length} ${family} record(s) read completely.`,
      path: options.path,
      details: {
        completeness: result.completeness,
        records_count: result.records.length,
        diagnostics_count: result.diagnostics.length,
      },
    });
  }

  private collectKnowledgeFreshness(
    files: KnowledgeArtifact[],
    issues: AuditReport["issues"],
    checks: ViewCheck[],
    nextActions: NextAction[],
  ): void {
    if (files.length === 0) {
      checks.push({ id: "knowledge_freshness", status: "skipped", summary: "No knowledge markdown files found.", path: "knowledge/" });
      return;
    }

    const staleFiles: Array<Record<string, unknown>> = [];
    let annotated = 0;
    for (const file of files) {
      const relativePath = file.path;
      const metadata = file.metadata;
      if (Object.keys(metadata).length > 0) annotated += 1;
      if (metadata.status !== "stale" && metadata.status !== "superseded") continue;

      staleFiles.push({
        path: relativePath,
        status: metadata.status,
        superseded_by: metadata.superseded_by ?? null,
        updated_at: metadata.updated_at ?? null,
        validated_by: metadata.validated_by ?? null,
      });
      issues.push({
        severity: "warning",
        code: metadata.status === "superseded" ? "knowledge_superseded" : "knowledge_stale",
        message: metadata.status === "superseded"
          ? "Knowledge file is marked superseded and should not drive current decisions."
          : "Knowledge file is marked stale and should be refreshed before use.",
        path: relativePath,
      });
    }

    if (staleFiles.length > 0) {
      checks.push({
        id: "knowledge_freshness",
        status: "warn",
        summary: `${staleFiles.length} knowledge file(s) are stale or superseded.`,
        path: "knowledge/",
        details: { files: staleFiles },
      });
      nextActions.push(commandAction("seed view audit --json", "low", "Review stale/superseded knowledge metadata and update or replace those files."));
      return;
    }

    checks.push({
      id: "knowledge_freshness",
      status: "pass",
      summary: `${files.length} knowledge file(s) checked; ${annotated} include freshness metadata.`,
      path: "knowledge/",
    });
  }

  private async findSignalFilename(id: string): Promise<string | undefined> {
    const entries = await readdir(this.signalsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const signal = await this.readJson(path.join(this.signalsDir, entry.name), SignalSchema);
        if (signal.id === id) {
          return entry.name;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private async withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = `${filePath}.lock`;
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({
            pid: process.pid,
            created_at: this.nowIso(),
            target: path.basename(filePath),
          }));
          return await fn();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true });
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw error;
        await this.removeStaleLock(lockPath);
        if (Date.now() - started > VIEW_FILE_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for Seedrop View lock: ${lockPath}`);
        }
        await delay(VIEW_FILE_LOCK_RETRY_MS);
      }
    }
  }

  private async removeStaleLock(lockPath: string): Promise<void> {
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > VIEW_FILE_LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // Missing or unreadable locks are handled by the next acquire attempt.
    }
  }

  private async readSingleArtifact<T>(
    family: ArtifactFamily,
    filePath: string,
    schema: ZodType<T>,
    options: { required?: boolean } = {},
  ): Promise<ArtifactReadResult<T>> {
    if (!existsSync(filePath)) {
      if (!options.required) return artifactReadResult([]);
      const error = Object.assign(new Error(`Required ${family} artifact is missing.`), { code: "ENOENT" });
      return artifactReadResult([], [this.toArtifactDiagnostic(family, filePath, error)]);
    }
    try {
      return artifactReadResult([await this.readJson(filePath, schema)]);
    } catch (error) {
      return artifactReadResult([], [this.toArtifactDiagnostic(family, filePath, error)]);
    }
  }

  private async readArtifactDirectory<T>(
    family: ArtifactFamily,
    directory: string,
    readOne: (filePath: string) => Promise<T>,
  ): Promise<ArtifactReadResult<T>> {
    if (!existsSync(directory)) return artifactReadResult([]);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return artifactReadResult([], [this.toArtifactDiagnostic(family, directory, error)]);
    }

    const records: T[] = [];
    const diagnostics: ArtifactDiagnostic[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(directory, entry.name);
      try {
        records.push(await readOne(filePath));
      } catch (error) {
        diagnostics.push(this.toArtifactDiagnostic(family, filePath, error));
      }
    }
    return artifactReadResult(records, diagnostics);
  }

  private toArtifactDiagnostic(family: ArtifactFamily, filePath: string, error: unknown): ArtifactDiagnostic {
    const err = error instanceof Error ? error : new Error(String(error));
    const cause = (err as Error & { cause?: unknown }).cause;
    const nodeCode = (cause as NodeJS.ErrnoException | undefined)?.code ?? (err as NodeJS.ErrnoException).code;
    const artifactCode = (err as Error & { artifactCode?: ArtifactDiagnostic["code"] }).artifactCode;
    const code: ArtifactDiagnostic["code"] =
      artifactCode
        ? artifactCode
        : nodeCode === "ENOENT"
        ? "missing"
        : nodeCode === "EACCES" || nodeCode === "EPERM"
          ? "unreadable"
          : err instanceof SchemaVersionUnsupportedError
            ? "unsupported_schema_version"
            : err instanceof WorkspaceViewValidationError
              ? "schema_validation"
              : err instanceof WorkspaceViewParseError
                ? "invalid_json"
                : "io_error";
    return {
      family,
      path: this.artifactDisplayPath(filePath),
      code,
      reason: err.message,
    };
  }

  private artifactDisplayPath(filePath: string): string {
    const hashIndex = filePath.indexOf("#");
    const basePath = hashIndex >= 0 ? filePath.slice(0, hashIndex) : filePath;
    const fragment = hashIndex >= 0 ? filePath.slice(hashIndex) : "";
    const relative = normalizeRelativePath(path.relative(this.root, basePath));
    return `${relative.startsWith("../") ? path.resolve(basePath) : relative}${fragment}`;
  }

  private reportArtifactDiagnostics(diagnostics: readonly ArtifactDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      process.stderr.write(
        `seedrop: ${diagnostic.family} artifact ${diagnostic.path} was not returned (${diagnostic.code}): ${diagnostic.reason.split("\n")[0]}\n`,
      );
    }
  }

  private requireComplete<T>(result: ArtifactReadResult<T>, operation: string): T[] {
    if (result.completeness === "complete") return result.records;
    const sample = result.diagnostics.slice(0, 3)
      .map((diagnostic) => `${diagnostic.path} (${diagnostic.code})`)
      .join(", ");
    throw new WorkspaceViewError(
      `Cannot ${operation}: ${result.diagnostics.length} durable artifact(s) could not be read: ${sample}. ` +
        "Repair or quarantine the named artifacts before retrying the mutation.",
      {
        recovery: result.diagnostics.slice(0, 3).map((diagnostic) => ({
          kind: "read" as const,
          path: diagnostic.path,
          risk: "low" as const,
          requires_human: true,
          reason: diagnostic.reason,
        })),
      },
    );
  }

  private async readJson<T>(filePath: string, schema: ZodType<T>): Promise<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw new WorkspaceViewParseError(filePath, error instanceof Error ? error : new Error(String(error)));
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new WorkspaceViewValidationError(result.error.issues, filePath);
    }
    return result.data;
  }

  /**
   * Like readJson, but routes the parsed JSON through a migration chain
   * before the final Zod parse. Use this for any schema that may evolve
   * across CLI versions (Task, RunJournal, ContinuityPacket today).
   */
  private async readJsonMigrated<T>(
    filePath: string,
    chain: MigrationChain,
    schema: ZodType<T>,
  ): Promise<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw new WorkspaceViewParseError(filePath, error instanceof Error ? error : new Error(String(error)));
    }
    return parseAndMigrate(parsed, chain, schema, filePath);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function classifyFile(filePath: string): ManifestFile["kind"] {
  const basename = path.basename(filePath).toLowerCase();
  const extension = path.extname(filePath).toLowerCase();

  if (filePath.includes("/test/") || filePath.includes("/tests/") || basename.includes(".test.")) {
    return "test";
  }
  if ([".md", ".mdx", ".txt", ".rst"].includes(extension)) {
    return "doc";
  }
  if ([".json", ".toml", ".yaml", ".yml", ".ini"].includes(extension) || basename.startsWith(".")) {
    return "config";
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".rb", ".php"].includes(extension)) {
    return "source";
  }
  if ([".csv", ".tsv", ".sqlite", ".db"].includes(extension)) {
    return "data";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"].includes(extension)) {
    return "asset";
  }
  return "other";
}

function comparePaths(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
}

function artifactReadResult<T>(
  records: T[],
  diagnostics: ArtifactDiagnostic[] = [],
): ArtifactReadResult<T> {
  return {
    records,
    diagnostics,
    completeness: diagnostics.length === 0 ? "complete" : "partial",
  };
}

function matchesSignal(signal: Signal, input: ReleaseSignalInput): boolean {
  if (input.id && signal.id !== input.id) {
    return false;
  }
  if (input.type && signal.type !== input.type) {
    return false;
  }
  if (input.target && signal.target !== input.target) {
    return false;
  }
  if (input.owner && signal.owner !== input.owner) {
    return false;
  }
  return Boolean(input.id || input.type || input.target || input.owner);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface KnowledgeFrontmatter {
  status?: string;
  superseded_by?: string;
  updated_at?: string;
  validated_by?: string;
}

function parseKnowledgeFrontmatterChecked(markdown: string): { metadata: KnowledgeFrontmatter; error?: string } {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return { metadata: {} };
  const metadata: KnowledgeFrontmatter = {};
  let closed = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "---") {
      closed = true;
      break;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.replace(/-/g, "_");
    const value = stripFrontmatterQuotes(match[2]!.trim());
    if (key === "status") metadata.status = value;
    else if (key === "superseded_by") metadata.superseded_by = value;
    else if (key === "updated_at") metadata.updated_at = value;
    else if (key === "validated_by") metadata.validated_by = value;
  }
  return closed
    ? { metadata }
    : { metadata: {}, error: "Knowledge frontmatter opens with --- but has no closing --- delimiter." };
}

function stripFrontmatterQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function normalizePaths(paths: string[]): string[] {
  return paths.map((filePath) => normalizeRelativePath(filePath)).filter(Boolean);
}

function normalizePolicyPathPurposes(policy?: ViewPolicy): Map<string, NonNullable<ViewPolicy["path_purposes"]>[string]> {
  const out = new Map<string, NonNullable<ViewPolicy["path_purposes"]>[string]>();
  for (const [pathKey, annotation] of Object.entries(policy?.path_purposes ?? {})) {
    out.set(normalizeRelativePath(pathKey), annotation);
  }
  return out;
}

function isIgnoredPath(name: string, relativePath: string, ignored: Set<string>): boolean {
  if (ignored.has(name) || ignored.has(relativePath)) return true;
  for (const ignorePath of ignored) {
    if (relativePath.startsWith(`${ignorePath}/`)) return true;
  }
  return false;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function uniqueRecommendedReads(values: RecommendedRead[]): RecommendedRead[] {
  const seen = new Set<string>();
  const out: RecommendedRead[] = [];
  for (const value of values.sort((a, b) => a.priority - b.priority || comparePaths(a.path, b.path))) {
    if (seen.has(value.path)) continue;
    seen.add(value.path);
    out.push(value);
  }
  return out;
}

// Phrases that signal a task dependency. Conservative: must be unambiguous
// ("blocked by", "depends on") — vague terms like "after" alone are skipped to
// keep false positives near zero.
const PROSE_BLOCKER_PATTERN =
  /\b(blocked\s+by|gated\s+on|depends?\s+on|dependent\s+on|waits?\s+for|waiting\s+on|coordinate\s+with|sequence\s+after)\b[^.]{0,80}?\b([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)\b/gi;

/**
 * Scan `text` for prose phrases that name another task. Returns the candidate
 * id strings (full uuid or 8+ char hex prefix) — caller resolves them against
 * the known task set.
 */
export function findProseBlockerCandidates(text: string | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  // Reset lastIndex because the regex is global.
  PROSE_BLOCKER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROSE_BLOCKER_PATTERN.exec(text)) !== null) {
    out.add(match[2]!.toLowerCase());
  }
  return [...out];
}

function commandAction(command: string, risk: NextAction["risk"], reason: string): NextAction {
  return {
    kind: "command",
    command,
    risk,
    requires_human: false,
    reason,
  };
}

function uniqueNextActions(actions: NextAction[]): NextAction[] {
  const seen = new Set<string>();
  const out: NextAction[] = [];
  for (const action of actions) {
    const key = `${action.kind}:${action.command ?? ""}:${action.path ?? ""}:${action.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

/** Stable, addressable id for an open thread: sha256(packet_id + thread), 12 hex chars. */
function threadId(packetId: string, thread: string): string {
  return createHash("sha256").update(`${packetId} ${thread}`).digest("hex").slice(0, 12);
}

/** Aggregate open threads from continuity packets, run journals, and pending handoffs, each with a stable id. */
function collectOpenThreads(
  packets: ContinuityPacket[],
  runs: RunJournal[],
): OpenThread[] {
  return [
    ...packets.flatMap((packet) =>
      packet.open_threads.map((thread) => ({
        id: threadId(packet.id, thread),
        thread,
        packet_id: packet.id,
        created_at: packet.created_at,
        source: "legacy_continuity" as const,
      })),
    ),
    ...runs.flatMap((run) =>
      run.open_threads.map((thread) => ({
        id: threadId(run.run_id, thread),
        thread,
        packet_id: run.run_id,
        created_at: run.updated_at,
        source: "run" as const,
      })),
    ),
  ];
}

function pickImportantPaths(manifest: WorkspaceManifest): string[] {
  const recommended = manifest.recommended_reads.map((read) => read.path);
  const annotated = (manifest.path_purposes ?? []).map((entry) => entry.path);
  const packageFiles = manifest.files
    .map((file) => file.path)
    .filter((filePath) => ["package.json", "pyproject.toml", "Cargo.toml", "README.md", "AGENTS.md", "CLAUDE.md"].includes(filePath));
  return uniqueStrings([...recommended, ...annotated, ...packageFiles]).slice(0, 20);
}

function compareSuccessLevels(actual: ViewSuccessLevel, required: ViewSuccessLevel): number {
  return SUCCESS_LEVELS.indexOf(actual) - SUCCESS_LEVELS.indexOf(required);
}

function successLabel(level: ViewSuccessLevel): string {
  switch (level) {
    case "L0":
      return "Missing";
    case "L1":
      return "Present";
    case "L2":
      return "Useful";
    case "L3":
      return "Active";
    case "L4":
      return "Handoff-Ready";
  }
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.]/g, "").replace("T", "_").replace("Z", "Z");
}

function sanitizeFilename(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Default compact-JSON byte budget for `context()`. Deep surfaces must fit an
 * agent's tool-result window; callers that need everything pass `budgetBytes: 0`.
 */
const DEFAULT_CONTEXT_BUDGET_BYTES = 8192;

/** Expired signals stay live (and audit-visible) this long before GC archives them. */
const SIGNAL_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/** The archive ledger keeps the most recent N swept signals. */
const SIGNAL_ARCHIVE_CAP = 500;

function summarizeManifest(manifest: WorkspaceManifest): WorkspaceManifestSummary {
  return {
    schema_version: "1.0",
    workspace_id: manifest.workspace_id,
    root: manifest.root,
    updated_at: manifest.updated_at,
    files_count: manifest.files.length,
    ...(manifest.path_purposes ? { path_purposes: manifest.path_purposes } : {}),
    recommended_reads: manifest.recommended_reads,
    files_note: "Per-file entries are never inlined in context; read .seedrop/view/manifest.json for the full list.",
  };
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Trim a context payload to a compact-JSON byte budget. Stages run in order of
 * cheapest information loss and stop as soon as the payload fits; every applied
 * stage is recorded so consumers can see what was withheld and where to drill in.
 */
function applyContextBudget(payload: WorkspaceContext, limitBytes: number): WorkspaceContext {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return payload;
  const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(payload) <= limitBytes) {
    return { ...payload, budget: { limit_bytes: limitBytes, bytes: size(payload), stages_applied: [], exceeded: false } };
  }

  const out = structuredClone(payload);
  const applied: string[] = [];
  const capArray = <T>(items: T[] | undefined, max: number): T[] | undefined =>
    items && items.length > max ? items.slice(0, max) : undefined;

  const stages: Array<{ id: string; apply: () => boolean }> = [
    {
      // Lossless: the top-level next_actions field is already the union of
      // brief.next_actions and preflight.next_actions.
      id: "redundant_next_actions_deduped",
      apply: () => {
        let touched = false;
        const brief = out.brief as { next_actions?: unknown[] } | undefined;
        if (brief?.next_actions?.length) {
          brief.next_actions = [];
          touched = true;
        }
        if (out.preflight && out.preflight.next_actions.length > 0) {
          out.preflight = { ...out.preflight, next_actions: [] };
          touched = true;
        }
        return touched;
      },
    },
    {
      // Lossless: current_run is repeated verbatim in latest_run and active_runs.
      id: "redundant_runs_deduped",
      apply: () => {
        let touched = false;
        if (out.current_run && out.latest_run && out.current_run.run_id === out.latest_run.run_id) {
          delete out.latest_run;
          touched = true;
        }
        if (out.current_run && out.active_runs?.some((run) => run.run_id === out.current_run!.run_id)) {
          out.active_runs = out.active_runs.filter((run) => run.run_id !== out.current_run!.run_id);
          touched = true;
        }
        return touched;
      },
    },
    {
      id: "audit_issues_capped",
      apply: () => {
        const capped = capArray(out.latest_audit?.issues, 5);
        if (!capped || !out.latest_audit) return false;
        out.latest_audit = { ...out.latest_audit, issues: capped };
        return true;
      },
    },
    {
      id: "preflight_pass_checks_dropped",
      apply: () => {
        if (!out.preflight) return false;
        const failing = out.preflight.checks.filter((check) => check.status !== "pass");
        if (failing.length === out.preflight.checks.length) return false;
        out.preflight = { ...out.preflight, checks: failing };
        return true;
      },
    },
    {
      id: "task_descriptions_truncated",
      apply: () => {
        let touched = false;
        for (const task of out.active_tasks ?? []) {
          if (task.description && task.description.length > 160) {
            task.description = truncateText(task.description, 160);
            touched = true;
          }
        }
        return touched;
      },
    },
    {
      id: "continuity_packet_truncated",
      apply: () => {
        const packet = out.latest_continuity;
        if (!packet) return false;
        let touched = false;
        if (packet.summary && packet.summary.length > 240) {
          packet.summary = truncateText(packet.summary, 240);
          touched = true;
        }
        for (const key of ["decisions", "assumptions", "open_threads"] as const) {
          const capped = capArray(packet[key], 3);
          if (capped) {
            packet[key] = capped;
            touched = true;
          }
        }
        return touched;
      },
    },
    {
      id: "active_tasks_capped",
      apply: () => {
        const capped = capArray(out.active_tasks, 8);
        if (!capped) return false;
        out.active_tasks = capped;
        return true;
      },
    },
    {
      id: "manifest_path_purposes_capped",
      apply: () => {
        const capped = capArray(out.manifest?.path_purposes, 8);
        if (!capped || !out.manifest) return false;
        out.manifest = { ...out.manifest, path_purposes: capped };
        return true;
      },
    },
    {
      id: "active_runs_capped",
      apply: () => {
        const capped = capArray(out.active_runs, 3);
        if (!capped) return false;
        out.active_runs = capped;
        return true;
      },
    },
    // Hard stages: only reached on tight budgets. They trade detail for ids
    // the caller can drill into via task show / view threads / view preflight.
    {
      id: "task_descriptions_dropped",
      apply: () => {
        let touched = false;
        for (const task of out.active_tasks ?? []) {
          if (task.description !== undefined) {
            delete task.description;
            touched = true;
          }
        }
        return touched;
      },
    },
    {
      id: "preflight_detail_dropped",
      apply: () => {
        if (!out.preflight || (out.preflight.checks.length === 0 && out.preflight.issues.length === 0)) return false;
        out.preflight = { ...out.preflight, checks: [], issues: [] };
        return true;
      },
    },
    {
      id: "audit_detail_dropped",
      apply: () => {
        const audit = out.latest_audit as
          | (AuditReport & { checks?: unknown[]; next_actions?: unknown[] })
          | undefined;
        if (!audit) return false;
        if (audit.issues.length === 0 && !audit.checks?.length && !audit.next_actions?.length) return false;
        out.latest_audit = { ...audit, issues: [], checks: [], next_actions: [] } as AuditReport;
        return true;
      },
    },
    {
      // The brief embeds its own manifest summary; the top-level manifest
      // summary supersedes it when both are present.
      id: "brief_manifest_deduped",
      apply: () => {
        const brief = out.brief as { manifest?: unknown } | undefined;
        if (!brief?.manifest || !out.manifest) return false;
        delete brief.manifest;
        return true;
      },
    },
    {
      id: "brief_workspace_truncated",
      apply: () => {
        const workspace = (out.brief as { workspace?: { purpose?: string; current_focus?: string } } | undefined)?.workspace;
        if (!workspace) return false;
        let touched = false;
        for (const key of ["purpose", "current_focus"] as const) {
          const value = workspace[key];
          if (value && value.length > 160) {
            workspace[key] = truncateText(value, 160);
            touched = true;
          }
        }
        return touched;
      },
    },
    {
      id: "continuity_packet_minimal",
      apply: () => {
        const packet = out.latest_continuity;
        if (!packet) return false;
        let touched = false;
        if (packet.summary && packet.summary.length > 160) {
          packet.summary = truncateText(packet.summary, 160);
          touched = true;
        }
        for (const key of ["decisions", "assumptions", "open_threads"] as const) {
          if ((packet[key]?.length ?? 0) > 0) {
            packet[key] = [];
            touched = true;
          }
        }
        return touched;
      },
    },
    {
      id: "active_tasks_capped_hard",
      apply: () => {
        const capped = capArray(out.active_tasks, 3);
        if (!capped) return false;
        out.active_tasks = capped;
        return true;
      },
    },
    {
      id: "brief_detail_capped",
      apply: () => {
        let touched = false;
        const brief = out.brief as
          | { known_risks?: unknown[]; verification_commands?: unknown[] }
          | undefined;
        for (const key of ["known_risks", "verification_commands"] as const) {
          const capped = capArray(brief?.[key], 2);
          if (capped && brief) {
            brief[key] = capped;
            touched = true;
          }
        }
        const cappedActions = capArray(out.next_actions, 3);
        if (cappedActions) {
          out.next_actions = cappedActions;
          touched = true;
        }
        return touched;
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
