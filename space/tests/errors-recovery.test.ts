import { describe, expect, it } from "vitest";
import {
  renderRecovery,
  TaskBlockedError,
  TaskConflictError,
  TaskNotFoundError,
  WorkspaceRunClaimConflictError,
  WorkspaceRunDirtyTreeError,
  WorkspaceRunTaskConflictError,
  WorkspaceRunUnloggedChangesError,
  WorkspaceViewError,
  WorkspaceViewParseError,
  WorkspaceViewValidationError,
} from "../src/errors.js";
import { describeNativeLoadFailure } from "../src/live.js";

describe("structured recovery on every WorkspaceViewError subclass", () => {
  it("WorkspaceRunDirtyTreeError suggests commit / blocked / force", () => {
    const err = new WorkspaceRunDirtyTreeError(["src/foo.ts"], ["src/foo.ts", "src/bar.ts"]);
    const commands = err.recovery.map((r) => r.command);
    expect(commands.some((c) => c?.startsWith("git add"))).toBe(true);
    expect(commands).toContain("seed run finish --status blocked");
    expect(commands).toContain("seed run finish --status completed --force");
    expect(err.recovery.find((r) => r.command?.includes("force"))?.risk).toBe("medium");
  });

  it("WorkspaceRunUnloggedChangesError suggests inspect / log / blocked / force for validation-only runs", () => {
    const err = new WorkspaceRunUnloggedChangesError(["README.md"]);
    const commands = err.recovery.map((r) => r.command);
    expect(err.message).toContain("validation-only runs");
    expect(err.message).toContain("pre-existing dirty tree");
    expect(commands).toContain("git status --short");
    expect(commands.some((c) => c?.includes("seed run log"))).toBe(true);
    expect(commands).toContain("seed run finish --status blocked");
    expect(commands).toContain("seed run finish --status completed --force");
    expect(err.recovery.find((r) => r.command?.includes("seed run log"))?.reason).toContain("only files this run actually changed");
    expect(err.recovery.find((r) => r.command?.includes("force"))?.reason).toContain("pre-existed");
  });

  it("TaskConflictError with owner != actor suggests seed login + reassign", () => {
    const err = new TaskConflictError("Task X is owned by kimi; only the owner can complete.", {
      taskId: "abc123",
      owner: "kimi",
      status: "in_progress",
      actor: "claude",
    });
    const commands = err.recovery.map((r) => r.command);
    expect(commands).toContain("seed login kimi");
    expect(commands.some((c) => c?.startsWith("seed task assign"))).toBe(true);
  });

  it("TaskConflictError with done/dropped status suggests listing open tasks instead", () => {
    const err = new TaskConflictError("Task cannot be assigned.", {
      taskId: "abc",
      status: "done",
      actor: "claude",
    });
    expect(err.recovery[0]?.command).toBe("seed task list --status open");
  });

  it("WorkspaceRunTaskConflictError suggests login + assign + force in that order", () => {
    const err = new WorkspaceRunTaskConflictError("abc123def", "kimi", "in_progress");
    const commands = err.recovery.map((r) => r.command);
    expect(commands[0]).toBe("seed login kimi");
    expect(commands[1]).toContain("seed task assign abc123de");
    expect(commands[2]).toContain("--force");
    expect(err.recovery[2]?.risk).toBe("medium");
  });

  it("WorkspaceRunClaimConflictError suggests coordinate-via-space or force", () => {
    const err = new WorkspaceRunClaimConflictError([
      { path: "src/auth.ts", owner: "codex", signalId: "sig1", intent: "auth refactor", expiresAt: "2026-05-20T00:00:00Z" },
    ]);
    const commands = err.recovery.map((r) => r.command);
    expect(commands.some((c) => c?.includes("seed space post"))).toBe(true);
    expect(commands.some((c) => c?.includes("--force"))).toBe(true);
  });

  it("TaskNotFoundError suggests seed task list", () => {
    const err = new TaskNotFoundError("abc");
    expect(err.recovery[0]?.command).toBe("seed task list");
  });

  it("TaskBlockedError suggests inspecting the first blocker", () => {
    const err = new TaskBlockedError("dep-task", ["b1ocker-aaa", "b2ocker-bbb"]);
    expect(err.recovery[0]?.command).toContain("seed task show b1ocker-");
  });

  it("WorkspaceViewParseError suggests inspect + view sync", () => {
    const err = new WorkspaceViewParseError("/tmp/broken.json", new Error("Unexpected token"));
    expect(err.recovery.some((r) => r.kind === "read" && r.path === "/tmp/broken.json")).toBe(true);
    expect(err.recovery.some((r) => r.command === "seed view sync")).toBe(true);
  });

  it("WorkspaceViewValidationError surfaces the file path as a read target + explain success", () => {
    const err = new WorkspaceViewValidationError(
      [{ path: ["a", "b"], message: "bad", code: "custom" } as never],
      "policy.json",
    );
    expect(err.recovery.some((r) => r.kind === "read" && r.path === "policy.json")).toBe(true);
    expect(err.recovery.some((r) => r.command === "seed view explain success")).toBe(true);
  });

  it("WorkspaceViewError base class defaults recovery to empty", () => {
    const err = new WorkspaceViewError("bare error");
    expect(err.recovery).toEqual([]);
  });
});

describe("renderRecovery", () => {
  it("formats recovery as a Recovery: block with each command + reason", () => {
    const err = new TaskNotFoundError("abc");
    const out = renderRecovery(err);
    expect(out).toContain("Recovery:");
    expect(out).toContain("$ seed task list");
    expect(out).toContain("List available tasks");
  });

  it("annotates non-low risk", () => {
    const err = new WorkspaceRunDirtyTreeError(["src/foo.ts"], ["src/foo.ts"]);
    const out = renderRecovery(err);
    expect(out).toContain("(risk: medium)");
  });

  it("returns empty string for non-WorkspaceViewError or empty recovery", () => {
    expect(renderRecovery(new Error("plain"))).toBe("");
    expect(renderRecovery(new WorkspaceViewError("bare"))).toBe("");
    expect(renderRecovery(null)).toBe("");
  });
});

describe("native module load failures name the right remedy", () => {
  it("identifies an ABI mismatch and reports both ABI versions", () => {
    const abiError = new Error(
      "The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
        "was compiled against a different Node.js version using\n" +
        "NODE_MODULE_VERSION 115. This version of Node.js requires\n" +
        "NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n" +
        "the module (for instance, using `npm rebuild` or `npm install`).",
    );
    const message = describeNativeLoadFailure(abiError);
    expect(message).toContain("compiled for a different Node.js version");
    expect(message).toContain("ABI 115");
    expect(message).toContain("ABI 137");
    expect(message).toContain("npm rebuild better-sqlite3");
    // The nvm case is the common one and should be named, not left to guesswork.
    expect(message).toContain("nvm");
    expect(message).not.toContain("is not installed");
  });

  it("falls back to install advice when the module is genuinely absent", () => {
    const message = describeNativeLoadFailure(new Error("Cannot find module 'better-sqlite3'"));
    expect(message).toContain("is not installed");
    expect(message).toContain("optional dependency");
    expect(message).not.toContain("compiled for a different Node.js version");
  });

  it("handles a non-Error rejection without throwing", () => {
    expect(describeNativeLoadFailure("boom")).toContain("is not installed");
  });
});
