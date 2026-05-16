import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import { hashPassport, readAuditLog, reversePassportChange } from "../src/audit.js";
import type { LearnedBlock, Passport } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

let scratch: string;
let passportPath: string;
let auditPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "seedrop-id-slice7-"));
  passportPath = join(scratch, "passport.json");
  auditPath = passportPath + ".audit.jsonl";
  await copyFile(fixturePath, passportPath);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("Slice 7 ship-criterion (PRD §9.7)", () => {
  it("every passport write produces an audit entry — no silent mutations", async () => {
    const id = await Identity.fromPassport(passportPath);
    const originalBytes = await readFile(passportPath, "utf8");
    const original = JSON.parse(await readFile(passportPath, "utf8")) as Passport;
    const originalHash = hashPassport(id.passport);

    // dry-run: passport file untouched, no audit entry
    await id.commitSession({});
    expect(await readFile(passportPath, "utf8")).toBe(originalBytes);
    expect(await readAuditLog(auditPath)).toEqual([]);

    // write: passport file changes, audit entry appended
    await id.commitSession({ write: true, now: new Date("2026-05-14T01:00:00.000Z") });
    const afterFirst = JSON.parse(await readFile(passportPath, "utf8")) as Passport;
    expect(hashPassport(afterFirst)).not.toBe(originalHash);
    const log1 = await readAuditLog(auditPath);
    expect(log1).toHaveLength(1);
    expect(log1[0]!.before_hash).toBe(originalHash);
    expect(log1[0]!.after_hash).toBe(hashPassport(afterFirst));

    // second write: chain grows
    await id.commitSession({
      write: true,
      now: new Date("2026-05-14T02:00:00.000Z"),
      newLearnedBlocks: [{ pattern: "found-x", reason: "r", source_session: "s2" }],
    });
    const afterSecond = JSON.parse(await readFile(passportPath, "utf8")) as Passport;
    const log2 = await readAuditLog(auditPath);
    expect(log2).toHaveLength(2);
    expect(log2[1]!.prev_hash).toBe(log2[0]!.after_hash);
    expect(log2[1]!.before_hash).toBe(hashPassport(afterFirst));
    expect(log2[1]!.after_hash).toBe(hashPassport(afterSecond));
    expect(log2[1]!.changes.learned_blocks_added).toEqual([
      { pattern: "found-x", reason: "r", source_session: "s2" },
    ]);
  });

  it("passport changes are reversible via the audit log", async () => {
    const id = await Identity.fromPassport(passportPath);
    const original = id.passport;
    const originalHash = hashPassport(original);

    // Apply three commits, each different.
    await id.commitSession({ write: true, now: new Date("2026-05-14T01:00:00.000Z") });
    await id.commitSession({
      write: true,
      now: new Date("2026-05-14T02:00:00.000Z"),
      newLearnedBlocks: [
        { pattern: "a", reason: "ra", source_session: "s" },
        { pattern: "b", reason: "rb", source_session: "s" },
      ],
    });
    await id.commitSession({
      write: true,
      now: new Date("2026-05-14T03:00:00.000Z"),
      newLearnedBlocks: [{ pattern: "c", reason: "rc", source_session: "s" }],
    });

    const final = JSON.parse(await readFile(passportPath, "utf8")) as Passport;
    expect(final.metadata.session_count).toBe(original.metadata.session_count + 3);
    expect(final.learned_blocks).toHaveLength(original.learned_blocks.length + 3);

    // Replay the audit log in reverse — should recover the original passport exactly.
    const log = await readAuditLog(auditPath);
    let p = final;
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i]!;
      expect(hashPassport(p)).toBe(entry.after_hash);
      p = reversePassportChange(p, entry);
      expect(hashPassport(p)).toBe(entry.before_hash);
    }
    expect(hashPassport(p)).toBe(originalHash);
    expect(p).toEqual(original);
  });

  it("audit chain detects tampering — any mismatch breaks the hash chain", async () => {
    const id = await Identity.fromPassport(passportPath);
    await id.commitSession({ write: true, now: new Date("2026-05-14T01:00:00.000Z") });
    await id.commitSession({ write: true, now: new Date("2026-05-14T02:00:00.000Z") });

    const log = await readAuditLog(auditPath);
    expect(log).toHaveLength(2);
    // Chain is intact:
    expect(log[1]!.prev_hash).toBe(log[0]!.after_hash);

    // If someone tampered with the passport file (or any prior entry's after_hash),
    // the chain prev_hash would no longer match the recomputed file hash.
    const onDisk = JSON.parse(await readFile(passportPath, "utf8")) as Passport;
    expect(hashPassport(onDisk)).toBe(log[1]!.after_hash);

    const tamperedDisk: Passport = { ...onDisk, name: onDisk.name + "X" };
    expect(hashPassport(tamperedDisk)).not.toBe(log[1]!.after_hash);
  });

  it("dedupes learned_blocks across multiple commits (idempotent on pattern)", async () => {
    const id = await Identity.fromPassport(passportPath);
    const block: LearnedBlock = { pattern: "novel-pattern", reason: "r", source_session: "s" };
    const r1 = await id.commitSession({ write: true, newLearnedBlocks: [block] });
    expect(r1.changes.learned_blocks_added).toEqual([block]);

    const r2 = await id.commitSession({ write: true, newLearnedBlocks: [block] });
    expect(r2.changes.learned_blocks_added).toBeUndefined();
    const final = JSON.parse(await readFile(passportPath, "utf8")) as Passport;
    expect(final.learned_blocks.filter((b) => b.pattern === "novel-pattern")).toHaveLength(1);
  });
});
