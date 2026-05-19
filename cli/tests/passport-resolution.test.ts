import { describe, expect, it } from "vitest";
import { resolvePassportFrom, type ActivePassportState } from "../src/active-passport.js";
import { formatPassportLocation, formatPassportSourceTag } from "../src/continuity.js";

const ACTIVE: ActivePassportState = {
  schema_version: "1.0",
  agent_id: "claude",
  passport_path: "/home/mc/.seedrop/id/agents/claude.json",
  set_at: "2026-05-19T16:00:00.000Z",
};

describe("resolvePassportFrom — three-tier precedence (cdb810a7)", () => {
  it("picks active when active is set, regardless of env or operator", () => {
    const r = resolvePassportFrom({
      active: ACTIVE,
      env: "/whatever/env.json",
      operator: "/home/mc/.seedrop/id/passport.json",
    });
    expect(r.path).toBe(ACTIVE.passport_path);
    expect(r.source).toBe("active");
    expect(r.agent_id).toBe("claude");
  });

  it("falls back to env when active is null", () => {
    const r = resolvePassportFrom({
      active: null,
      env: "/from/env.json",
      operator: "/home/mc/.seedrop/id/passport.json",
    });
    expect(r.path).toBe("/from/env.json");
    expect(r.source).toBe("env");
    expect(r.agent_id).toBeUndefined();
  });

  it("trims whitespace on env input", () => {
    const r = resolvePassportFrom({
      active: null,
      env: "  /trimmed.json  ",
      operator: "/op.json",
    });
    expect(r.path).toBe("/trimmed.json");
    expect(r.source).toBe("env");
  });

  it("treats empty / whitespace-only env as unset", () => {
    const r1 = resolvePassportFrom({ active: null, env: "", operator: "/op.json" });
    expect(r1.source).toBe("operator");
    const r2 = resolvePassportFrom({ active: null, env: "   ", operator: "/op.json" });
    expect(r2.source).toBe("operator");
  });

  it("falls back to operator when neither active nor env is set", () => {
    const r = resolvePassportFrom({ active: null, env: undefined, operator: "/op.json" });
    expect(r.path).toBe("/op.json");
    expect(r.source).toBe("operator");
  });
});

describe("formatPassportSourceTag — labels rendered in continuity Identity", () => {
  it("active is labeled as a deliberate login", () => {
    expect(formatPassportSourceTag("active")).toContain("active passport");
    expect(formatPassportSourceTag("active")).toContain("seed login");
  });

  it("env is labeled as the install-time env", () => {
    expect(formatPassportSourceTag("env")).toContain("SEEDROP_PASSPORT");
  });

  it("operator is labeled as the default", () => {
    expect(formatPassportSourceTag("operator")).toContain("operator default");
  });

  it("undefined source yields no tag (preserves existing renders without source)", () => {
    expect(formatPassportSourceTag(undefined)).toBe("");
  });
});

describe("formatPassportLocation — homedir compaction", () => {
  it("replaces homedir prefix with ~", () => {
    const home = process.env.HOME;
    if (!home) {
      // CI may not set HOME; just skip without failing the suite.
      return;
    }
    const path = `${home}/.seedrop/id/passport.json`;
    expect(formatPassportLocation(path)).toBe("~/.seedrop/id/passport.json");
  });

  it("leaves paths outside homedir untouched", () => {
    expect(formatPassportLocation("/tmp/whatever.json")).toBe("/tmp/whatever.json");
  });
});
