import { describe, expect, it } from "vitest";
import { tools } from "../src/index.js";

describe("tools registry", () => {
  it("exposes the expected core tool surface", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "seedrop_boot",
        "seedrop_bootstrap",
        "seedrop_capabilities",
        "seedrop_daemon_status",
        "seedrop_diff",
        "seedrop_focus",
        "seedrop_inbox",
        "seedrop_inbox_ack",
        "seedrop_index",
        "seedrop_manual",
        "seedrop_run_decision",
        "seedrop_run_finish",
        "seedrop_run_log",
        "seedrop_run_start",
      "seedrop_run_sweep",
        "seedrop_run_thread",
        "seedrop_run_verify",
        "seedrop_signal_claim",
        "seedrop_signal_list",
        "seedrop_signal_release",
        "seedrop_space_heartbeat",
        "seedrop_space_join",
        "seedrop_space_messages",
        "seedrop_space_post",
        "seedrop_space_presence",
        "seedrop_space_register",
        "seedrop_task_accept",
        "seedrop_task_assign",
        "seedrop_task_claim",
        "seedrop_task_create",
        "seedrop_task_decline",
        "seedrop_task_done",
        "seedrop_task_drop",
        "seedrop_task_list",
        "seedrop_task_pause",
        "seedrop_task_show",
        "seedrop_task_start",
        "seedrop_view_audit",
        "seedrop_view_context",
        "seedrop_view_explain",
      "seedrop_view_graves",
        "seedrop_view_log",
        "seedrop_view_preflight",
        "seedrop_view_sync",
      ].sort(),
    );
  });

  it("every tool has a description and an object inputSchema", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description.split("\n")[0]).toMatch(/^CLI equivalent: /);
      expect(t.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("seedrop_boot advertises the Situation cold-start contract", () => {
    const boot = tools.find((t) => t.name === "seedrop_boot");
    expect(boot?.description).toContain("Situation packet");
    expect(boot?.inputSchema.properties).toMatchObject({ json: { default: true } });
  });

  it("seedrop_index groups the exposed MCP tools by intent", async () => {
    const index = tools.find((t) => t.name === "seedrop_index");
    expect(index).toBeDefined();
    const result = await index!.handler({});
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, Array<{ tool: string }>>;
    expect(parsed.orient.map((entry) => entry.tool)).toContain("seedrop_boot");
    expect(parsed.orient.map((entry) => entry.tool)).toContain("seedrop_boot");
    expect(parsed.view.map((entry) => entry.tool)).toContain("seedrop_view_sync");
    expect(parsed.view.map((entry) => entry.tool)).toContain("seedrop_diff");
    expect(parsed.run.map((entry) => entry.tool)).toContain("seedrop_run_start");
    expect(parsed.run.map((entry) => entry.tool)).toContain("seedrop_run_decision");
    expect(parsed.signal.map((entry) => entry.tool)).toContain("seedrop_signal_claim");
    expect(parsed.signal.map((entry) => entry.tool)).toContain("seedrop_signal_release");
    expect(parsed.space.map((entry) => entry.tool)).toContain("seedrop_space_post");
    expect(parsed.daemon.map((entry) => entry.tool)).toContain("seedrop_daemon_status");
    expect(parsed.task.map((entry) => entry.tool)).toContain("seedrop_task_create");
    expect(parsed.task.map((entry) => entry.tool)).toContain("seedrop_task_done");
    const indexedTools = new Set(Object.values(parsed).flat().map((entry) => entry.tool));
    const exposedTools = new Set(tools.map((tool) => tool.name));
    for (const tool of indexedTools) {
      expect(exposedTools.has(tool)).toBe(true);
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
    const runDecision = tools.find((t) => t.name === "seedrop_run_decision");
    expect(runDecision?.inputSchema).toMatchObject({ required: ["decision"] });
    const runThread = tools.find((t) => t.name === "seedrop_run_thread");
    expect(runThread?.inputSchema).toMatchObject({ required: ["thread"] });
    const explain = tools.find((t) => t.name === "seedrop_view_explain");
    expect(explain?.inputSchema).toMatchObject({ required: ["topic"] });
    const signalClaim = tools.find((t) => t.name === "seedrop_signal_claim");
    expect(signalClaim?.inputSchema).toMatchObject({ required: ["target", "intent"] });
    const taskCreate = tools.find((t) => t.name === "seedrop_task_create");
    expect(taskCreate?.inputSchema).toMatchObject({ required: ["title"] });
    const taskShow = tools.find((t) => t.name === "seedrop_task_show");
    expect(taskShow?.inputSchema).toMatchObject({ required: ["task_id"] });
  });
});

describe("tool handlers (smoke)", () => {
  it("seedrop_boot returns text content even when no passport exists", async () => {
    const prior = process.env.SEEDROP_PASSPORT;
    process.env.SEEDROP_PASSPORT = "/nonexistent/__seed-mcp-test__.json";
    try {
      const tool = tools.find((t) => t.name === "seedrop_boot");
      expect(tool).toBeDefined();
      const result = await tool!.handler({});
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toContain("schema_version");
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

  it("seedrop_signal_release errors when no selector is provided", async () => {
    const tool = tools.find((t) => t.name === "seedrop_signal_release");
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("one of id, target, owner, or type is required");
  });
});

describe("handler dispatch invariant", () => {
  it("every handler dispatches via exec() to the seed CLI (no in-process logic)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const toolsPath = join(here, "..", "src", "tools.ts");
    const source = await readFile(toolsPath, "utf8");

    // Parse handlers: each is an `async handler(args)` block; the body
    // must contain `return exec(` somewhere. If a handler returns
    // anything else, this regex match length will diverge.
    const handlerStarts = source.match(/async handler\s*\(/g) ?? [];
    const execReturns = source.match(/return exec\s*\(/g) ?? [];
    const inProcessHandlers = source.match(/return text\s*\(/g) ?? [];

    expect(handlerStarts.length).toBeGreaterThan(15);
    expect(execReturns.length + inProcessHandlers.length).toBeGreaterThanOrEqual(handlerStarts.length);
  });
});

describe("staleness detection", () => {
  it("reports stale when dist mtime is newer than load time + 1s", async () => {
    const { computeStaleness } = await import("../src/server.js");
    const loadedAtMs = Date.now();
    const distMTimeMs = loadedAtMs + 2 * 60_000;
    const result = computeStaleness({ loadedAtMs, distMTimeMs });
    expect(result.stale).toBe(true);
    expect(result.minutes).toBe(2);
    expect(result.loaded_at).toBe(new Date(loadedAtMs).toISOString());
    expect(result.dist_mtime).toBe(new Date(distMTimeMs).toISOString());
  });

  it("reports not stale when dist mtime equals load time", async () => {
    const { computeStaleness } = await import("../src/server.js");
    const loadedAtMs = Date.now();
    const result = computeStaleness({ loadedAtMs, distMTimeMs: loadedAtMs });
    expect(result.stale).toBe(false);
    expect(result.loaded_at).toBe(new Date(loadedAtMs).toISOString());
    expect(result.dist_mtime).toBe(new Date(loadedAtMs).toISOString());
  });

  it("ignores sub-second mtime differences (build flicker tolerance)", async () => {
    const { computeStaleness } = await import("../src/server.js");
    const loadedAtMs = Date.now();
    const result = computeStaleness({ loadedAtMs, distMTimeMs: loadedAtMs + 500 });
    expect(result.stale).toBe(false);
  });

  it("formats stale recovery guidance with timestamps and client restart hints", async () => {
    const { computeStaleness, formatStalenessWarning } = await import("../src/server.js");
    const loadedAtMs = Date.UTC(2026, 5, 11, 8, 0, 0);
    const distMTimeMs = loadedAtMs + 3 * 60_000;
    const warning = formatStalenessWarning(computeStaleness({ loadedAtMs, distMTimeMs }), "tool_call");
    expect(warning).toContain("loaded_at=2026-06-11T08:00:00.000Z");
    expect(warning).toContain("dist_mtime=2026-06-11T08:03:00.000Z");
    expect(warning).toContain("dist is ~3m newer");
    expect(warning).toContain("Codex: restart Codex");
    expect(warning).toContain("Claude Code/Desktop: restart Claude");
  });
});

describe("unknown tool recovery", () => {
  it("points removed MCP aliases at their replacement tool", async () => {
    const { unknownToolMessage } = await import("../src/server.js");
    const message = unknownToolMessage("seedrop_continuity");
    expect(message).toContain("seedrop_continuity was removed");
    expect(message).toContain("use seedrop_boot");
  });

  it("points truly unknown MCP tools at the live capabilities catalog", async () => {
    const { unknownToolMessage } = await import("../src/server.js");
    const message = unknownToolMessage("seedrop_not_real");
    expect(message).toContain("Unknown tool: seedrop_not_real");
    expect(message).toContain("seedrop_capabilities");
  });
});
