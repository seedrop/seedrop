import { readPassport } from "./passport.js";
import type { ActiveProject, LearnedBlock, Passport } from "./schema.js";
import { Session, type SessionOptions } from "./session.js";
import { IdentityConfigError, PassportNotFoundError } from "./errors.js";
import {
  commitPassportTransaction,
  repairPendingCommit,
  type CommitRepairOptions,
  type CommitRepairResult,
  type PassportCommitPhase,
} from "./commit-journal.js";
import {
  hashPassport,
  readAuditLog,
  type AuditEntry,
  type PassportChanges,
} from "./audit.js";

export interface CommitSessionOptions {
  write?: boolean;
  passportPath?: string;
  auditPath?: string;
  journalPath?: string;
  newLearnedBlocks?: readonly LearnedBlock[];
  notes?: string;
  now?: Date;
  commandId?: string;
  expectedHash?: string;
  lockTimeoutMs?: number;
  onPhase?: (phase: PassportCommitPhase) => void | Promise<void>;
}

export interface UpsertActiveProjectInput {
  id: string;
  root: string;
  role?: string;
  currentFocus?: string;
  space?: string;
  view?: string;
}

export interface UpsertActiveProjectOptions {
  write?: boolean;
  passportPath?: string;
  auditPath?: string;
  journalPath?: string;
  notes?: string;
  now?: Date;
  commandId?: string;
  expectedHash?: string;
  lockTimeoutMs?: number;
  onPhase?: (phase: PassportCommitPhase) => void | Promise<void>;
}

export interface CommitSessionResult {
  before: Passport;
  after: Passport;
  changes: PassportChanges;
  entry: AuditEntry;
  wrote: boolean;
  passportPath: string | undefined;
  auditPath: string | undefined;
  journalPath: string | undefined;
  commandId: string | undefined;
  expectedHash: string;
  idempotent: boolean;
}

export type UpsertActiveProjectResult = CommitSessionResult;

export class Identity {
  private _passport: Passport;
  private readonly loadedFrom: string | undefined;

  private constructor(passport: Passport, loadedFrom?: string) {
    this._passport = passport;
    this.loadedFrom = loadedFrom;
  }

  get passport(): Passport {
    return structuredClone(this._passport);
  }

  static async fromPassport(path: string): Promise<Identity> {
    const passport = await readPassport(path);
    return new Identity(passport, path);
  }

  static async savePassport(
    passport: Passport,
    path: string,
    options: Pick<CommitSessionOptions, "commandId" | "expectedHash" | "notes" | "now" | "lockTimeoutMs" | "onPhase"> = {},
  ): Promise<void> {
    let before: Passport | null;
    try {
      before = await readPassport(path);
    } catch (error) {
      if (!(error instanceof PassportNotFoundError)) throw error;
      before = null;
    }
    await commitPassportTransaction(before, passport, {}, {
      passportPath: path,
      commandId: options.commandId,
      expectedHash: options.expectedHash,
      notes: options.notes ?? (before ? "replaced passport" : "created passport"),
      now: options.now,
      lockTimeoutMs: options.lockTimeoutMs,
      onPhase: options.onPhase,
    });
  }

  static async repairPendingCommit(options: CommitRepairOptions = {}): Promise<CommitRepairResult> {
    return repairPendingCommit(options);
  }

  session(options?: SessionOptions): Session {
    return new Session(this._passport, options);
  }

  async updateMutableFields(
    input: { name?: string; purpose?: string },
    options: UpsertActiveProjectOptions = {},
  ): Promise<CommitSessionResult> {
    const before = this._passport;
    const after: Passport = {
      ...before,
      name: input.name ?? before.name,
      purpose: input.purpose ?? before.purpose,
    };
    return this.commitPassportChange(after, {}, options);
  }

  async upsertActiveProject(
    input: UpsertActiveProjectInput,
    options: UpsertActiveProjectOptions = {},
  ): Promise<UpsertActiveProjectResult> {
    const now = options.now ?? new Date();
    const before = this._passport;
    const projects = before.active_projects ?? [];
    const project = normalizeActiveProject(input, now);
    const existing = projects.find((candidate) => candidate.id === project.id);
    const afterProject = existing ? mergeActiveProject(existing, project) : project;
    const afterProjects = existing
      ? projects.map((candidate) => (candidate.id === project.id ? afterProject : candidate))
      : [...projects, afterProject];
    const continuity = {
      next_actions: before.continuity?.next_actions ?? [],
      open_threads: before.continuity?.open_threads ?? [],
      ...(before.continuity?.current_focus ? { current_focus: before.continuity.current_focus } : {}),
      ...(before.continuity?.handoff ? { handoff: before.continuity.handoff } : {}),
      updated_at: now.toISOString(),
    };
    const after: Passport = {
      ...before,
      active_projects: afterProjects,
      continuity,
    };

    return this.commitPassportChange(
      after,
      {
        active_projects: {
          before: projects,
          after: afterProjects,
        },
        continuity: {
          before: before.continuity,
          after: continuity,
        },
      },
      { ...options, now },
    );
  }

  async commitSession(options: CommitSessionOptions = {}): Promise<CommitSessionResult> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const before = this._passport;

    const existingPatterns = new Set(before.learned_blocks.map((b) => b.pattern));
    const requested = options.newLearnedBlocks ?? [];
    const added: LearnedBlock[] = [];
    for (const b of requested) {
      if (!existingPatterns.has(b.pattern)) {
        added.push({ pattern: b.pattern, reason: b.reason, source_session: b.source_session });
        existingPatterns.add(b.pattern);
      }
    }

    const after: Passport = {
      ...before,
      metadata: {
        ...before.metadata,
        session_count: before.metadata.session_count + 1,
        last_session_at: nowIso,
      },
      learned_blocks: added.length > 0 ? [...before.learned_blocks, ...added] : before.learned_blocks,
    };

    const changes: PassportChanges = {
      session_count: {
        before: before.metadata.session_count,
        after: after.metadata.session_count,
      },
      last_session_at: {
        before: before.metadata.last_session_at,
        after: nowIso,
      },
    };
    if (added.length > 0) changes.learned_blocks_added = added;

    return this.commitPassportChange(after, changes, options);
  }

  private async commitPassportChange(
    after: Passport,
    changes: PassportChanges,
    options: UpsertActiveProjectOptions,
  ): Promise<CommitSessionResult> {
    const write = options.write ?? false;
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const before = this._passport;
    let expectedHash = options.expectedHash ?? hashPassport(before);
    let prevHash: string | null = null;

    if (write) {
      const passportPath = options.passportPath ?? this.loadedFrom;
      if (!passportPath) {
        throw new IdentityConfigError(
          "commitSession({ write: true }) requires passportPath or an Identity loaded via Identity.fromPassport()",
        );
      }
      if (options.expectedHash === undefined) {
        try {
          await readPassport(passportPath);
        } catch (error) {
          if (!(error instanceof PassportNotFoundError)) throw error;
          expectedHash = "absent";
        }
      }
      const committed = await commitPassportTransaction(before, after, changes, {
        passportPath,
        auditPath: options.auditPath,
        journalPath: options.journalPath,
        commandId: options.commandId,
        expectedHash,
        notes: options.notes,
        now,
        lockTimeoutMs: options.lockTimeoutMs,
        onPhase: options.onPhase,
      });
      this._passport = committed.current;
      return {
        before,
        after,
        changes,
        entry: committed.entry,
        wrote: committed.wrote,
        passportPath: committed.passportPath,
        auditPath: committed.auditPath,
        journalPath: committed.journalPath,
        commandId: committed.commandId,
        expectedHash: committed.expectedHash,
        idempotent: committed.idempotent,
      };
    }

    if (options.auditPath) {
      const log = await readAuditLog(options.auditPath);
      const last = log[log.length - 1];
      if (last) prevHash = last.after_hash;
    }

    const entry: AuditEntry = {
      timestamp: nowIso,
      before_hash: expectedHash,
      after_hash: hashPassport(after),
      prev_hash: prevHash,
      changes,
      ...(options.notes !== undefined ? { notes: options.notes } : {}),
    };

    return {
      before,
      after,
      changes,
      entry,
      wrote: write,
      passportPath: undefined,
      auditPath: options.auditPath,
      journalPath: undefined,
      commandId: undefined,
      expectedHash,
      idempotent: false,
    };
  }
}

function normalizeActiveProject(input: UpsertActiveProjectInput, now: Date): ActiveProject {
  const project: ActiveProject = {
    id: input.id,
    root: input.root,
    last_seen_at: now.toISOString(),
  };
  if (input.role) project.role = input.role;
  if (input.currentFocus) project.current_focus = input.currentFocus;
  if (input.space) project.space = input.space;
  if (input.view) project.view = input.view;
  return project;
}

function mergeActiveProject(existing: ActiveProject, next: ActiveProject): ActiveProject {
  return {
    ...existing,
    ...next,
  };
}
