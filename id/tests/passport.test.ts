import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPassport, writePassport } from "../src/passport.js";
import {
  PassportNotFoundError,
  PassportParseError,
  PassportValidationError,
} from "../src/errors.js";
import type { Passport } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

async function loadFixture(): Promise<Passport> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as Passport;
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "seedrop-id-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("readPassport", () => {
  it("loads and validates the canonical fixture", async () => {
    const passport = await readPassport(fixturePath);
    expect(passport.name).toBe("Atlas");
    expect(passport.version).toBe("1.0");
    expect(passport.core_commitments.length).toBeGreaterThan(0);
  });

  it("throws PassportNotFoundError when the file is missing", async () => {
    await expect(readPassport(join(scratch, "nope.json"))).rejects.toBeInstanceOf(
      PassportNotFoundError,
    );
  });

  it("throws PassportParseError on malformed JSON", async () => {
    const p = join(scratch, "bad.json");
    await writeFile(p, "{ not json", "utf8");
    await expect(readPassport(p)).rejects.toBeInstanceOf(PassportParseError);
  });

  it("re-throws non-ENOENT filesystem errors unchanged (e.g. EISDIR)", async () => {
    // Reading a directory as a file yields EISDIR — not ENOENT, so it should
    // pass through rather than become a PassportNotFoundError.
    await expect(readPassport(scratch)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("throws PassportValidationError on schema mismatch with all issues exposed", async () => {
    const p = join(scratch, "invalid.json");
    await writeFile(p, JSON.stringify({ version: "1.0" }), "utf8");
    try {
      await readPassport(p);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PassportValidationError);
      const e = err as PassportValidationError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.path).toBe(p);
      expect(e.message).toMatch(/Passport failed validation/);
    }
  });

  it("error message includes the offending path in summary", async () => {
    const p = join(scratch, "bad.json");
    await writeFile(p, JSON.stringify({ version: "1.0" }), "utf8");
    try {
      await readPassport(p);
    } catch (err) {
      expect((err as Error).message).toContain(p);
    }
  });
});

describe("writePassport", () => {
  it("writes a valid passport and round-trips losslessly", async () => {
    const original = await loadFixture();
    const out = join(scratch, "out.json");
    await writePassport(original, out);
    const loaded = await readPassport(out);
    expect(loaded).toEqual(original);
  });

  it("emits stable JSON formatting (trailing newline, 2-space indent)", async () => {
    const original = await loadFixture();
    const out = join(scratch, "out.json");
    await writePassport(original, out);
    const raw = await readFile(out, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "version"');
  });

  it("rejects writing an invalid passport object", async () => {
    const original = await loadFixture();
    const broken = { ...original, version: "9.9" } as unknown as Passport;
    const out = join(scratch, "out.json");
    await expect(writePassport(broken, out)).rejects.toBeInstanceOf(PassportValidationError);
  });
});
