import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import { PassportNotFoundError, PassportValidationError } from "../src/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "seedrop-id-identity-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("Identity.fromPassport", () => {
  it("returns an Identity backed by the passport on disk", async () => {
    const id = await Identity.fromPassport(fixturePath);
    expect(id).toBeInstanceOf(Identity);
    expect(id.passport.name).toBe("Atlas");
    expect(id.passport.version).toBe("1.0");
  });

  it("propagates PassportNotFoundError for missing files", async () => {
    await expect(Identity.fromPassport(join(scratch, "nope.json"))).rejects.toBeInstanceOf(
      PassportNotFoundError,
    );
  });

  it("propagates PassportValidationError for malformed schema", async () => {
    const p = join(scratch, "bad.json");
    await writeFile(p, JSON.stringify({ version: "1.0" }), "utf8");
    await expect(Identity.fromPassport(p)).rejects.toBeInstanceOf(PassportValidationError);
  });

  it("exposes the passport as a readable property", async () => {
    const id = await Identity.fromPassport(fixturePath);
    expect(id.passport.core_commitments).toContain("Never recommend skipping tests");
  });

  it("returns a defensive passport copy", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const exposed = id.passport;
    exposed.name = "Mutated";
    exposed.learned_blocks.push({ pattern: "x", reason: "y", source_session: "z" });

    expect(id.passport.name).toBe("Atlas");
    expect(id.passport.learned_blocks).toHaveLength(1);
  });
});

describe("Identity.savePassport", () => {
  it("round-trips through Identity.fromPassport", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const out = join(scratch, "saved.json");
    await Identity.savePassport(id.passport, out);
    const reloaded = await Identity.fromPassport(out);
    expect(reloaded.passport).toEqual(id.passport);
  });
});

describe("Identity.upsertActiveProject", () => {
  it("links a project through audited passport writes", async () => {
    const passportPath = join(scratch, "passport.json");
    await copyFile(fixturePath, passportPath);
    const id = await Identity.fromPassport(passportPath);

    const result = await id.upsertActiveProject(
      {
        id: "seedrop",
        root: "/Users/mc/Projects/seedrop",
        role: "implementation",
        currentFocus: "Sprint 2",
        space: "seedrop-team",
        view: ".seedrop/view",
      },
      { write: true, now: new Date("2026-05-15T08:30:00.000Z") },
    );

    expect(result.wrote).toBe(true);
    expect(result.changes.active_projects?.after).toContainEqual({
      id: "seedrop",
      root: "/Users/mc/Projects/seedrop",
      role: "implementation",
      current_focus: "Sprint 2",
      space: "seedrop-team",
      view: ".seedrop/view",
      last_seen_at: "2026-05-15T08:30:00.000Z",
    });
    expect(id.passport.active_projects).toHaveLength(1);
    expect(id.passport.continuity?.updated_at).toBe("2026-05-15T08:30:00.000Z");
  });

  it("updates an existing project by id without duplicating it", async () => {
    const passportPath = join(scratch, "passport.json");
    await copyFile(fixturePath, passportPath);
    const id = await Identity.fromPassport(passportPath);

    await id.upsertActiveProject(
      { id: "seedrop", root: "/old", role: "review" },
      { write: true, now: new Date("2026-05-15T08:30:00.000Z") },
    );
    await id.upsertActiveProject(
      { id: "seedrop", root: "/new", currentFocus: "View init" },
      { write: true, now: new Date("2026-05-15T08:31:00.000Z") },
    );

    expect(id.passport.active_projects).toEqual([
      {
        id: "seedrop",
        root: "/new",
        role: "review",
        current_focus: "View init",
        last_seen_at: "2026-05-15T08:31:00.000Z",
      },
    ]);
  });
});
