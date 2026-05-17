import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { WorkspaceRunDirtyTreeError, WorkspaceViewParseError, WorkspaceViewValidationError } from "./errors.js";
import {
  ContinuityPacketSchema,
  HandoffSchema,
  PathPurposeSchema,
  PolicyPathPurposeSchema,
  RunJournalSchema,
  SignalSchema,
  ViewPolicySchema,
  WorkspaceManifestSchema,
} from "./schema.js";
import {
  AuditReport,
  ContinuityPacket,
  Handoff,
  ManifestFile,
  NextAction,
  PathPurpose,
  RecommendedRead,
  RunJournal,
  Signal,
  ViewBrief,
  WorkspaceContext,
  WorkspaceManifest,
  ViewCheck,
  ViewPolicy,
  ViewPreflightReport,
} from "./types.js";

export type {
  AuditIssue,
  AuditReport,
  AuditSeverity,
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
  ViewPolicySchema,
  WorkspaceManifestSchema,
} from "./schema.js";
export { WorkspaceRunDirtyTreeError, WorkspaceViewError, WorkspaceViewParseError, WorkspaceViewValidationError } from "./errors.js";

export interface WorkspaceViewOptions {
  root?: string;
  dataDir?: string;
  agent?: string;
  now?: () => Date;
}

export interface SyncOptions {
  ignore?: string[];
  workspaceId?: string;
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
}

export interface RunStartInput {
  goal: string;
  agent?: string;
  newRun?: boolean;
}

export interface RunUpdateInput {
  summary?: string;
  decision?: string;
  assumption?: string;
  thread?: string;
  changedPaths?: string[];
  nextActions?: NextAction[];
  agent?: string;
}

export interface RunVerifyInput {
  command: string;
  status: "passed" | "failed" | "skipped";
  notes?: string;
  agent?: string;
}

export interface RunFinishInput {
  status: "completed" | "blocked" | "failed";
  nextActions?: NextAction[];
  agent?: string;
  force?: boolean;
}

export interface RunStartResult {
  run: RunJournal;
  warnings: string[];
  next_actions: NextAction[];
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

const DEFAULT_DATA_DIR = ".seedrop/view";
const DEFAULT_IGNORE = new Set([".git", "node_modules", "dist", "coverage", ".seedrop", ".DS_Store"]);
const SUCCESS_LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
type ViewSuccessLevel = (typeof SUCCESS_LEVELS)[number];
type ManifestFreshness = NonNullable<ViewBrief["manifest"]>["freshness"];

export class WorkspaceView {
  readonly root: string;
  readonly dataDir: string;
  readonly manifestPath: string;
  readonly continuityDir: string;
  readonly signalsDir: string;
  readonly runsDir: string;
  readonly handoffsDir: string;
  readonly policyPath: string;
  readonly auditPath: string;

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
    this.policyPath = path.join(this.dataDir, "policy.json");
    this.auditPath = path.join(this.dataDir, "audit.json");
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
    try {
      return await this.readManifest();
    } catch {
      const manifest = this.createEmptyManifest(workspaceId);
      await this.writeJson(this.manifestPath, manifest);
      return manifest;
    }
  }

  async sync(options: SyncOptions = {}): Promise<WorkspaceManifest> {
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
      const [fileStat, buffer] = await Promise.all([stat(absolutePath), readFile(absolutePath)]);
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
    return manifest;
  }

  async readManifest(): Promise<WorkspaceManifest> {
    return this.readJson(this.manifestPath, WorkspaceManifestSchema);
  }

  async log(input: LogInput): Promise<ContinuityPacket> {
    await this.ensureDirs();
    const packet: ContinuityPacket = {
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
      changed_paths: input.changedPaths ?? [],
      git_status: this.snapshotGitStatus(),
    };

    const filename = `${compactTimestamp(packet.created_at)}_${sanitizeFilename(input.mission)}.json`;
    await this.writeJson(path.join(this.continuityDir, filename), packet);
    return packet;
  }

  private snapshotGitStatus(): NonNullable<ContinuityPacket["git_status"]> {
    const dirty = this.gitDirtyState();
    if (!dirty.inside) {
      return { is_repo: false, is_dirty: false, uncommitted_count: 0 };
    }
    const paths = dirty.paths;
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
      target: normalizeRelativePath(input.target),
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
    const signals = await this.listSignals({ includeExpired: true });
    const released: Signal[] = [];

    for (const signal of signals) {
      if (!matchesSignal(signal, input)) {
        continue;
      }
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
    const active = (await this.listRuns()).filter((run) => run.agent_id === agentId && run.status === "in_progress");
    if (active.length > 0 && !input.newRun) {
      return {
        run: active.at(-1)!,
        warnings: [`Active run already exists for ${agentId}. Finish it or pass --new to start another run.`],
        next_actions: [
          commandAction("seed run finish --status completed", "medium", `Finish or resume active run ${active.at(-1)!.run_id}.`),
        ],
      };
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
    return { run, warnings: [], next_actions: [] };
  }

  async logRun(input: RunUpdateInput): Promise<RunJournal> {
    const run = await this.requireActiveRun(input.agent);
    if (input.summary) {
      run.steps.push({
        summary: input.summary,
        recorded_at: this.nowIso(),
        changed_paths: normalizePaths(input.changedPaths ?? []),
      });
    }
    if (input.decision) run.decisions.push(input.decision);
    if (input.assumption) run.assumptions.push(input.assumption);
    if (input.thread) run.open_threads.push(input.thread);
    run.changed_paths = uniqueStrings([...run.changed_paths, ...normalizePaths(input.changedPaths ?? [])]);
    if (input.nextActions) run.next_actions = input.nextActions;
    return await this.updateRun(run);
  }

  async decideRun(decision: string, input: { agent?: string } = {}): Promise<RunJournal> {
    return await this.logRun({ decision, agent: input.agent });
  }

  async threadRun(thread: string, input: { agent?: string } = {}): Promise<RunJournal> {
    return await this.logRun({ thread, agent: input.agent });
  }

  async verifyRun(input: RunVerifyInput): Promise<RunJournal> {
    const run = await this.requireActiveRun(input.agent);
    run.validation.push({
      command: input.command,
      status: input.status,
      recorded_at: this.nowIso(),
      ...(input.notes ? { notes: input.notes } : {}),
    });
    return await this.updateRun(run);
  }

  async finishRun(input: RunFinishInput): Promise<RunJournal> {
    const run = await this.requireActiveRun(input.agent);
    if (input.status === "completed" && !input.force && run.changed_paths.length > 0) {
      const gitDirty = this.gitDirtyState();
      if (gitDirty.inside) {
        const dirtySet = new Set(gitDirty.paths);
        const dirtyChanged = run.changed_paths.filter((p) => dirtySet.has(p));
        if (dirtyChanged.length > 0) {
          throw new WorkspaceRunDirtyTreeError(dirtyChanged, run.changed_paths);
        }
      }
    }
    run.status = input.status;
    run.finished_at = this.nowIso();
    if (input.nextActions) run.next_actions = input.nextActions;
    return await this.updateRun(run);
  }

  async listRuns(): Promise<RunJournal[]> {
    await this.ensureDirs();
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const runs: RunJournal[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        runs.push(await this.readJson(path.join(this.runsDir, entry.name), RunJournalSchema));
      } catch {
        continue;
      }
    }

    return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  async createHandoff(input: HandoffCreateInput): Promise<Handoff> {
    await this.ensureDirs();
    const sourceAgent = input.agent ?? this.agent;
    const run = input.runId
      ? (await this.listRuns()).find((candidate) => candidate.run_id === input.runId)
      : await this.activeRun(sourceAgent);
    const now = this.nowIso();
    const handoff: Handoff = {
      schema_version: "1.0",
      handoff_id: randomUUID(),
      created_at: now,
      updated_at: now,
      source_agent: sourceAgent,
      recipient: input.to,
      ...(run ? { related_run_id: run.run_id } : {}),
      summary: input.summary,
      status: "pending",
      files_changed: run?.changed_paths ?? [],
      validation: run?.validation ?? [],
      blockers: input.blockers ?? [],
      risks: input.risks ?? [],
      open_threads: run?.open_threads ?? [],
      next_actions: input.nextActions ?? run?.next_actions ?? [],
    };
    await this.writeJson(this.handoffPath(handoff.handoff_id), handoff);
    return handoff;
  }

  async listHandoffs(): Promise<Handoff[]> {
    await this.ensureDirs();
    const entries = await readdir(this.handoffsDir, { withFileTypes: true });
    const handoffs: Handoff[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        handoffs.push(await this.readJson(path.join(this.handoffsDir, entry.name), HandoffSchema));
      } catch {
        continue;
      }
    }
    return handoffs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async readHandoff(id: string): Promise<Handoff> {
    const handoff = (await this.listHandoffs()).find((candidate) => candidate.handoff_id === id || candidate.handoff_id.startsWith(id));
    if (!handoff) throw new Error(`Handoff not found: ${id}`);
    return handoff;
  }

  async acceptHandoff(id: string, agent = this.agent): Promise<Handoff> {
    const handoff = await this.readHandoff(id);
    const updated: Handoff = {
      ...handoff,
      status: "accepted",
      accepted_at: this.nowIso(),
      accepted_by: agent,
      updated_at: this.nowIso(),
    };
    await this.writeJson(this.handoffPath(updated.handoff_id), updated);
    return updated;
  }

  async listSignals(options: { includeExpired?: boolean } = {}): Promise<Signal[]> {
    await this.ensureDirs();
    const entries = await readdir(this.signalsDir, { withFileTypes: true });
    const signals: Signal[] = [];
    const now = this.now().getTime();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const signal = await this.readJson(path.join(this.signalsDir, entry.name), SignalSchema);
        if (options.includeExpired || Date.parse(signal.expires_at) > now) {
          signals.push(signal);
        }
      } catch {
        continue;
      }
    }

    return signals.sort((a, b) => a.created_at.localeCompare(b.created_at));
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
    const freshness = !manifest
      ? (manifestResult.error ? "invalid" : "missing")
      : options.checkFreshness === false
        ? await this.cachedManifestFreshness()
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
            },
          }
        : {
            manifest: {
              present: false,
              file_count: 0,
              recommended_reads: [],
              important_paths: [],
              freshness,
            },
          }),
      success,
      verification_commands: verificationCommands,
      known_risks: [...(policy?.danger_zones ?? []), ...(policy?.sensitive_paths ?? [])],
      next_actions: uniqueNextActions(nextActions),
    };
  }

  async context(): Promise<WorkspaceContext> {
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
        pending_handoffs: [],
        latest_audit: latestAudit,
        preflight,
        next_actions: uniqueNextActions([...brief.next_actions, ...preflight.next_actions]),
        open_threads: [],
      };
    }

    const manifest = (await this.readManifestResult()).value;
    const packets = await this.safeListContinuityPackets();
    const latestContinuity = packets.at(-1);
    const runs = await this.safeListRuns();
    const activeRuns = runs.filter((run) => run.status === "in_progress");
    const currentRun = activeRuns.filter((run) => run.agent_id === this.agent).at(-1) ?? activeRuns.at(-1);
    const latestRun = runs.at(-1);
    const pendingHandoffs = (await this.safeListHandoffs()).filter(
      (handoff) => handoff.status === "pending" && handoff.recipient === this.agent,
    );
    const preflight = await this.preflight({ checkManifestDrift: false });
    const latestAudit = await this.readCachedAuditReport();

    return {
      schema_version: "1.0",
      view: brief.view,
      brief,
      ...(manifest ? { manifest } : {}),
      ...(latestContinuity ? { latest_continuity: latestContinuity } : {}),
      active_signals: await this.safeListSignals(),
      ...(currentRun ? { current_run: currentRun } : {}),
      ...(latestRun ? { latest_run: latestRun } : {}),
      active_runs: activeRuns,
      pending_handoffs: pendingHandoffs,
      latest_audit: latestAudit,
      preflight,
      next_actions: uniqueNextActions([...brief.next_actions, ...preflight.next_actions]),
      open_threads: [
        ...packets.flatMap((packet) =>
          packet.open_threads.map((thread) => ({
            thread,
            packet_id: packet.id,
            created_at: packet.created_at,
            source: "legacy_continuity" as const,
          })),
        ),
        ...runs.flatMap((run) =>
          run.open_threads.map((thread) => ({
            thread,
            packet_id: run.run_id,
            created_at: run.updated_at,
            source: "run" as const,
          })),
        ),
        ...pendingHandoffs.flatMap((handoff) =>
          handoff.open_threads.map((thread) => ({
            thread,
            packet_id: handoff.handoff_id,
            created_at: handoff.created_at,
            source: "handoff" as const,
          })),
        ),
      ],
    };
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
        manifestFreshness = await this.cachedManifestFreshness();
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
      if (gitDirty.paths.length > 0) {
        checks.push({
          id: "git_dirty",
          status: "warn",
          summary: "Git worktree has local changes.",
          details: { paths: gitDirty.paths },
        });
        issues.push({ severity: "warning", code: "git_dirty", message: "Git worktree has local changes." });
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

    const pendingHandoffs = (await this.listHandoffs()).filter(
      (handoff) => handoff.recipient === this.agent && handoff.status === "pending",
    );
    if (pendingHandoffs.length > 0) {
      checks.push({
        id: "pending_handoffs",
        status: "warn",
        summary: `${pendingHandoffs.length} pending handoff(s) addressed to ${this.agent}.`,
        details: { handoff_ids: pendingHandoffs.map((handoff) => handoff.handoff_id) },
      });
      nextActions.push(commandAction(`seed handoff read ${pendingHandoffs[0]!.handoff_id} --json`, "low", "Review pending handoff."));
    } else {
      checks.push({ id: "pending_handoffs", status: "pass", summary: `No pending handoffs for ${this.agent}.` });
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
    const manifestResult = await this.readManifestResult();
    const manifest = manifestResult.value;
    const policyResult = await this.readPolicyResult();
    const policy = policyResult.value;

    if (!manifest) {
      const message = manifestResult.error ?? "Workspace manifest is missing.";
      issues.push({ severity: "error", code: "manifest_missing", message });
      checks.push({ id: "manifest", status: "fail", summary: message, path: "manifest.json" });
      nextActions.push(commandAction("seed view sync", "low", "Create or repair workspace manifest."));
    } else {
      checks.push({ id: "manifest", status: "pass", summary: "Manifest parses.", path: "manifest.json" });
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

    for (const signal of await this.listSignals({ includeExpired: true })) {
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

    await this.collectMalformedArtifacts("runs", this.runsDir, RunJournalSchema, issues, checks);
    await this.collectMalformedArtifacts("handoffs", this.handoffsDir, HandoffSchema, issues, checks);
    if (policyResult.errorMessage) {
      issues.push({ severity: "error", code: "policy_malformed", message: policyResult.errorMessage, path: "policy.json" });
      checks.push({ id: "policy", status: "fail", summary: policyResult.errorMessage, path: "policy.json" });
    } else if (policyResult.value) {
      checks.push({ id: "policy", status: "pass", summary: "Policy parses.", path: "policy.json" });
      if (!policyResult.value.purpose || !policyResult.value.current_focus) {
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

    const handoffs = input.viewPresent ? await this.safeListHandoffs() : [];
    const packets = input.viewPresent ? await this.safeListContinuityPackets() : [];
    const latestRun = runs.at(-1);
    const handoffReady = Boolean(
      handoffs.some((handoff) => handoff.status === "pending" && (handoff.validation.length > 0 || handoff.next_actions.length > 0 || handoff.open_threads.length > 0)) ||
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
      if (dirty.inside && dirty.paths.length > 0) {
        const dirtySet = new Set(dirty.paths);
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
    ]);
  }

  private async readManifestIfPresent(): Promise<WorkspaceManifest | undefined> {
    try {
      return await this.readManifest();
    } catch {
      return undefined;
    }
  }

  private async readManifestResult(): Promise<{ value?: WorkspaceManifest; error?: string }> {
    if (!existsSync(this.manifestPath)) return {};
    try {
      return { value: await this.readManifest() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
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

  private async scanFiles(extraIgnore: string[]): Promise<string[]> {
    const ignored = new Set([...DEFAULT_IGNORE, ...extraIgnore]);
    const out: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
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

  private async listContinuityPackets(): Promise<ContinuityPacket[]> {
    await this.ensureDirs();
    const entries = await readdir(this.continuityDir, { withFileTypes: true });
    const packets: ContinuityPacket[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        packets.push(await this.readJson(path.join(this.continuityDir, entry.name), ContinuityPacketSchema));
      }
    }

    return packets.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private async safeListContinuityPackets(): Promise<ContinuityPacket[]> {
    if (!existsSync(this.continuityDir)) return [];
    try {
      const entries = await readdir(this.continuityDir, { withFileTypes: true });
      const packets: ContinuityPacket[] = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          packets.push(await this.readJson(path.join(this.continuityDir, entry.name), ContinuityPacketSchema));
        }
      }
      return packets.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } catch {
      return [];
    }
  }

  private async safeListRuns(): Promise<RunJournal[]> {
    if (!existsSync(this.runsDir)) return [];
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    const runs: RunJournal[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        runs.push(await this.readJson(path.join(this.runsDir, entry.name), RunJournalSchema));
      } catch {
        continue;
      }
    }
    return runs.sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  private async safeListHandoffs(): Promise<Handoff[]> {
    if (!existsSync(this.handoffsDir)) return [];
    const entries = await readdir(this.handoffsDir, { withFileTypes: true });
    const handoffs: Handoff[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        handoffs.push(await this.readJson(path.join(this.handoffsDir, entry.name), HandoffSchema));
      } catch {
        continue;
      }
    }
    return handoffs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private async safeListSignals(options: { includeExpired?: boolean } = {}): Promise<Signal[]> {
    if (!existsSync(this.signalsDir)) return [];
    const entries = await readdir(this.signalsDir, { withFileTypes: true });
    const signals: Signal[] = [];
    const now = this.now().getTime();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const signal = await this.readJson(path.join(this.signalsDir, entry.name), SignalSchema);
        if (options.includeExpired || Date.parse(signal.expires_at) > now) {
          signals.push(signal);
        }
      } catch {
        continue;
      }
    }
    return signals.sort((a, b) => a.created_at.localeCompare(b.created_at));
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

  private async cachedManifestFreshness(): Promise<"fresh" | "stale"> {
    if (!existsSync(this.auditPath)) return "fresh";
    try {
      const parsed = JSON.parse(await readFile(this.auditPath, "utf8")) as AuditReport;
      return parsed.issues.some((issue) =>
        issue.code === "manifest_stale" ||
        issue.code === "file_missing_from_manifest" ||
        issue.code === "file_hash_changed" ||
        issue.code === "manifest_file_missing"
      )
        ? "stale"
        : "fresh";
    } catch {
      return "fresh";
    }
  }

  private async activeRun(agent = this.agent): Promise<RunJournal | undefined> {
    return (await this.listRuns()).filter((run) => run.agent_id === agent && run.status === "in_progress").at(-1);
  }

  private async requireActiveRun(agent = this.agent): Promise<RunJournal> {
    const run = await this.activeRun(agent);
    if (!run) {
      throw new Error(`No active run for ${agent}. Run \`seed run start --goal "..."\` first.`);
    }
    return run;
  }

  private async updateRun(run: RunJournal): Promise<RunJournal> {
    run.updated_at = this.nowIso();
    await this.writeRun(run);
    return run;
  }

  private async writeRun(run: RunJournal): Promise<void> {
    await this.writeJson(this.runPath(run.run_id), run);
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

  private gitDirtyState(): { inside: boolean; paths: string[] } {
    const inside = spawnSync("git", ["-C", this.root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    });
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      return { inside: false, paths: [] };
    }
    const status = spawnSync("git", ["-C", this.root, "status", "--porcelain"], {
      encoding: "utf8",
    });
    if (status.status !== 0) return { inside: true, paths: [] };
    return {
      inside: true,
      paths: status.stdout
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean),
    };
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

  private async collectMalformedArtifacts(
    label: "runs" | "handoffs",
    dir: string,
    schema: ZodType<unknown>,
    issues: AuditReport["issues"],
    checks: ViewCheck[],
  ): Promise<void> {
    if (!existsSync(dir)) {
      checks.push({ id: label, status: "pass", summary: `${label} directory has no artifacts yet.`, path: label });
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    let malformed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(dir, entry.name);
      try {
        await this.readJson(filePath, schema);
      } catch (error) {
        malformed += 1;
        issues.push({
          severity: "error",
          code: `${label}_malformed`,
          message: error instanceof Error ? error.message : String(error),
          path: normalizeRelativePath(path.relative(this.dataDir, filePath)),
        });
      }
    }
    checks.push({
      id: label,
      status: malformed > 0 ? "fail" : "pass",
      summary: malformed > 0 ? `${malformed} malformed ${label} artifact(s).` : `${label} artifacts parse.`,
      path: label,
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
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function matchesSignal(signal: Signal, input: ReleaseSignalInput): boolean {
  if (input.id && signal.id !== input.id) {
    return false;
  }
  if (input.type && signal.type !== input.type) {
    return false;
  }
  if (input.target && signal.target !== normalizeRelativePath(input.target)) {
    return false;
  }
  if (input.owner && signal.owner !== input.owner) {
    return false;
  }
  return Boolean(input.id || input.type || input.target || input.owner);
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
