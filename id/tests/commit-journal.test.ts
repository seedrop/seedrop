import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAuditEntry,
  hashPassport,
  readAuditLog,
  type AuditEntry,
} from "../src/audit.js";
import {
  createCommitJournalRecord,
  defaultCommitJournalPath,
  readCommitJournal,
  repairPendingCommit,
  writeCommitJournal,
} from "../src/commit-journal.js";
import { readPassport, writePassport } from "../src/passport.js";
import type { Passport } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

let scratch: string;
let passportPath: string;
let auditPath: string;
let journalPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "seedrop-id-journal-"));
  passportPath = join(scratch, "passport.json");
  auditPath = `${passportPath}.audit.jsonl`;
  journalPath = defaultCommitJournalPath(passportPath);
  await copyFile(fixturePath, passportPath);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("commit journal repair", () => {
  it("returns no_pending_commit when no journal exists", async () => {
    const result = await repairPendingCommit({ passportPath });
    expect(result.status).toBe("no_pending_commit");
    expect(result.repaired).toBe(false);
  });

  it("repairs a prepared commit before audit append or passport promotion", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));

    const result = await repairPendingCommit({ passportPath });

    expect(result.status).toBe("completed");
    expect(result.auditAppended).toBe(true);
    expect(result.passportWritten).toBe(true);
    expect(result.journalCleared).toBe(true);
    expect(hashPassport(await readPassport(passportPath))).toBe(entry.after_hash);
    expect(await readAuditLog(auditPath)).toEqual([entry]);
    expect(await readCommitJournal(journalPath)).toBeNull();
  });

  it("finishes when audit append landed but passport promotion did not", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    await appendAuditEntry(auditPath, entry);

    const result = await repairPendingCommit({ passportPath });

    expect(result.status).toBe("completed");
    expect(result.auditAppended).toBe(false);
    expect(result.passportWritten).toBe(true);
    expect(hashPassport(await readPassport(passportPath))).toBe(entry.after_hash);
    expect(await readAuditLog(auditPath)).toEqual([entry]);
  });

  it("finishes when passport promotion landed but audit append did not", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    await writePassport(after, passportPath);

    const result = await repairPendingCommit({ passportPath });

    expect(result.status).toBe("completed");
    expect(result.auditAppended).toBe(true);
    expect(result.passportWritten).toBe(false);
    expect(hashPassport(await readPassport(passportPath))).toBe(entry.after_hash);
    expect(await readAuditLog(auditPath)).toEqual([entry]);
  });

  it("clears an already-completed journal without rewriting", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    await appendAuditEntry(auditPath, entry);
    await writePassport(after, passportPath);

    const result = await repairPendingCommit({ passportPath });

    expect(result.status).toBe("already_completed");
    expect(result.repaired).toBe(false);
    expect(result.journalCleared).toBe(true);
    expect(await readCommitJournal(journalPath)).toBeNull();
  });

  it("clears a stale journal when audit and passport already moved beyond it", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    await appendAuditEntry(auditPath, entry);

    const later: Passport = {
      ...after,
      metadata: {
        ...after.metadata,
        session_count: after.metadata.session_count + 1,
        last_session_at: "2026-05-14T13:00:00.000Z",
      },
    };
    const laterEntry: AuditEntry = {
      timestamp: "2026-05-14T13:00:00.000Z",
      before_hash: hashPassport(after),
      after_hash: hashPassport(later),
      prev_hash: entry.after_hash,
      changes: {
        session_count: { before: after.metadata.session_count, after: later.metadata.session_count },
        last_session_at: { before: after.metadata.last_session_at, after: "2026-05-14T13:00:00.000Z" },
      },
    };
    await appendAuditEntry(auditPath, laterEntry);
    await writePassport(later, passportPath);

    const result = await repairPendingCommit({ passportPath });

    expect(result.status).toBe("already_completed");
    expect(result.reason).toContain("newer completed audit entries");
    expect(await readCommitJournal(journalPath)).toBeNull();
  });

  it("leaves the journal in place when passport state conflicts", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    const conflicting = { ...(await readPassport(passportPath)), name: "Different Agent" };
    await writePassport(conflicting, passportPath);

    const result = await repairPendingCommit({ passportPath });

    expect(result.status).toBe("conflict");
    expect(result.reason).toContain("passport hash");
    expect(await readCommitJournal(journalPath)).not.toBeNull();
    expect(await readAuditLog(auditPath)).toEqual([]);
  });

  it("refuses to repair when caller paths disagree with the journal", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));

    const result = await repairPendingCommit({
      journalPath,
      passportPath: join(scratch, "other-passport.json"),
    });

    expect(result.status).toBe("conflict");
    expect(result.reason).toContain("passportPath option");
    expect(await readCommitJournal(journalPath)).not.toBeNull();
  });
});

async function createPendingCommit(): Promise<{ before: Passport; after: Passport; entry: AuditEntry }> {
  const before = await readPassport(passportPath);
  const after: Passport = {
    ...before,
    metadata: {
      ...before.metadata,
      session_count: before.metadata.session_count + 1,
      last_session_at: "2026-05-14T12:00:00.000Z",
    },
  };
  const entry: AuditEntry = {
    timestamp: "2026-05-14T12:00:00.000Z",
    before_hash: hashPassport(before),
    after_hash: hashPassport(after),
    prev_hash: null,
    changes: {
      session_count: { before: before.metadata.session_count, after: after.metadata.session_count },
      last_session_at: { before: before.metadata.last_session_at, after: "2026-05-14T12:00:00.000Z" },
    },
  };
  return { before, after, entry };
}

async function createRecord(after: Passport, entry: AuditEntry) {
  const before = await readPassport(passportPath);
  return createCommitJournalRecord({
    passportPath,
    auditPath,
    beforeHash: hashPassport(before),
    afterHash: hashPassport(after),
    auditEntry: entry,
    afterPassport: after,
    now: new Date("2026-05-14T12:00:00.000Z"),
  });
}
