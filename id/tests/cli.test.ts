import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry, hashPassport, readAuditLog, type AuditEntry } from "../src/audit.js";
import {
  createCommitJournalRecord,
  defaultCommitJournalPath,
  readCommitJournal,
  writeCommitJournal,
} from "../src/commit-journal.js";
import { runCli } from "../src/cli.js";
import { readPassport, writePassport } from "../src/passport.js";
import type { Passport } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

let scratch: string;
let passportPath: string;
let auditPath: string;
let journalPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "seedrop-id-cli-"));
  passportPath = join(scratch, "passport.json");
  auditPath = `${passportPath}.audit.jsonl`;
  journalPath = defaultCommitJournalPath(passportPath);
  await copyFile(fixturePath, passportPath);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("seed-id cli", () => {
  it("prints help", async () => {
    const io = createIo();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("seed-id init");
  });

  it("creates a minimal passport", async () => {
    const outPath = join(scratch, ".seedrop", "id", "passport.json");
    const io = createIo();

    const code = await runCli(
      ["init", "--name", "Codex Agent", "--purpose", "Help build Seedrop", "--out", outPath, "--json"],
      io,
    );
    const payload = JSON.parse(io.stdoutText()) as { passportPath: string; passport: Passport };

    expect(code).toBe(0);
    expect(payload.passportPath).toBe(outPath);
    expect(payload.passport.agent_id).toBe("codex-agent");
    expect(await readPassport(outPath)).toMatchObject({
      version: "1.0",
      name: "Codex Agent",
      purpose: "Help build Seedrop",
      core_commitments: [],
      active_projects: [],
      credential_refs: [],
      continuity: { next_actions: [], open_threads: [] },
      metadata: { session_count: 0 },
    });
  });

  it("records --issued-by and --autonomous on init", async () => {
    const outPath = join(scratch, "agent-claude.json");
    const io = createIo();
    const code = await runCli(
      [
        "init",
        "--name",
        "claude",
        "--purpose",
        "code",
        "--out",
        outPath,
        "--issued-by",
        "mc",
      ],
      io,
    );
    expect(code).toBe(0);
    const passport = await readPassport(outPath);
    expect(passport.issued_by).toBe("mc");
    expect(passport.autonomous).toBeUndefined();

    const outAutoPath = join(scratch, "agent-bot.json");
    const io2 = createIo();
    const code2 = await runCli(
      ["init", "--name", "ci-bot", "--purpose", "ci", "--out", outAutoPath, "--autonomous"],
      io2,
    );
    expect(code2).toBe(0);
    const autoPassport = await readPassport(outAutoPath);
    expect(autoPassport.autonomous).toBe(true);
    expect(autoPassport.issued_by).toBeUndefined();
  });

  it("rejects --issued-by equal to agent_id", async () => {
    const outPath = join(scratch, "self-issued.json");
    const io = createIo();
    const code = await runCli(
      [
        "init",
        "--name",
        "claude",
        "--purpose",
        "code",
        "--out",
        outPath,
        "--issued-by",
        "claude",
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("must differ from agent_id");
  });

  it("refuses to overwrite a passport unless forced", async () => {
    const original = await readFile(passportPath, "utf8");
    const io = createIo();

    const code = await runCli(
      ["init", "--name", "Codex", "--purpose", "Overwrite test", "--out", passportPath],
      io,
    );

    expect(code).toBe(1);
    expect(io.stderrText()).toContain("passport already exists");
    expect(await readFile(passportPath, "utf8")).toBe(original);

    const forceIo = createIo();
    const forceCode = await runCli(
      ["init", "--name", "Codex", "--purpose", "Overwrite test", "--out", passportPath, "--force"],
      forceIo,
    );

    expect(forceCode).toBe(0);
    expect((await readPassport(passportPath)).name).toBe("Codex");
  });

  it("validates a passport", async () => {
    const io = createIo();
    const code = await runCli(["validate", "--passport", passportPath, "--json"], io);
    const payload = JSON.parse(io.stdoutText()) as { ok: boolean; agentId: string; hash: string };

    expect(code).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.agentId).toBeTruthy();
    expect(payload.hash).toHaveLength(64);
  });

  it("shows a passport summary and JSON", async () => {
    const summaryIo = createIo();
    const summaryCode = await runCli(["show", "--passport", passportPath], summaryIo);

    expect(summaryCode).toBe(0);
    expect(summaryIo.stdoutText()).toContain("name:");
    expect(summaryIo.stdoutText()).toContain("purpose:");

    const jsonIo = createIo();
    const jsonCode = await runCli(["show", "--passport", passportPath, "--json"], jsonIo);
    const passport = JSON.parse(jsonIo.stdoutText()) as Passport;

    expect(jsonCode).toBe(0);
    expect(passport.agent_id).toBe((await readPassport(passportPath)).agent_id);
  });

  it("prints audit log status", async () => {
    const { entry } = await createPendingCommit();
    await appendAuditEntry(auditPath, entry);
    const io = createIo();

    const code = await runCli(["audit", "--passport", passportPath], io);

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("entries: 1");
    expect(io.stdoutText()).toContain(entry.timestamp);
  });

  it("links an active project from the shell command", async () => {
    const io = createIo();

    const code = await runCli(
      [
        "project",
        "link",
        "--passport",
        passportPath,
        "--id",
        "demo",
        "--root",
        scratch,
        "--role",
        "implementation",
        "--current-focus",
        "View init",
        "--view",
        ".seedrop/view",
        "--json",
      ],
      io,
    );
    const payload = JSON.parse(io.stdoutText()) as { project?: NonNullable<Passport["active_projects"]>[number] };
    const passport = await readPassport(passportPath);

    expect(code).toBe(0);
    expect(payload.project).toMatchObject({ id: "demo", root: scratch, current_focus: "View init" });
    expect(passport.active_projects).toHaveLength(1);
    expect(passport.active_projects?.[0]).toMatchObject({
      id: "demo",
      root: scratch,
      role: "implementation",
      view: ".seedrop/view",
    });
    expect(await readAuditLog(auditPath)).toHaveLength(1);
  });

  it("defaults to SEEDROP_PASSPORT env when --passport is omitted", async () => {
    const io = createIo();
    const prior = process.env.SEEDROP_PASSPORT;
    process.env.SEEDROP_PASSPORT = passportPath;
    try {
      const code = await runCli(["repair"], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).toContain("no pending commit journal");
    } finally {
      if (prior === undefined) delete process.env.SEEDROP_PASSPORT;
      else process.env.SEEDROP_PASSPORT = prior;
    }
  });

  it("reports status when no journal exists", async () => {
    const io = createIo();
    const code = await runCli(["status", "--passport", passportPath], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("no pending commit journal");
  });

  it("reports pending status as JSON", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    const io = createIo();

    const code = await runCli(["status", "--passport", passportPath, "--json"], io);
    const payload = JSON.parse(io.stdoutText()) as { pending: boolean; transactionId?: string };

    expect(code).toBe(0);
    expect(payload.pending).toBe(true);
    expect(payload.transactionId).toBeTruthy();
  });

  it("repairs a pending commit from the shell command", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    const io = createIo();

    const code = await runCli(["repair", "--passport", passportPath], io);

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("repaired pending commit");
    expect(hashPassport(await readPassport(passportPath))).toBe(hashPassport(after));
    expect(await readAuditLog(auditPath)).toEqual([entry]);
    expect(await readCommitJournal(journalPath)).toBeNull();
  });

  it("returns exit code 2 for repair conflicts", async () => {
    const { after, entry } = await createPendingCommit();
    await writeCommitJournal(journalPath, await createRecord(after, entry));
    await writePassport({ ...(await readPassport(passportPath)), name: "Conflict" }, passportPath);
    const io = createIo();

    const code = await runCli(["repair", "--passport", passportPath], io);

    expect(code).toBe(2);
    expect(io.stderrText()).toContain("pending commit conflict");
    expect(await readCommitJournal(journalPath)).not.toBeNull();
  });
});

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

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
