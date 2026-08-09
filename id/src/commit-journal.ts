import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  appendAuditEntry,
  canonicalJSON,
  hashPassport,
  readAuditLog,
  type AuditEntry,
} from "./audit.js";
import {
  IdentityCommandConflictError,
  IdentityCommitRepairError,
  IdentityConfigError,
  IdentityLockTimeoutError,
  IdentityVersionConflictError,
  PassportNotFoundError,
} from "./errors.js";
import { readPassport, serializePassport } from "./passport.js";
import { ActiveProjectSchema, ContinuityStateSchema, LearnedBlockSchema, PassportSchema, type Passport } from "./schema.js";

const PassportChangesSchema = z
  .object({
    session_count: z.object({ before: z.number().int(), after: z.number().int() }).optional(),
    last_session_at: z
      .object({
        before: z.string().datetime({ offset: true }).optional(),
        after: z.string().datetime({ offset: true }),
      })
      .optional(),
    learned_blocks_added: z.array(LearnedBlockSchema).optional(),
    active_projects: z
      .object({
        before: z.array(ActiveProjectSchema),
        after: z.array(ActiveProjectSchema),
      })
      .optional(),
    continuity: z
      .object({
        before: ContinuityStateSchema.optional(),
        after: ContinuityStateSchema.optional(),
      })
      .optional(),
  })
  .strict();

const AuditEntrySchema = z
  .object({
    timestamp: z.string().datetime({ offset: true }),
    before_hash: z.string().min(1),
    after_hash: z.string().min(1),
    prev_hash: z.string().min(1).nullable(),
    changes: PassportChangesSchema,
    notes: z.string().optional(),
  })
  .strict();

export const CommitJournalRecordSchema = z
  .object({
    version: z.literal("1.0"),
    transaction_id: z.string().min(1),
    created_at: z.string().datetime({ offset: true }),
    passport_path: z.string().min(1),
    audit_path: z.string().min(1),
    before_hash: z.string().min(1),
    after_hash: z.string().min(1),
    audit_entry: AuditEntrySchema,
    after_passport: PassportSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.audit_entry.before_hash !== record.before_hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audit_entry", "before_hash"],
        message: "audit_entry.before_hash must match before_hash",
      });
    }
    if (record.audit_entry.after_hash !== record.after_hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audit_entry", "after_hash"],
        message: "audit_entry.after_hash must match after_hash",
      });
    }
    if (hashPassport(record.after_passport) !== record.after_hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["after_passport"],
        message: "after_passport hash must match after_hash",
      });
    }
  });

export type CommitJournalRecord = z.infer<typeof CommitJournalRecordSchema>;

export interface CommitRepairOptions {
  passportPath?: string;
  auditPath?: string;
  journalPath?: string;
}

export type CommitRepairStatus = "no_pending_commit" | "completed" | "already_completed" | "conflict";

export interface CommitRepairResult {
  status: CommitRepairStatus;
  repaired: boolean;
  journalPath: string;
  passportPath: string | undefined;
  auditPath: string | undefined;
  auditAppended: boolean;
  passportWritten: boolean;
  journalCleared: boolean;
  reason?: string;
}

export type PassportCommitPhase = "journal_written" | "audit_appended" | "passport_written";

export interface PassportTransactionOptions {
  passportPath: string;
  auditPath?: string;
  journalPath?: string;
  commandId?: string;
  expectedHash?: string;
  notes?: string;
  now?: Date;
  lockTimeoutMs?: number;
  onPhase?: (phase: PassportCommitPhase) => void | Promise<void>;
}

export interface PassportTransactionResult {
  before: Passport | null;
  after: Passport;
  current: Passport;
  changes: z.infer<typeof PassportChangesSchema>;
  entry: AuditEntry;
  commandId: string;
  expectedHash: string;
  wrote: boolean;
  idempotent: boolean;
  passportPath: string;
  auditPath: string;
  journalPath: string;
}

const ABSENT_PASSPORT_HASH = "absent";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export function defaultCommitJournalPath(passportPath: string): string {
  return `${passportPath}.commit.json`;
}

export function createCommitJournalRecord(options: {
  passportPath: string;
  auditPath: string;
  beforeHash: string;
  afterHash: string;
  auditEntry: AuditEntry;
  afterPassport: Passport;
  commandId?: string;
  now?: Date;
}): CommitJournalRecord {
  const record = {
    version: "1.0",
    transaction_id: options.commandId ?? randomUUID(),
    created_at: (options.now ?? new Date()).toISOString(),
    passport_path: options.passportPath,
    audit_path: options.auditPath,
    before_hash: options.beforeHash,
    after_hash: options.afterHash,
    audit_entry: options.auditEntry,
    after_passport: options.afterPassport,
  } satisfies CommitJournalRecord;
  return parseCommitJournalRecord(record, "new commit journal record");
}

export async function writeCommitJournal(path: string, record: CommitJournalRecord): Promise<void> {
  const parsed = parseCommitJournalRecord(record, path);
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    await rename(tempPath, path);
  } catch (err) {
    await cleanupTemp(tempPath);
    throw err;
  }
}

export async function readCommitJournal(path: string): Promise<CommitJournalRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new IdentityCommitRepairError(`Failed to parse commit journal at ${path}`, { cause: err });
  }

  return parseCommitJournalRecord(json, path);
}

export async function clearCommitJournal(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function commitPassportTransaction(
  before: Passport | null,
  after: Passport,
  changes: z.infer<typeof PassportChangesSchema>,
  options: PassportTransactionOptions,
): Promise<PassportTransactionResult> {
  const passportPath = await canonicalPassportPath(options.passportPath);
  const auditPath = options.auditPath ?? `${passportPath}.audit.jsonl`;
  const journalPath = options.journalPath ?? defaultCommitJournalPath(passportPath);
  const commandId = options.commandId?.trim() || randomUUID();
  const expectedHash = options.expectedHash ?? (before ? hashPassport(before) : ABSENT_PASSPORT_HASH);
  const afterHash = hashPassport(after);

  return withPassportLock(passportPath, options.lockTimeoutMs, async () => {
    await mkdir(dirname(auditPath), { recursive: true });
    await mkdir(dirname(journalPath), { recursive: true });
    const pending = await readCommitJournal(journalPath);
    if (pending) {
      const repaired = await repairPendingCommitUnlocked({ passportPath, auditPath, journalPath });
      if (repaired.status === "conflict") {
        throw new IdentityCommitRepairError(`Pending passport transaction requires repair: ${repaired.reason}`);
      }
    }

    const log = await readAuditLog(auditPath);
    const current = await readPassportOrNull(passportPath);
    const currentHash = current ? hashPassport(current) : ABSENT_PASSPORT_HASH;
    const auditTip = log.at(-1);
    if (auditTip && auditTip.after_hash !== currentHash) {
      throw new IdentityCommitRepairError(
        `Passport/audit disagreement before command ${commandId}: passport=${currentHash}, audit=${auditTip.after_hash}`,
      );
    }
    const marker = commandMarker(commandId);
    const priorCommand = log.find((entry) => entry.notes?.startsWith(marker));
    if (priorCommand) {
      if (
        priorCommand.after_hash !== afterHash
        || (options.expectedHash !== undefined && priorCommand.before_hash !== expectedHash)
      ) {
        throw new IdentityCommandConflictError(commandId);
      }
      if (!current) {
        throw new IdentityCommitRepairError(`Passport is absent after completed command ${commandId}`);
      }
      return {
        before,
        after,
        current,
        changes,
        entry: priorCommand,
        commandId,
        expectedHash: priorCommand.before_hash,
        wrote: false,
        idempotent: true,
        passportPath,
        auditPath,
        journalPath,
      };
    }

    if (currentHash !== expectedHash) throw new IdentityVersionConflictError(expectedHash, current ? currentHash : null);

    const now = options.now ?? new Date();
    const entry: AuditEntry = {
      timestamp: now.toISOString(),
      before_hash: expectedHash,
      after_hash: afterHash,
      prev_hash: auditTip?.after_hash ?? null,
      changes: PassportChangesSchema.parse(changes),
      notes: options.notes ? `${marker} ${options.notes}` : marker,
    };
    const prepared = await preparePassportWrite(after, passportPath);
    try {
      await writeCommitJournal(
        journalPath,
        createCommitJournalRecord({
          passportPath,
          auditPath,
          beforeHash: expectedHash,
          afterHash,
          auditEntry: entry,
          afterPassport: after,
          commandId,
          now,
        }),
      );
      await options.onPhase?.("journal_written");
      await appendAuditEntry(auditPath, entry);
      await options.onPhase?.("audit_appended");
      await prepared.commit();
      await options.onPhase?.("passport_written");
      await clearCommitJournal(journalPath);
    } catch (error) {
      await prepared.cleanup().catch(() => undefined);
      throw error;
    }

    return {
      before,
      after,
      current: after,
      changes,
      entry,
      commandId,
      expectedHash,
      wrote: true,
      idempotent: false,
      passportPath,
      auditPath,
      journalPath,
    };
  });
}

export async function repairPendingCommit(options: CommitRepairOptions = {}): Promise<CommitRepairResult> {
  const journalPath = resolveJournalPath(options);
  const record = await readCommitJournal(journalPath);
  if (!record) return noPendingResult(journalPath, options.passportPath, options.auditPath);
  const passportPath = await canonicalPassportPath(options.passportPath ?? record.passport_path);
  return withPassportLock(passportPath, undefined, () => repairPendingCommitUnlocked({
    ...options,
    passportPath,
    journalPath,
  }));
}

async function repairPendingCommitUnlocked(options: CommitRepairOptions = {}): Promise<CommitRepairResult> {
  const journalPath = resolveJournalPath(options);
  const record = await readCommitJournal(journalPath);
  if (!record) {
    return noPendingResult(journalPath, options.passportPath, options.auditPath);
  }

  if (options.passportPath && !(await pathsEquivalent(options.passportPath, record.passport_path))) {
    return conflictResult(
      journalPath,
      options.passportPath,
      options.auditPath ?? record.audit_path,
      "passportPath option does not match pending commit journal",
    );
  }
  if (options.auditPath && !(await pathsEquivalent(options.auditPath, record.audit_path))) {
    return conflictResult(
      journalPath,
      record.passport_path,
      options.auditPath,
      "auditPath option does not match pending commit journal",
    );
  }

  const passportPath = options.passportPath ?? record.passport_path;
  const auditPath = options.auditPath ?? record.audit_path;
  const currentHash = await currentPassportHash(passportPath);
  const currentVersionHash = currentHash ?? ABSENT_PASSPORT_HASH;
  const log = await readAuditLog(auditPath);
  const entryIndex = log.findIndex((entry) => auditEntriesEqual(entry, record.audit_entry));
  const hasAuditEntry = entryIndex !== -1;
  const auditEntryIsLast = entryIndex === log.length - 1;

  if (hasAuditEntry && !auditEntryIsLast) {
    const auditTipHash = log[log.length - 1]?.after_hash;
    if (currentHash === auditTipHash) {
      await clearCommitJournal(journalPath);
      await cleanupPreparedTemps(passportPath);
      return {
        status: "already_completed",
        repaired: false,
        journalPath,
        passportPath,
        auditPath,
        auditAppended: false,
        passportWritten: false,
        journalCleared: true,
        reason: "pending commit was already followed by newer completed audit entries",
      };
    }
    return conflictResult(journalPath, passportPath, auditPath, "audit log has newer entries after the pending commit");
  }

  if (currentVersionHash !== record.before_hash && currentVersionHash !== record.after_hash) {
    return conflictResult(journalPath, passportPath, auditPath, "passport hash does not match pending commit before/after hashes");
  }

  let auditAppended = false;
  let passportWritten = false;

  if (!hasAuditEntry) {
    const last = log[log.length - 1];
    const expectedPrev = record.audit_entry.prev_hash;
    if ((last?.after_hash ?? null) !== expectedPrev) {
      return conflictResult(journalPath, passportPath, auditPath, "audit log tip does not match pending commit prev_hash");
    }
    await appendAuditEntry(auditPath, record.audit_entry);
    auditAppended = true;
  }

  if (currentVersionHash !== record.after_hash) {
    await writePassportViaTemp(record.after_passport, passportPath);
    passportWritten = true;
  }

  await clearCommitJournal(journalPath);
  await cleanupPreparedTemps(passportPath);

  return {
    status: passportWritten || auditAppended ? "completed" : "already_completed",
    repaired: passportWritten || auditAppended,
    journalPath,
    passportPath,
    auditPath,
    auditAppended,
    passportWritten,
    journalCleared: true,
  };
}

function noPendingResult(
  journalPath: string,
  passportPath?: string,
  auditPath?: string,
): CommitRepairResult {
  return {
    status: "no_pending_commit",
    repaired: false,
    journalPath,
    passportPath,
    auditPath,
    auditAppended: false,
    passportWritten: false,
    journalCleared: false,
    reason: "no pending commit journal exists",
  };
}

function commandMarker(commandId: string): string {
  return `[seedrop-command:${Buffer.from(commandId, "utf8").toString("base64url")}]`;
}

async function canonicalPassportPath(path: string): Promise<string> {
  if (!path) throw new IdentityConfigError("passportPath must be non-empty");
  await mkdir(dirname(path), { recursive: true });
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

async function pathsEquivalent(left: string, right: string): Promise<boolean> {
  return (await canonicalPassportPath(left)) === (await canonicalPassportPath(right));
}

async function readPassportOrNull(path: string): Promise<Passport | null> {
  try {
    return await readPassport(path);
  } catch (error) {
    if (error instanceof PassportNotFoundError) return null;
    throw error;
  }
}

async function preparePassportWrite(passport: Passport, passportPath: string): Promise<{
  commit(): Promise<void>;
  cleanup(): Promise<void>;
}> {
  const tempPath = `${passportPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, serializePassport(passport), "utf8");
  return {
    commit: () => rename(tempPath, passportPath),
    cleanup: () => rm(tempPath, { force: true }),
  };
}

async function withPassportLock<T>(
  passportPath: string,
  timeoutMs: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${passportPath}.lock`;
  const deadline = Date.now() + (timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const ownerToken = randomUUID();
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), token: ownerToken })}\n`,
          "utf8",
        );
        await handle.sync();
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await releaseOwnedLock(lockPath, ownerToken).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reapStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new IdentityLockTimeoutError(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function reapStaleLock(lockPath: string): Promise<boolean> {
  const reaperPath = `${lockPath}.reap`;
  let reaper: Awaited<ReturnType<typeof open>>;
  try {
    reaper = await open(reaperPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  try {
    await reaper.writeFile(
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      "utf8",
    );
    await reaper.sync();
    if (!(await lockIsStale(lockPath))) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await reaper.close().catch(() => undefined);
    await rm(reaperPath, { force: true }).catch(() => undefined);
  }
}

async function releaseOwnedLock(lockPath: string, ownerToken: string): Promise<void> {
  let parsed: { token?: string };
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (parsed.token === ownerToken) await rm(lockPath, { force: true });
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; created_at?: string };
    const age = parsed.created_at ? Date.now() - Date.parse(parsed.created_at) : Number.POSITIVE_INFINITY;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return age > STALE_LOCK_MS;
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" || age > STALE_LOCK_MS;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

function resolveJournalPath(options: CommitRepairOptions): string {
  if (options.journalPath) return options.journalPath;
  if (options.passportPath) return defaultCommitJournalPath(options.passportPath);
  throw new IdentityConfigError("repairPendingCommit() requires journalPath or passportPath");
}

function parseCommitJournalRecord(value: unknown, path: string): CommitJournalRecord {
  const result = CommitJournalRecordSchema.safeParse(value);
  if (!result.success) {
    throw new IdentityCommitRepairError(
      `Commit journal failed validation at ${path}: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
      { cause: result.error },
    );
  }
  return result.data;
}

async function currentPassportHash(passportPath: string): Promise<string | null> {
  try {
    return hashPassport(await readPassport(passportPath));
  } catch (err) {
    if (err instanceof PassportNotFoundError) return null;
    throw err;
  }
}

function auditEntriesEqual(left: AuditEntry, right: AuditEntry): boolean {
  return canonicalJSON(left) === canonicalJSON(right);
}

async function writePassportViaTemp(passport: Passport, passportPath: string): Promise<void> {
  const tempPath = `${passportPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, serializePassport(passport), "utf8");
    await rename(tempPath, passportPath);
  } catch (err) {
    await cleanupTemp(tempPath);
    throw err;
  }
}

async function cleanupTemp(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Best effort only; preserve the original failure.
  }
}

async function cleanupPreparedTemps(passportPath: string): Promise<void> {
  const directory = dirname(passportPath);
  const prefix = `${basename(passportPath)}.tmp-`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => rm(join(directory, entry), { force: true })),
  );
}

function conflictResult(
  journalPath: string,
  passportPath: string,
  auditPath: string,
  reason: string,
): CommitRepairResult {
  return {
    status: "conflict",
    repaired: false,
    journalPath,
    passportPath,
    auditPath,
    auditAppended: false,
    passportWritten: false,
    journalCleared: false,
    reason,
  };
}
