import { runSeed } from "./run.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function text(out: string): ToolResult {
  return { content: [{ type: "text", text: out }] };
}

function error(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function exec(args: string[], cwd?: string): Promise<ToolResult> {
  const result = await runSeed(args, { cwd });
  if (result.exitCode !== 0) {
    const timeout = result.timedOut ? " timed out" : "";
    const truncated = result.truncated ? "\n(output truncated)" : "";
    return error(`seed ${args.join(" ")} failed${timeout} (exit ${result.exitCode}):\n${result.stderr || result.stdout}${truncated}`);
  }
  return text(`${result.stdout || result.stderr}${result.truncated ? "\n(output truncated)" : ""}`);
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export const tools: ToolDef[] = [
  {
    name: "seedrop_continuity",
    description:
      "Run Seedrop's boot block: identity, current repo View, daemon presence, recent Space messages, and a next-move suggestion. Call this whenever the user asks about Seedrop, mentions 'where was I', or works in a repo with `.seedrop/view/`. Returns Markdown by default; pass `json: true` for structured output.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project directory to orient against. Defaults to the server's cwd." },
        json: { type: "boolean", description: "Return structured JSON instead of human-readable Markdown.", default: false },
        messages: { type: "number", description: "Max recent messages per joined space (default 5).", default: 5 },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = strArg(args, "cwd");
      const cmd = ["continuity"];
      if (args.json === true) cmd.push("--json");
      if (typeof args.messages === "number") cmd.push("--messages", String(args.messages));
      return exec(cmd, cwd);
    },
  },
  {
    name: "seedrop_bootstrap",
    description:
      "Idempotent setup. With no passport: creates `~/.seedrop/id/passport.json` (requires `name` + `purpose`). With a passport: re-links the current repo to the global passport via `.seedrop/view/`. Pass `no_link: true` to skip the repo-link step.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (only required on first run / no passport)." },
        purpose: { type: "string", description: "One-line mission (only required on first run / no passport)." },
        cwd: { type: "string", description: "Project root to link. Defaults to the server's cwd." },
        role: { type: "string", description: "Optional role to attach to the active-project record." },
        current_focus: { type: "string", description: "Optional current focus to attach." },
        no_link: { type: "boolean", description: "Skip the per-repo link step.", default: false },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["bootstrap"];
      const name = strArg(args, "name");
      const purpose = strArg(args, "purpose");
      const role = strArg(args, "role");
      const focus = strArg(args, "current_focus");
      if (name) cmd.push("--name", name);
      if (purpose) cmd.push("--purpose", purpose);
      if (role) cmd.push("--role", role);
      if (focus) cmd.push("--current-focus", focus);
      if (args.no_link === true) cmd.push("--no-link");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_view_context",
    description: "Return the per-repo View state for `cwd` (manifest, active signals, open threads). JSON.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
    async handler(args) {
      return exec(["view", "context", "--json"], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_view_brief",
    description: "Return the stable per-repo View orientation packet for cwd as JSON.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
    async handler(args) {
      return exec(["view", "brief", "--json"], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_view_preflight",
    description: "Run repo View preflight checks and return JSON next actions for safe startup.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
    async handler(args) {
      return exec(["view", "preflight", "--json"], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_start",
    description: "Start a repo-local run journal for the current agent and goal. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        goal: { type: "string" },
        new: { type: "boolean", default: false },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    async handler(args) {
      const goal = strArg(args, "goal");
      if (!goal) return error("goal is required");
      const cmd = ["run", "start", "--goal", goal];
      if (args.new === true) cmd.push("--new");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_log",
    description: "Append a progress step to the active repo-local run journal. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        summary: { type: "string" },
        changed_paths: { type: "array", items: { type: "string" } },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async handler(args) {
      const summary = strArg(args, "summary");
      if (!summary) return error("summary is required");
      const cmd = ["run", "log", "--summary", summary];
      for (const changedPath of strArrayArg(args, "changed_paths")) cmd.push("--changed-path", changedPath);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_verify",
    description: "Record validation evidence on the active repo-local run journal. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        command: { type: "string" },
        status: { type: "string", enum: ["passed", "failed", "skipped"] },
        notes: { type: "string" },
      },
      required: ["command", "status"],
      additionalProperties: false,
    },
    async handler(args) {
      const command = strArg(args, "command");
      const status = strArg(args, "status");
      if (!command || !status) return error("command and status are required");
      const cmd = ["run", "verify", "--command", command, "--status", status];
      const notes = strArg(args, "notes");
      if (notes) cmd.push("--notes", notes);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_finish",
    description: "Finish the active repo-local run journal with a terminal status. Refuses status=completed when any of the run's changed_paths are uncommitted in git; pass force=true to override. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        status: { type: "string", enum: ["completed", "blocked", "failed"] },
        force: { type: "boolean", description: "Bypass the uncommitted-changed_paths gate when status=completed." },
      },
      required: ["status"],
      additionalProperties: false,
    },
    async handler(args) {
      const status = strArg(args, "status");
      if (!status) return error("status is required");
      const cmd = ["run", "finish", "--status", status];
      if (args.force === true) cmd.push("--force");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_handoff_create",
    description: "Create a structured repo-local handoff artifact for another agent or human. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        to: { type: "string" },
        summary: { type: "string" },
        run_id: { type: "string" },
        blockers: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["to", "summary"],
      additionalProperties: false,
    },
    async handler(args) {
      const to = strArg(args, "to");
      const summary = strArg(args, "summary");
      if (!to || !summary) return error("to and summary are required");
      const cmd = ["handoff", "create", "--to", to, "--summary", summary];
      const runId = strArg(args, "run_id");
      if (runId) cmd.push("--run-id", runId);
      for (const blocker of strArrayArg(args, "blockers")) cmd.push("--blocker", blocker);
      for (const risk of strArrayArg(args, "risks")) cmd.push("--risk", risk);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_handoff_list",
    description: "List repo-local handoff artifacts as JSON.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
    async handler(args) {
      return exec(["handoff", "list", "--json"], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_handoff_read",
    description: "Read one repo-local handoff artifact as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(args) {
      const id = strArg(args, "id");
      if (!id) return error("id is required");
      return exec(["handoff", "read", id, "--json"], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_handoff_accept",
    description: "Mark one repo-local handoff artifact accepted without deleting it. Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(args) {
      const id = strArg(args, "id");
      if (!id) return error("id is required");
      return exec(["handoff", "accept", id], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_view_log",
    description:
      "Write a continuity packet into the current repo's View. Records mission + summary, optional decisions/assumptions/open_threads/changed_paths, and validation status.",
    inputSchema: {
      type: "object",
      properties: {
        mission: { type: "string" },
        summary: { type: "string" },
        cwd: { type: "string" },
        validation_status: { type: "string", enum: ["passed", "failed", "skipped", "unknown"], default: "unknown" },
        validation_command: { type: "string" },
        decisions: { type: "array", items: { type: "string" } },
        open_threads: { type: "array", items: { type: "string" } },
        changed_paths: { type: "array", items: { type: "string" } },
      },
      required: ["mission", "summary"],
      additionalProperties: false,
    },
    async handler(args) {
      const mission = strArg(args, "mission");
      const summary = strArg(args, "summary");
      if (!mission || !summary) return error("mission and summary are required");
      const cmd = ["view", "log", "--mission", mission, "--summary", summary];
      const status = strArg(args, "validation_status");
      if (status) cmd.push("--validation-status", status);
      const valCmd = strArg(args, "validation_command");
      if (valCmd) cmd.push("--validation-command", valCmd);
      const decisions = Array.isArray(args.decisions) ? (args.decisions as unknown[]).filter((v): v is string => typeof v === "string") : [];
      for (const d of decisions) cmd.push("--decision", d);
      const openThreads = Array.isArray(args.open_threads) ? (args.open_threads as unknown[]).filter((v): v is string => typeof v === "string") : [];
      for (const t of openThreads) cmd.push("--open-thread", t);
      const changedPaths = Array.isArray(args.changed_paths) ? (args.changed_paths as unknown[]).filter((v): v is string => typeof v === "string") : [];
      for (const p of changedPaths) cmd.push("--changed-path", p);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_space_register",
    description: "Register a live Space session. Caches the session id on disk so `seedrop_space_heartbeat` can keep it warm. Required before you'll appear in `seedrop_space_presence`.",
    inputSchema: {
      type: "object",
      properties: {
        working_on: { type: "string", description: "Short description of what the agent is currently doing." },
        space_id: { type: "string", description: "Optional space id to scope this session to." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "register"];
      const wo = strArg(args, "working_on");
      const sid = strArg(args, "space_id");
      if (wo) cmd.push("--working-on", wo);
      if (sid) cmd.push("--space-id", sid);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_heartbeat",
    description: "Refresh the agent's live presence (uses the cached session id from the most recent register).",
    inputSchema: {
      type: "object",
      properties: {
        working_on: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "heartbeat"];
      const wo = strArg(args, "working_on");
      if (wo) cmd.push("--working-on", wo);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_presence",
    description: "List currently-live Space sessions (filtered by TTL). Returns JSON.",
    inputSchema: {
      type: "object",
      properties: {
        space_id: { type: "string" },
        ttl_ms: { type: "number" },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "presence"];
      const sid = strArg(args, "space_id");
      const ttl = typeof args.ttl_ms === "number" ? args.ttl_ms : undefined;
      if (sid) cmd.push("--space-id", sid);
      if (ttl !== undefined) cmd.push("--ttl", String(ttl));
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_join",
    description: "Open or join a coordination Space by name. Returns the Space metadata.",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space name (e.g. 'seedrop-team')." },
      },
      required: ["space"],
      additionalProperties: false,
    },
    async handler(args) {
      const space = strArg(args, "space");
      if (!space) return error("space is required");
      return exec(["space", "join", space]);
    },
  },
  {
    name: "seedrop_space_post",
    description: "Post a message to a Space. Use for handoffs, status updates, multi-agent coordination.",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string" },
        content: { type: "string" },
        role: { type: "string", enum: ["agent", "human", "system"], default: "agent" },
      },
      required: ["space", "content"],
      additionalProperties: false,
    },
    async handler(args) {
      const space = strArg(args, "space");
      const content = strArg(args, "content");
      if (!space || !content) return error("space and content are required");
      const cmd = ["space", "post", space, content];
      const role = strArg(args, "role");
      if (role && role !== "agent") cmd.push("--role", role);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_messages",
    description: "Read recent messages from a Space (durable; safe to call repeatedly).",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string" },
      },
      required: ["space"],
      additionalProperties: false,
    },
    async handler(args) {
      const space = strArg(args, "space");
      if (!space) return error("space is required");
      return exec(["space", "messages", space]);
    },
  },
  {
    name: "seedrop_inbox",
    description:
      "List @-mentions addressed to this passport. By default returns only unacked items (the actionable inbox). Pass `all: true` for full history. Each item has id, sender, content, principal_chain, and ack state.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include acked items too. Default false.", default: false },
        limit: { type: "number", description: "Max items (default 50).", default: 50 },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "inbox"];
      if (args.all !== true) cmd.push("--unacked-only");
      if (typeof args.limit === "number") cmd.push("--limit", String(args.limit));
      return exec(cmd);
    },
  },
  {
    name: "seedrop_inbox_ack",
    description:
      "Close out a mention with an explicit result. Use `done` when handled, `deferred` with `deferred_until` when you'll revisit, and `ignored` with `note` when consciously skipping.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Mention id from seedrop_inbox." },
        result: {
          type: "string",
          enum: ["done", "deferred", "ignored"],
          description: "Explicit closure semantics.",
        },
        note: { type: "string", description: "Required for `ignored`; recommended for `deferred`." },
        deferred_until: { type: "string", description: "ISO-8601 timestamp; required when result=deferred." },
      },
      required: ["item_id", "result"],
      additionalProperties: false,
    },
    async handler(args) {
      const itemId = strArg(args, "item_id");
      const result = strArg(args, "result");
      if (!itemId || !result) return error("item_id and result are required");
      const cmd = ["space", "inbox-ack", itemId, "--result", result];
      const note = strArg(args, "note");
      const deferredUntil = strArg(args, "deferred_until");
      if (note) cmd.push("--note", note);
      if (deferredUntil) cmd.push("--deferred-until", deferredUntil);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_daemon_status",
    description: "Report whether the always-on Seedrop Space daemon is loaded and running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      return exec(["daemon", "status"]);
    },
  },
];
