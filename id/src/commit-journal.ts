import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  appendAuditEntry,
  canonicalJSON,
  hashPassport,
  readAuditLog,
  type AuditEntry,
} from "./audit.js";
import { IdentityCommitRepairError, IdentityConfigError, PassportNotFoundError } from "./errors.js";
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
  now?: Date;
}): CommitJournalRecord {
  const record = {
    version: "1.0",
    transaction_id: randomUUID(),
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

export async function repairPendingCommit(options: CommitRepairOptions = {}): Promise<CommitRepairResult> {
  const journalPath = resolveJournalPath(options);
  const record = await readCommitJournal(journalPath);
  if (!record) {
    return {
      status: "no_pending_commit",
      repaired: false,
      journalPath,
      passportPath: options.passportPath,
      auditPath: options.auditPath,
      auditAppended: false,
      passportWritten: false,
      journalCleared: false,
      reason: "no pending commit journal exists",
    };
  }

  if (options.passportPath && options.passportPath !== record.passport_path) {
    return conflictResult(
      journalPath,
      options.passportPath,
      options.auditPath ?? record.audit_path,
      "passportPath option does not match pending commit journal",
    );
  }
  if (options.auditPath && options.auditPath !== record.audit_path) {
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
  const log = await readAuditLog(auditPath);
  const entryIndex = log.findIndex((entry) => auditEntriesEqual(entry, record.audit_entry));
  const hasAuditEntry = entryIndex !== -1;
  const auditEntryIsLast = entryIndex === log.length - 1;

  if (hasAuditEntry && !auditEntryIsLast) {
    const auditTipHash = log[log.length - 1]?.after_hash;
    if (currentHash === auditTipHash) {
      await clearCommitJournal(journalPath);
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

  if (currentHash !== null && currentHash !== record.before_hash && currentHash !== record.after_hash) {
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

  if (currentHash !== record.after_hash) {
    await writePassportViaTemp(record.after_passport, passportPath);
    passportWritten = true;
  }

  await clearCommitJournal(journalPath);

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
