import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJSON,
  hashPassport,
  appendAuditEntry,
  readAuditLog,
  reversePassportChange,
  type AuditEntry,
} from "../src/audit.js";
import { readPassport } from "../src/passport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "seedrop-id-audit-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("canonicalJSON", () => {
  it("serializes primitives", () => {
    expect(canonicalJSON("a")).toBe('"a"');
    expect(canonicalJSON(1)).toBe("1");
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON(null)).toBe("null");
    expect(canonicalJSON(undefined)).toBe("null");
  });

  it("produces identical output regardless of key order", () => {
    const a = canonicalJSON({ b: 1, a: 2, c: 3 });
    const b = canonicalJSON({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("preserves array order", () => {
    expect(canonicalJSON([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles nested structures", () => {
    const v = { z: [{ b: 2, a: 1 }], a: { y: 1, x: 2 } };
    expect(canonicalJSON(v)).toBe('{"a":{"x":2,"y":1},"z":[{"a":1,"b":2}]}');
  });

  it("drops undefined properties", () => {
    expect(canonicalJSON({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJSON(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJSON(Infinity)).toThrow(TypeError);
  });

  it("rejects unsupported types", () => {
    expect(() => canonicalJSON(() => 1)).toThrow(TypeError);
    expect(() => canonicalJSON(Symbol("x"))).toThrow(TypeError);
  });
});

describe("hashPassport", () => {
  it("is deterministic across reads", async () => {
    const p = await readPassport(fixturePath);
    expect(hashPassport(p)).toBe(hashPassport(p));
  });

  it("is identical for passports with shuffled top-level key order", async () => {
    const p = await readPassport(fixturePath);
    const shuffled = {
      metadata: p.metadata,
      version: p.version,
      learned_blocks: p.learned_blocks,
      limits: p.limits,
      competencies: p.competencies,
      value_anchors: p.value_anchors,
      core_commitments: p.core_commitments,
      purpose: p.purpose,
      name: p.name,
      agent_id: p.agent_id,
    } as typeof p;
    expect(hashPassport(shuffled)).toBe(hashPassport(p));
  });

  it("changes when any field changes", async () => {
    const p = await readPassport(fixturePath);
    const mutated = { ...p, name: p.name + "!" };
    expect(hashPassport(mutated)).not.toBe(hashPassport(p));
  });
});

describe("audit log I/O", () => {
  it("returns [] for a missing file", async () => {
    expect(await readAuditLog(join(scratch, "missing.jsonl"))).toEqual([]);
  });

  it("appends entries as JSONL and reads them back in order", async () => {
    const p = join(scratch, "a.jsonl");
    const e1: AuditEntry = {
      timestamp: "2026-05-14T00:00:00.000Z",
      before_hash: "a".repeat(64),
      after_hash: "b".repeat(64),
      prev_hash: null,
      changes: { session_count: { before: 1, after: 2 } },
    };
    const e2: AuditEntry = { ...e1, prev_hash: e1.after_hash, after_hash: "c".repeat(64) };
    await appendAuditEntry(p, e1);
    await appendAuditEntry(p, e2);
    const raw = await readFile(p, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    const log = await readAuditLog(p);
    expect(log).toEqual([e1, e2]);
  });

  it("propagates non-ENOENT errors from readAuditLog", async () => {
    await expect(readAuditLog(scratch)).rejects.toThrow();
  });
});

describe("reversePassportChange", () => {
  it("reverses session_count and last_session_at", async () => {
    const p = await readPassport(fixturePath);
    const after = {
      ...p,
      metadata: { ...p.metadata, session_count: p.metadata.session_count + 1, last_session_at: "2026-05-14T12:00:00.000Z" },
    };
    const entry: AuditEntry = {
      timestamp: "2026-05-14T12:00:00.000Z",
      before_hash: hashPassport(p),
      after_hash: hashPassport(after),
      prev_hash: null,
      changes: {
        session_count: { before: p.metadata.session_count, after: after.metadata.session_count },
        last_session_at: { before: p.metadata.last_session_at, after: "2026-05-14T12:00:00.000Z" },
      },
    };
    expect(reversePassportChange(after, entry)).toEqual(p);
  });

  it("removes appended learned_blocks", async () => {
    const p = await readPassport(fixturePath);
    const newBlock = { pattern: "new-x", reason: "r", source_session: "s" };
    const after = { ...p, learned_blocks: [...p.learned_blocks, newBlock] };
    const entry: AuditEntry = {
      timestamp: "2026-05-14T12:00:00.000Z",
      before_hash: hashPassport(p),
      after_hash: hashPassport(after),
      prev_hash: null,
      changes: { learned_blocks_added: [newBlock] },
    };
    expect(reversePassportChange(after, entry).learned_blocks).toEqual(p.learned_blocks);
  });

  it("restores undefined last_session_at when before was undefined", async () => {
    const p = await readPassport(fixturePath);
    const fresh = { ...p, metadata: { ...p.metadata, last_session_at: undefined as string | undefined } };
    delete (fresh.metadata as { last_session_at?: string }).last_session_at;
    const after = { ...fresh, metadata: { ...fresh.metadata, last_session_at: "2026-05-14T12:00:00.000Z" } };
    const entry: AuditEntry = {
      timestamp: "2026-05-14T12:00:00.000Z",
      before_hash: hashPassport(fresh),
      after_hash: hashPassport(after),
      prev_hash: null,
      changes: {
        last_session_at: { before: undefined, after: "2026-05-14T12:00:00.000Z" },
      },
    };
    const reversed = reversePassportChange(after, entry);
    expect(reversed.metadata.last_session_at).toBeUndefined();
  });
});
