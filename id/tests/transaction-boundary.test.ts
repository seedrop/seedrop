import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassport, readAuditLog } from "../src/audit.js";
import { defaultCommitJournalPath, readCommitJournal, repairPendingCommit } from "../src/commit-journal.js";
import {
  IdentityCommandConflictError,
  IdentityVersionConflictError,
} from "../src/errors.js";
import { Identity } from "../src/identity.js";
import { readPassport } from "../src/passport.js";
import type { PassportCommitPhase } from "../src/commit-journal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");
const crashChildPath = join(__dirname, "fixtures", "transaction-crash-child.ts");

let scratch: string;
let passportPath: string;
let auditPath: string;
let journalPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "seedrop-id-transaction-"));
  passportPath = join(scratch, "passport.json");
  auditPath = `${passportPath}.audit.jsonl`;
  journalPath = defaultCommitJournalPath(passportPath);
  await copyFile(fixturePath, passportPath);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("passport transaction boundary", () => {
  it("serializes concurrent writers and rejects the stale snapshot", async () => {
    const first = await Identity.fromPassport(passportPath);
    const second = await Identity.fromPassport(passportPath);

    const results = await Promise.allSettled([
      first.updateMutableFields(
        { name: "Concurrent Alpha" },
        { write: true, commandId: "concurrent-alpha" },
      ),
      second.updateMutableFields(
        { name: "Concurrent Beta" },
        { write: true, commandId: "concurrent-beta" },
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(IdentityVersionConflictError) });

    const passport = await readPassport(passportPath);
    expect(["Concurrent Alpha", "Concurrent Beta"]).toContain(passport.name);
    const log = await readAuditLog(auditPath);
    expect(log).toHaveLength(1);
    expect(log[0]?.after_hash).toBe(hashPassport(passport));
    await expect(access(journalPath)).rejects.toThrow();
    await expect(access(`${passportPath}.lock`)).rejects.toThrow();
  });

  it("deduplicates an exact command retry and rejects command-id reuse", async () => {
    const first = await Identity.fromPassport(passportPath);
    const retry = await Identity.fromPassport(passportPath);
    const conflictingRetry = await Identity.fromPassport(passportPath);

    const committed = await first.updateMutableFields(
      { purpose: "Transactional identity" },
      { write: true, commandId: "stable-command" },
    );
    const idempotent = await retry.updateMutableFields(
      { purpose: "Transactional identity" },
      { write: true, commandId: "stable-command" },
    );

    expect(committed.wrote).toBe(true);
    expect(idempotent).toMatchObject({ wrote: false, idempotent: true, commandId: "stable-command" });
    expect(await readAuditLog(auditPath)).toHaveLength(1);
    await expect(
      conflictingRetry.updateMutableFields(
        { purpose: "Different mutation" },
        { write: true, commandId: "stable-command" },
      ),
    ).rejects.toBeInstanceOf(IdentityCommandConflictError);
    expect((await readPassport(passportPath)).purpose).toBe("Transactional identity");
    expect(await readAuditLog(auditPath)).toHaveLength(1);
  });

  it("retries by command ID alone and keeps the Identity at the latest passport", async () => {
    const originalCommand = await Identity.fromPassport(passportPath);
    const staleRetry = await Identity.fromPassport(passportPath);
    await originalCommand.updateMutableFields(
      { purpose: "Original command target" },
      { write: true, commandId: "original-command" },
    );
    const laterCommand = await Identity.fromPassport(passportPath);
    await laterCommand.updateMutableFields(
      { name: "Later state" },
      { write: true, commandId: "later-command" },
    );

    const retried = await staleRetry.updateMutableFields(
      { purpose: "Original command target" },
      { write: true, commandId: "original-command" },
    );

    expect(retried).toMatchObject({ wrote: false, idempotent: true, commandId: "original-command" });
    expect(staleRetry.passport).toMatchObject({ name: "Later state", purpose: "Original command target" });
    expect(await readAuditLog(auditPath)).toHaveLength(2);
    expect((await readPassport(passportPath)).name).toBe("Later state");
  });

  it.each<PassportCommitPhase>(["journal_written", "audit_appended", "passport_written"])(
    "repairs a crash after %s without splitting passport and audit",
    async (crashPhase) => {
      const phasePassport = join(scratch, `passport-${crashPhase}.json`);
      await copyFile(fixturePath, phasePassport);
      const phaseAudit = `${phasePassport}.audit.jsonl`;
      const phaseJournal = defaultCommitJournalPath(phasePassport);
      expect(await runCrashChild(phasePassport, crashPhase)).toBe(91);
      expect(await readCommitJournal(phaseJournal)).not.toBeNull();

      const repaired = await repairPendingCommit({ passportPath: phasePassport });
      expect(["completed", "already_completed"]).toContain(repaired.status);
      const passport = await readPassport(phasePassport);
      const log = await readAuditLog(phaseAudit);
      expect(log).toHaveLength(1);
      expect(log[0]?.after_hash).toBe(hashPassport(passport));
      expect(await readCommitJournal(phaseJournal)).toBeNull();
      await expect(access(`${phasePassport}.lock`)).rejects.toThrow();
      expect((await readdir(scratch)).filter((entry) => entry.startsWith(`${basename(phasePassport)}.tmp-`))).toEqual([]);
    },
  );

  it.each<PassportCommitPhase>(["journal_written", "audit_appended", "passport_written"])(
    "repairs passport creation after process death at %s",
    async (crashPhase) => {
      const createdPassport = join(scratch, `created-${crashPhase}.json`);
      const createdAudit = `${createdPassport}.audit.jsonl`;
      expect(await runCrashChild(createdPassport, crashPhase, "create")).toBe(91);

      const repaired = await repairPendingCommit({ passportPath: createdPassport });
      expect(["completed", "already_completed"]).toContain(repaired.status);
      const passport = await readPassport(createdPassport);
      const log = await readAuditLog(createdAudit);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ before_hash: "absent", after_hash: hashPassport(passport) });
      expect(await readCommitJournal(defaultCommitJournalPath(createdPassport))).toBeNull();
      await expect(access(`${createdPassport}.lock`)).rejects.toThrow();
    },
  );

  it("uses one canonical lock and journal through a symlink alias", async () => {
    const aliasPath = join(scratch, "passport-alias.json");
    await symlink(passportPath, aliasPath);
    const direct = await Identity.fromPassport(passportPath);
    const aliased = await Identity.fromPassport(aliasPath);

    const results = await Promise.allSettled([
      direct.updateMutableFields(
        { name: "Direct writer" },
        { write: true, commandId: "direct-writer" },
      ),
      aliased.updateMutableFields(
        { name: "Aliased writer" },
        { write: true, commandId: "aliased-writer" },
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(IdentityVersionConflictError) });
    expect(await readAuditLog(auditPath)).toHaveLength(1);
    await expect(access(`${aliasPath}.audit.jsonl`)).rejects.toThrow();
    await expect(access(`${aliasPath}.lock`)).rejects.toThrow();
  });

  it("fails closed on a malformed audit log without rewriting the passport", async () => {
    const beforeBytes = await readFile(passportPath, "utf8");
    await writeFile(auditPath, "{not-json}\n", "utf8");
    const identity = await Identity.fromPassport(passportPath);

    await expect(
      identity.updateMutableFields(
        { purpose: "Must not land" },
        { write: true, commandId: "corrupt-audit-command" },
      ),
    ).rejects.toThrow("Failed to parse passport audit entry 1");

    expect(await readFile(passportPath, "utf8")).toBe(beforeBytes);
    await expect(access(journalPath)).rejects.toThrow();
    await expect(access(`${passportPath}.lock`)).rejects.toThrow();
  });
});

async function runCrashChild(
  passport: string,
  phase: PassportCommitPhase,
  mode?: "create",
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const args = ["--import", "tsx", crashChildPath, passport, phase];
    if (mode) args.push(mode);
    const child = spawn(process.execPath, args, {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}
