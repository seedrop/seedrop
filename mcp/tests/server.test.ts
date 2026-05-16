import { describe, expect, it } from "vitest";
import { tools } from "../src/index.js";

describe("tools registry", () => {
  it("exposes the expected core tool surface", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "seedrop_bootstrap",
        "seedrop_continuity",
        "seedrop_daemon_status",
        "seedrop_handoff_accept",
        "seedrop_handoff_create",
        "seedrop_handoff_list",
        "seedrop_handoff_read",
        "seedrop_inbox",
        "seedrop_inbox_ack",
        "seedrop_run_finish",
        "seedrop_run_log",
        "seedrop_run_start",
        "seedrop_run_verify",
        "seedrop_space_heartbeat",
        "seedrop_space_join",
        "seedrop_space_messages",
        "seedrop_space_post",
        "seedrop_space_presence",
        "seedrop_space_register",
        "seedrop_view_brief",
        "seedrop_view_context",
        "seedrop_view_log",
        "seedrop_view_preflight",
      ].sort(),
    );
  });

  it("every tool has a description and an object inputSchema", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("required tools declare their required args", () => {
    const log = tools.find((t) => t.name === "seedrop_view_log");
    expect(log?.inputSchema).toMatchObject({ required: ["mission", "summary"] });
    const post = tools.find((t) => t.name === "seedrop_space_post");
    expect(post?.inputSchema).toMatchObject({ required: ["space", "content"] });
    const join = tools.find((t) => t.name === "seedrop_space_join");
    expect(join?.inputSchema).toMatchObject({ required: ["space"] });
    const runStart = tools.find((t) => t.name === "seedrop_run_start");
    expect(runStart?.inputSchema).toMatchObject({ required: ["goal"] });
    const handoffRead = tools.find((t) => t.name === "seedrop_handoff_read");
    expect(handoffRead?.inputSchema).toMatchObject({ required: ["id"] });
  });
});

describe("tool handlers (smoke)", () => {
  it("seedrop_continuity returns text content even when no passport exists", async () => {
    const prior = process.env.SEEDROP_PASSPORT;
    process.env.SEEDROP_PASSPORT = "/nonexistent/__seed-mcp-test__.json";
    try {
      const tool = tools.find((t) => t.name === "seedrop_continuity");
      expect(tool).toBeDefined();
      const result = await tool!.handler({});
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("Continuity");
    } finally {
      if (prior === undefined) delete process.env.SEEDROP_PASSPORT;
      else process.env.SEEDROP_PASSPORT = prior;
    }
  }, 15000);

  it("seedrop_view_log errors on missing required args", async () => {
    const tool = tools.find((t) => t.name === "seedrop_view_log");
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("mission and summary are required");
  });
});
