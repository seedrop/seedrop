import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PassportSchema, type Passport } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");
const selfStateExamplePath = join(__dirname, "..", "examples", "passport.self-state.json");

async function loadValid(): Promise<Passport> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as Passport;
}

describe("PassportSchema", () => {
  it("accepts a valid passport fixture", async () => {
    const valid = await loadValid();
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts the self-state example passport", async () => {
    const raw = await readFile(selfStateExamplePath, "utf8");
    const result = PassportSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it("accepts old passports without operational self-state fields", async () => {
    const valid = await loadValid();
    const result = PassportSchema.parse(valid);
    expect(result.active_projects).toBeUndefined();
    expect(result.credential_refs).toBeUndefined();
    expect(result.continuity).toBeUndefined();
  });

  it("accepts passport without last_session_at (optional field)", async () => {
    const valid = await loadValid();
    delete (valid.metadata as { last_session_at?: string }).last_session_at;
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects unknown version", async () => {
    const valid = await loadValid();
    (valid as { version: string }).version = "2.0";
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("version"))).toBe(true);
    }
  });

  it("rejects empty name", async () => {
    const valid = await loadValid();
    valid.name = "";
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects empty purpose", async () => {
    const valid = await loadValid();
    valid.purpose = "";
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects missing required top-level field", async () => {
    const valid = await loadValid();
    delete (valid as Partial<Passport>).purpose;
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects extra unknown top-level field (strict mode)", async () => {
    const valid = await loadValid();
    (valid as Record<string, unknown>)["surprise"] = "boo";
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate value_anchor priorities", async () => {
    const valid = await loadValid();
    valid.value_anchors = [
      { name: "a", priority: 1 },
      { name: "b", priority: 1 },
    ];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("priorities must be unique"))).toBe(true);
    }
  });

  it("rejects duplicate value_anchor names", async () => {
    const valid = await loadValid();
    valid.value_anchors = [
      { name: "correctness", priority: 1 },
      { name: "correctness", priority: 2 },
    ];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("names must be unique"))).toBe(true);
    }
  });

  it("rejects non-positive value_anchor priority", async () => {
    const valid = await loadValid();
    valid.value_anchors = [{ name: "a", priority: 0 }];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects negative session_count", async () => {
    const valid = await loadValid();
    valid.metadata.session_count = -1;
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects non-integer session_count", async () => {
    const valid = await loadValid();
    valid.metadata.session_count = 1.5;
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects malformed created_at", async () => {
    const valid = await loadValid();
    valid.metadata.created_at = "not-a-date";
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("accepts empty arrays for collection fields", async () => {
    const valid = await loadValid();
    valid.core_commitments = [];
    valid.value_anchors = [];
    valid.competencies = [];
    valid.limits = [];
    valid.learned_blocks = [];
    valid.active_projects = [];
    valid.credential_refs = [];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects empty string inside core_commitments", async () => {
    const valid = await loadValid();
    valid.core_commitments = ["valid", ""];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("rejects malformed learned_block (missing field)", async () => {
    const valid = await loadValid();
    valid.learned_blocks = [{ pattern: "x", reason: "y" } as never];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("accepts active projects, credential references, and continuity state", async () => {
    const valid = await loadValid();
    valid.active_projects = [
      {
        id: "seedrop-space",
        root: "/Users/mc/Projects/seedrop/space",
        role: "implementation and review",
        current_focus: "Slice 4 notifications",
        space: "seedrop-team",
        view: ".seedrop/view",
        last_seen_at: "2026-05-14T15:00:00.000Z",
      },
    ];
    valid.credential_refs = [
      {
        name: "github",
        kind: "env",
        ref: "env:GITHUB_TOKEN",
        scope: "repo",
        expires_at: null,
      },
    ];
    valid.continuity = {
      current_focus: "Review Seedrop id",
      handoff: "Continue from schema realignment.",
      next_actions: ["Write architecture note"],
      open_threads: ["Keep embeddings optional"],
      updated_at: "2026-05-14T15:00:00.000Z",
    };

    expect(PassportSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects duplicate active project ids", async () => {
    const valid = await loadValid();
    valid.active_projects = [
      { id: "same", root: "/a" },
      { id: "same", root: "/b" },
    ];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("active_projects ids must be unique"))).toBe(true);
    }
  });

  it("rejects duplicate credential names", async () => {
    const valid = await loadValid();
    valid.credential_refs = [
      { name: "github", kind: "env", ref: "env:GITHUB_TOKEN" },
      { name: "github", kind: "env", ref: "env:OTHER_TOKEN" },
    ];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("credential_refs names must be unique"))).toBe(true);
    }
  });

  it("rejects env credential refs that do not use env: references", async () => {
    const valid = await loadValid();
    valid.credential_refs = [{ name: "github", kind: "env", ref: "GITHUB_TOKEN" }];
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("env credential refs must start with env:"))).toBe(true);
    }
  });

  it("rejects malformed continuity timestamps", async () => {
    const valid = await loadValid();
    valid.continuity = { updated_at: "recently" };
    const result = PassportSchema.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it("accepts passport with issued_by and autonomous fields", async () => {
    const valid = await loadValid();
    const updated = { ...valid, issued_by: "mc", autonomous: false };
    const result = PassportSchema.safeParse(updated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issued_by).toBe("mc");
      expect(result.data.autonomous).toBe(false);
    }
  });

  it("accepts passport with autonomous=true and no issued_by", async () => {
    const valid = await loadValid();
    const updated = { ...valid, autonomous: true };
    const result = PassportSchema.safeParse(updated);
    expect(result.success).toBe(true);
  });

  it("rejects passport where issued_by equals agent_id (self-issue)", async () => {
    const valid = await loadValid();
    const updated = { ...valid, issued_by: valid.agent_id };
    const result = PassportSchema.safeParse(updated);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("issued_by"))).toBe(true);
    }
  });

  it("rejects empty issued_by", async () => {
    const valid = await loadValid();
    const updated = { ...valid, issued_by: "" };
    const result = PassportSchema.safeParse(updated);
    expect(result.success).toBe(false);
  });
});
