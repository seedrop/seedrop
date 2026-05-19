import { describe, expect, it } from "vitest";
import { isMutatingCommand, shouldAnnounceIdentity } from "../src/announce.js";

describe("shouldAnnounceIdentity — JSON contamination fix (f756ae10)", () => {
  it("announces on a mutating command with TTY stderr", () => {
    expect(
      shouldAnnounceIdentity({
        isMutating: true,
        quietFlag: false,
        quietEnv: undefined,
        stderrIsTTY: true,
      }),
    ).toBe(true);
  });

  it("suppresses when stderr is piped (the 2>&1 | jq case)", () => {
    // The bug: human ran `seed run finish --status completed 2>&1 | jq`.
    // Node sets stderr.isTTY to undefined when redirected.
    expect(
      shouldAnnounceIdentity({
        isMutating: true,
        quietFlag: false,
        quietEnv: undefined,
        stderrIsTTY: undefined,
      }),
    ).toBe(false);
    expect(
      shouldAnnounceIdentity({
        isMutating: true,
        quietFlag: false,
        quietEnv: undefined,
        stderrIsTTY: false,
      }),
    ).toBe(false);
  });

  it("suppresses when --quiet is passed even on TTY", () => {
    expect(
      shouldAnnounceIdentity({
        isMutating: true,
        quietFlag: true,
        quietEnv: undefined,
        stderrIsTTY: true,
      }),
    ).toBe(false);
  });

  it("suppresses when SEEDROP_QUIET=1 is set", () => {
    expect(
      shouldAnnounceIdentity({
        isMutating: true,
        quietFlag: false,
        quietEnv: "1",
        stderrIsTTY: true,
      }),
    ).toBe(false);
  });

  it("treats SEEDROP_QUIET=0 and SEEDROP_QUIET= as not-set", () => {
    expect(
      shouldAnnounceIdentity({
        isMutating: true,
        quietFlag: false,
        quietEnv: "0",
        stderrIsTTY: true,
      }),
    ).toBe(true);
    expect(
      shouldAnnounceIdentity({
        isMutating: true,
        quietFlag: false,
        quietEnv: "",
        stderrIsTTY: true,
      }),
    ).toBe(true);
  });

  it("does not announce on read-only commands even on TTY", () => {
    expect(
      shouldAnnounceIdentity({
        isMutating: false,
        quietFlag: false,
        quietEnv: undefined,
        stderrIsTTY: true,
      }),
    ).toBe(false);
  });
});

describe("isMutatingCommand — classification", () => {
  it("classifies run namespace mutators", () => {
    expect(isMutatingCommand("run", "start")).toBe(true);
    expect(isMutatingCommand("run", "log")).toBe(true);
    expect(isMutatingCommand("run", "finish")).toBe(true);
    expect(isMutatingCommand("run", "show")).toBe(false);
  });

  it("classifies task namespace mutators", () => {
    expect(isMutatingCommand("task", "create")).toBe(true);
    expect(isMutatingCommand("task", "claim")).toBe(true);
    expect(isMutatingCommand("task", "done")).toBe(true);
    expect(isMutatingCommand("task", "list")).toBe(false);
    expect(isMutatingCommand("task", "show")).toBe(false);
  });

  it("classifies top-level mutators", () => {
    expect(isMutatingCommand(undefined, "log")).toBe(true);
    expect(isMutatingCommand(undefined, "sync")).toBe(true);
    expect(isMutatingCommand(undefined, "brief")).toBe(false);
    expect(isMutatingCommand(undefined, "context")).toBe(false);
  });
});
