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

function desc(cliEquivalent: string, body: string): string {
  return `CLI equivalent: ${cliEquivalent}\n${body}`;
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

function pushStringFlag(cmd: string[], args: Record<string, unknown>, key: string, flag: string): void {
  const value = strArg(args, key);
  if (value) cmd.push(flag, value);
}

function pushClientFlags(cmd: string[], args: Record<string, unknown>): void {
  pushStringFlag(cmd, args, "url", "--url");
  pushStringFlag(cmd, args, "passport", "--passport");
}

export const tools: ToolDef[] = [
  {
    name: "seedrop_index",
    description: desc(
      "MCP-only: seedrop_index",
      "Return the Seedrop MCP tool catalog grouped by intent. Call once per session, cache the result, then route tool choices from the returned groups instead of guessing from the flat tool list.",
    ),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler() {
      return text(JSON.stringify(buildSeedropIndex(), null, 2));
    },
  },
  {
    name: "seedrop_manual",
    description: desc(
      "seed manual [section]",
      "Return the agent-shaped Seedrop cheat sheet: 4 primitives, 5-layer model, common workflows (sprint → tasks, run lifecycle, handoffs), state queries, and anti-patterns. Call this ONCE at session start and cache the result — every subsequent 'how do I X in seedrop' question is answered offline from this content. Cheaper than discovering through trial and error. Pass section to retrieve a slice ('concepts' | 'workflows' | 'state' | 'anti-patterns' | 'all', defaults to 'all').",
    ),
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "concepts", "workflows", "state", "anti-patterns"],
          description: "Which section to return. Defaults to 'all' (full document).",
        },
        cwd: { type: "string", description: "Workspace directory (rarely needed — the manual is global)." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["manual"];
      const section = strArg(args, "section");
      if (section) cmd.push(section);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_continuity",
    description: desc(
      "seed continuity [--brief|--medium|--full] [--json] [--messages N]",
      "Run Seedrop's boot block: identity, current repo View, daemon presence, recent Space messages, and a next-move suggestion. Call this whenever the user asks about Seedrop, mentions 'where was I', or works in a repo with `.seedrop/view/`. Returns Markdown by default; pass `json: true` for structured output.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project directory to orient against. Defaults to the server's cwd." },
        json: { type: "boolean", description: "Return structured JSON instead of human-readable Markdown.", default: false },
        messages: { type: "number", description: "Max recent messages per joined space (default 5).", default: 5 },
        mode: { type: "string", enum: ["brief", "medium", "full"], description: "Plain-text detail level. Defaults to brief." },
        passport: { type: "string", description: "Explicit passport path." },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        peek: { type: "boolean", description: "Do not advance the continuity watermark.", default: false },
        since: { type: "string", description: "Override the last-seen watermark with an ISO timestamp." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = strArg(args, "cwd");
      const cmd = ["continuity"];
      if (args.json === true) cmd.push("--json");
      const mode = strArg(args, "mode");
      if (mode === "medium") cmd.push("--medium");
      if (mode === "full") cmd.push("--full");
      if (typeof args.messages === "number") cmd.push("--messages", String(args.messages));
      pushStringFlag(cmd, args, "passport", "--passport");
      pushStringFlag(cmd, args, "url", "--url");
      if (args.peek === true) cmd.push("--peek");
      pushStringFlag(cmd, args, "since", "--since");
      return exec(cmd, cwd);
    },
  },
  {
    name: "seedrop_focus",
    description: desc(
      "seed focus [--json]",
      "Compact ~400-token mission-scoped pre-flight: identity, current focus, the single next action, only the collision signals touching that focus, the top recommended reads, and an inbox flag. A cheap first read before deciding whether full `seed continuity` is needed. Never advances the continuity watermark. Returns Markdown by default; pass `json: true` for the structured subset.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project directory to orient against. Defaults to the server's cwd." },
        json: { type: "boolean", description: "Return the structured focus subset instead of Markdown.", default: false },
        passport: { type: "string", description: "Explicit passport path." },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["focus"];
      if (args.json === true) cmd.push("--json");
      pushStringFlag(cmd, args, "passport", "--passport");
      pushStringFlag(cmd, args, "url", "--url");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_boot",
    description: desc(
      "seed boot [--json] [--messages N]",
      "Return the canonical cold-start Situation packet: purpose, last work, current state, next move, attention cues, evidence, confidence, and the underlying deterministic boot report. Prefer this at session start when the agent needs one reliable answer for what to do now.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project directory to orient against. Defaults to the server's cwd." },
        json: { type: "boolean", description: "Return structured JSON instead of human-readable Markdown.", default: true },
        messages: { type: "number", description: "Max recent messages per joined space (default 5).", default: 5 },
        passport: { type: "string", description: "Explicit passport path." },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        peek: { type: "boolean", description: "Do not advance the continuity watermark.", default: false },
        since: { type: "string", description: "Override the last-seen watermark with an ISO timestamp." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = strArg(args, "cwd");
      const cmd = ["boot"];
      if (args.json !== false) cmd.push("--json");
      if (typeof args.messages === "number") cmd.push("--messages", String(args.messages));
      pushStringFlag(cmd, args, "passport", "--passport");
      pushStringFlag(cmd, args, "url", "--url");
      if (args.peek === true) cmd.push("--peek");
      pushStringFlag(cmd, args, "since", "--since");
      return exec(cmd, cwd);
    },
  },
  {
    name: "seedrop_bootstrap",
    description: desc(
      "seed bootstrap [--name <name>] [--purpose <purpose>] [--as <agent>] [--autonomous] [--no-link]",
      "Idempotent setup. With no passport: creates `~/.seedrop/id/passport.json` (requires `name` + `purpose`). With a passport: re-links the current repo to the global passport via `.seedrop/view/`. Pass `no_link: true` to skip the repo-link step.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (only required on first run / no passport)." },
        purpose: { type: "string", description: "One-line mission (only required on first run / no passport)." },
        cwd: { type: "string", description: "Project root to link. Defaults to the server's cwd." },
        role: { type: "string", description: "Optional role to attach to the active-project record." },
        current_focus: { type: "string", description: "Optional current focus to attach." },
        as: { type: "string", description: "Create or link a named agent passport." },
        autonomous: { type: "boolean", description: "Create an agent passport without a parent operator passport.", default: false },
        agent_id: { type: "string", description: "Explicit passport agent_id." },
        issued_by: { type: "string", description: "Explicit issuing principal." },
        passport: { type: "string", description: "Explicit passport path." },
        space_root: { type: "string", description: "Explicit Space root." },
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
      pushStringFlag(cmd, args, "as", "--as");
      if (args.autonomous === true) cmd.push("--autonomous");
      pushStringFlag(cmd, args, "agent_id", "--agent-id");
      pushStringFlag(cmd, args, "issued_by", "--issued-by");
      pushStringFlag(cmd, args, "passport", "--passport");
      pushStringFlag(cmd, args, "space_root", "--space-root");
      if (args.no_link === true) cmd.push("--no-link");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_view_context",
    description: desc("seed view context --json", "Return the per-repo View state for `cwd` (manifest, active signals, open threads). JSON."),
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
    description: desc("seed view brief --json", "Return the stable per-repo View orientation packet for cwd as JSON."),
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
    description: desc("seed view preflight --json", "Run repo View preflight checks and return JSON next actions for safe startup."),
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
    name: "seedrop_view_sync",
    description: desc("seed view sync [--workspace-id <id>]", "Refresh the repo View workspace manifest. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        workspace_id: { type: "string", description: "Optional workspace id to write into the manifest." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["view", "sync"];
      const workspaceId = strArg(args, "workspace_id");
      if (workspaceId) cmd.push("--workspace-id", workspaceId);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_view_audit",
    description: desc("seed view audit --json", "Run deep View validation for manifest drift and expired signals. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
    async handler(args) {
      return exec(["view", "audit", "--json"], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_view_explain",
    description: desc("seed view explain <topic> --json", "Explain why a path is or is not represented in View, or explain View success when topic is 'success'. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        topic: { type: "string", description: "A workspace path, or 'success' for View success criteria." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    async handler(args) {
      const topic = strArg(args, "topic");
      if (!topic) return error("topic is required");
      return exec(["view", "explain", topic, "--json"], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_diff",
    description: desc("seed diff [--since <iso|last-session|earliest>] --json", "Show View changes since an ISO-8601 timestamp, last-session, or earliest. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        since: { type: "string", description: "ISO-8601 timestamp, 'last-session', or 'earliest'." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["diff", "--json"];
      const since = strArg(args, "since");
      if (since) cmd.push("--since", since);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_start",
    description: desc("seed run start --goal <goal> [--new] [--task <id>] [--claim <path>] [--force]", "Start a repo-local run journal for the current agent and goal. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        goal: { type: "string" },
        new: { type: "boolean", default: false },
        task: { type: "string", description: "Task id or prefix to link to the run." },
        claim: { type: "array", items: { type: "string" }, description: "Paths or targets claimed by this run." },
        force: { type: "boolean", description: "Bypass claim conflict checks.", default: false },
      },
      required: ["goal"],
      additionalProperties: false,
    },
    async handler(args) {
      const goal = strArg(args, "goal");
      if (!goal) return error("goal is required");
      const cmd = ["run", "start", "--goal", goal];
      if (args.new === true) cmd.push("--new");
      pushStringFlag(cmd, args, "task", "--task");
      for (const claim of strArrayArg(args, "claim")) cmd.push("--claim", claim);
      if (args.force === true) cmd.push("--force");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_log",
    description: desc("seed run log --summary <summary>", "Append a progress step to the active repo-local run journal. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        summary: { type: "string" },
        changed_paths: { type: "array", items: { type: "string" } },
        run_id: { type: "string", description: "Explicit run id or prefix." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    async handler(args) {
      const summary = strArg(args, "summary");
      if (!summary) return error("summary is required");
      const cmd = ["run", "log", "--summary", summary];
      for (const changedPath of strArrayArg(args, "changed_paths")) cmd.push("--changed-path", changedPath);
      pushStringFlag(cmd, args, "run_id", "--run-id");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_verify",
    description: desc("seed run verify --command <command> --status passed|failed|skipped", "Record validation evidence on the active repo-local run journal. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        command: { type: "string" },
        status: { type: "string", enum: ["passed", "failed", "skipped"] },
        notes: { type: "string" },
        run_id: { type: "string", description: "Explicit run id or prefix." },
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
      pushStringFlag(cmd, args, "run_id", "--run-id");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_decision",
    description: desc("seed run decision <text>", "Record a decision on the active repo-local run journal. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        decision: { type: "string" },
      },
      required: ["decision"],
      additionalProperties: false,
    },
    async handler(args) {
      const decision = strArg(args, "decision");
      if (!decision) return error("decision is required");
      return exec(["run", "decision", decision], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_thread",
    description: desc("seed run thread <text>", "Record an open thread on the active repo-local run journal. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        thread: { type: "string" },
      },
      required: ["thread"],
      additionalProperties: false,
    },
    async handler(args) {
      const thread = strArg(args, "thread");
      if (!thread) return error("thread is required");
      return exec(["run", "thread", thread], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_run_finish",
    description: desc("seed run finish --status completed|blocked|failed [--force]", "Finish the active repo-local run journal with a terminal status. Refuses status=completed when any of the run's changed_paths are uncommitted in git; pass force=true to override. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        status: { type: "string", enum: ["completed", "blocked", "failed"] },
        force: { type: "boolean", description: "Bypass the uncommitted-changed_paths gate when status=completed." },
        run_id: { type: "string", description: "Explicit run id or prefix." },
      },
      required: ["status"],
      additionalProperties: false,
    },
    async handler(args) {
      const status = strArg(args, "status");
      if (!status) return error("status is required");
      const cmd = ["run", "finish", "--status", status];
      if (args.force === true) cmd.push("--force");
      pushStringFlag(cmd, args, "run_id", "--run-id");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_handoff_create",
    description: desc("seed handoff create --to <agent> --summary <summary>", "Create a structured repo-local handoff artifact for another agent or human. Returns JSON."),
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
    description: desc("seed handoff list --json", "List repo-local handoff artifacts as JSON."),
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
    description: desc("seed handoff read <id> --json", "Read one repo-local handoff artifact as JSON."),
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
    description: desc("seed handoff accept <id>", "Mark one repo-local handoff artifact accepted without deleting it. Returns JSON."),
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
    description: desc(
      "seed view log --mission <mission> --summary <summary>",
      "Write a continuity packet into the current repo's View. Records mission + summary, optional decisions/assumptions/open_threads/changed_paths, and validation status.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        mission: { type: "string" },
        summary: { type: "string" },
        cwd: { type: "string" },
        validation_status: { type: "string", enum: ["passed", "failed", "skipped", "unknown"], default: "unknown" },
        validation_command: { type: "string" },
        validation_notes: { type: "string" },
        decisions: { type: "array", items: { type: "string" } },
        assumptions: { type: "array", items: { type: "string" } },
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
      const validationNotes = strArg(args, "validation_notes");
      if (validationNotes) cmd.push("--validation-notes", validationNotes);
      const decisions = Array.isArray(args.decisions) ? (args.decisions as unknown[]).filter((v): v is string => typeof v === "string") : [];
      for (const d of decisions) cmd.push("--decision", d);
      for (const assumption of strArrayArg(args, "assumptions")) cmd.push("--assumption", assumption);
      const openThreads = Array.isArray(args.open_threads) ? (args.open_threads as unknown[]).filter((v): v is string => typeof v === "string") : [];
      for (const t of openThreads) cmd.push("--open-thread", t);
      const changedPaths = Array.isArray(args.changed_paths) ? (args.changed_paths as unknown[]).filter((v): v is string => typeof v === "string") : [];
      for (const p of changedPaths) cmd.push("--changed-path", p);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_signal_claim",
    description: desc("seed view claim <target> <intent>", "Create an advisory claim signal lease for a View target. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        target: { type: "string" },
        intent: { type: "string" },
        owner: { type: "string" },
        ttl_ms: { type: "number", description: "Lease TTL in milliseconds. Passed to CLI as --ttl." },
        recovery: { type: "string", description: "Recovery guidance if the signal expires or conflicts." },
      },
      required: ["target", "intent"],
      additionalProperties: false,
    },
    async handler(args) {
      const target = strArg(args, "target");
      const intent = strArg(args, "intent");
      if (!target || !intent) return error("target and intent are required");
      const cmd = ["view", "claim", target, intent];
      const owner = strArg(args, "owner");
      if (owner) cmd.push("--owner", owner);
      if (typeof args.ttl_ms === "number") cmd.push("--ttl", String(args.ttl_ms));
      const recovery = strArg(args, "recovery");
      if (recovery) cmd.push("--recovery", recovery);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_signal_lock",
    description: desc("seed view lock <target> <intent>", "Create an advisory lock signal lease for a View target. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        target: { type: "string" },
        intent: { type: "string" },
        owner: { type: "string" },
        ttl_ms: { type: "number", description: "Lease TTL in milliseconds. Passed to CLI as --ttl." },
        recovery: { type: "string", description: "Recovery guidance if the signal expires or conflicts." },
      },
      required: ["target", "intent"],
      additionalProperties: false,
    },
    async handler(args) {
      const target = strArg(args, "target");
      const intent = strArg(args, "intent");
      if (!target || !intent) return error("target and intent are required");
      const cmd = ["view", "lock", target, intent];
      const owner = strArg(args, "owner");
      if (owner) cmd.push("--owner", owner);
      if (typeof args.ttl_ms === "number") cmd.push("--ttl", String(args.ttl_ms));
      const recovery = strArg(args, "recovery");
      if (recovery) cmd.push("--recovery", recovery);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_signal_list",
    description: desc("seed view signals [--include-expired]", "List active View signal leases, optionally including expired leases. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        include_expired: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["view", "signals"];
      if (args.include_expired === true) cmd.push("--include-expired");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_signal_release",
    description: desc("seed view release [--id <id>|--target <target>|--owner <owner>|--type claim|lock]", "Release View signal leases by id, target, owner, or type. Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        id: { type: "string" },
        target: { type: "string" },
        owner: { type: "string" },
        type: { type: "string", enum: ["claim", "lock"] },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const id = strArg(args, "id");
      const target = strArg(args, "target");
      const owner = strArg(args, "owner");
      const type = strArg(args, "type");
      if (!id && !target && !owner && !type) return error("one of id, target, owner, or type is required");
      const cmd = ["view", "release"];
      if (id) cmd.push("--id", id);
      if (target) cmd.push("--target", target);
      if (owner) cmd.push("--owner", owner);
      if (type) cmd.push("--type", type);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_space_register",
    description: desc("seed space register [--working-on <text>]", "Register a live Space session. Caches the session id on disk so `seedrop_space_heartbeat` can keep it warm. Required before you'll appear in `seedrop_space_presence`."),
    inputSchema: {
      type: "object",
      properties: {
        working_on: { type: "string", description: "Short description of what the agent is currently doing." },
        space_id: { type: "string", description: "Optional space id to scope this session to." },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "register"];
      const wo = strArg(args, "working_on");
      const sid = strArg(args, "space_id");
      if (wo) cmd.push("--working-on", wo);
      if (sid) cmd.push("--space-id", sid);
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_heartbeat",
    description: desc("seed space heartbeat [--working-on <text>]", "Refresh the agent's live presence (uses the cached session id from the most recent register)."),
    inputSchema: {
      type: "object",
      properties: {
        working_on: { type: "string" },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "heartbeat"];
      const wo = strArg(args, "working_on");
      if (wo) cmd.push("--working-on", wo);
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_presence",
    description: desc("seed space presence [--space-id <id>] [--ttl <ms>]", "List currently-live Space sessions (filtered by TTL). Returns JSON."),
    inputSchema: {
      type: "object",
      properties: {
        space_id: { type: "string" },
        ttl_ms: { type: "number" },
        filter_passport: { type: "string", description: "Filter sessions by passport id." },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "presence"];
      const sid = strArg(args, "space_id");
      const ttl = typeof args.ttl_ms === "number" ? args.ttl_ms : undefined;
      if (sid) cmd.push("--space-id", sid);
      if (ttl !== undefined) cmd.push("--ttl", String(ttl));
      pushStringFlag(cmd, args, "filter_passport", "--filter-passport");
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_join",
    description: desc("seed space join <space>", "Open or join a coordination Space by name. Returns the Space metadata."),
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space name (e.g. 'seedrop-team')." },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
      },
      required: ["space"],
      additionalProperties: false,
    },
    async handler(args) {
      const space = strArg(args, "space");
      if (!space) return error("space is required");
      const cmd = ["space", "join", space];
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_post",
    description: desc("seed space post <space> <message>", "Post a message to a Space. Use for handoffs, status updates, multi-agent coordination."),
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string" },
        content: { type: "string" },
        role: { type: "string", enum: ["agent", "human", "system"], default: "agent" },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
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
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_space_messages",
    description: desc("seed space messages <space>", "Read recent messages from a Space (durable; safe to call repeatedly)."),
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string" },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
      },
      required: ["space"],
      additionalProperties: false,
    },
    async handler(args) {
      const space = strArg(args, "space");
      if (!space) return error("space is required");
      const cmd = ["space", "messages", space];
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_inbox",
    description: desc(
      "seed inbox [--unacked-only]",
      "List @-mentions addressed to this passport. By default returns only unacked items (the actionable inbox). Pass `all: true` for full history. Each item has id, sender, content, principal_chain, and ack state.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include acked items too. Default false.", default: false },
        limit: { type: "number", description: "Max items (default 50).", default: 50 },
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["space", "inbox"];
      if (args.all !== true) cmd.push("--unacked-only");
      if (typeof args.limit === "number") cmd.push("--limit", String(args.limit));
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_inbox_ack",
    description: desc(
      "seed inbox ack <id> [--result done|deferred|ignored]",
      "Close out a mention with an explicit result. Use `done` when handled, `deferred` with `deferred_until` when you'll revisit, and `ignored` with `note` when consciously skipping.",
    ),
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
        url: { type: "string", description: "Explicit Seedrop Space daemon URL." },
        passport: { type: "string", description: "Explicit passport path." },
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
      pushClientFlags(cmd, args);
      return exec(cmd);
    },
  },
  {
    name: "seedrop_task_create",
    description: desc("seed task create --title <title> [--dedup-key <key>]", "Create a repo-local task. Use dedup_key for idempotent cross-agent task creation."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        from_knowledge: { type: "string" },
        blocked_by: { type: "array", items: { type: "string" } },
        dedup_key: { type: "string", description: "Opaque idempotency key. Same key + same title returns the existing task." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async handler(args) {
      const title = strArg(args, "title");
      if (!title) return error("title is required");
      const cmd = ["task", "create", "--title", title];
      pushStringFlag(cmd, args, "description", "--description");
      pushStringFlag(cmd, args, "from_knowledge", "--from-knowledge");
      pushStringFlag(cmd, args, "dedup_key", "--dedup-key");
      for (const blocker of strArrayArg(args, "blocked_by")) cmd.push("--blocked-by", blocker);
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_claim",
    description: desc("seed task claim <id>", "Claim an open repo-local task for the active agent."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      return exec(["task", "claim", taskId], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_assign",
    description: desc("seed task assign <id> <agent> [--note <text>]", "Assign a repo-local task to another agent."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" }, to: { type: "string" }, note: { type: "string" } },
      required: ["task_id", "to"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      const to = strArg(args, "to");
      if (!taskId || !to) return error("task_id and to are required");
      const cmd = ["task", "assign", taskId, to];
      pushStringFlag(cmd, args, "note", "--note");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_accept",
    description: desc("seed task accept <id>", "Accept a task assigned to the active agent."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      return exec(["task", "accept", taskId], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_decline",
    description: desc("seed task decline <id> [--reason <text>]", "Decline a task assigned to the active agent and return it to open."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" }, reason: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      const cmd = ["task", "decline", taskId];
      pushStringFlag(cmd, args, "reason", "--reason");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_start",
    description: desc("seed task start <id>", "Mark a claimed task as in_progress."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      return exec(["task", "start", taskId], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_pause",
    description: desc("seed task pause <id> [--status blocked|open]", "Pause an in-progress task as blocked or reopen it."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" }, status: { type: "string", enum: ["blocked", "open"] } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      const cmd = ["task", "pause", taskId];
      pushStringFlag(cmd, args, "status", "--status");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_done",
    description: desc("seed task done <id>", "Mark a task done after its blockers and ownership checks pass."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      return exec(["task", "done", taskId], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_drop",
    description: desc("seed task drop <id> [--reason <text>]", "Drop a task as consciously abandoned or superseded."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" }, reason: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      const cmd = ["task", "drop", taskId];
      pushStringFlag(cmd, args, "reason", "--reason");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_list",
    description: desc("seed task list --json [--status <status>] [--owner <agent>]", "List repo-local tasks as JSON, with optional status/owner/knowledge filters."),
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        status: { type: "string", enum: ["open", "claimed", "in_progress", "blocked", "done", "dropped"] },
        owner: { type: "string" },
        from_knowledge: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cmd = ["task", "list", "--json"];
      pushStringFlag(cmd, args, "status", "--status");
      pushStringFlag(cmd, args, "owner", "--owner");
      pushStringFlag(cmd, args, "from_knowledge", "--from-knowledge");
      return exec(cmd, strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_task_show",
    description: desc("seed task show <id>", "Read one repo-local task as JSON."),
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" }, task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    async handler(args) {
      const taskId = strArg(args, "task_id");
      if (!taskId) return error("task_id is required");
      return exec(["task", "show", taskId], strArg(args, "cwd"));
    },
  },
  {
    name: "seedrop_daemon_status",
    description: desc("seed daemon status", "Report whether the always-on Seedrop Space daemon is loaded and running."),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler() {
      return exec(["daemon", "status"]);
    },
  },
];

function buildSeedropIndex(): Record<string, Array<{ tool: string; use_when: string; example: Record<string, unknown> }>> {
  return {
    orient: [
      { tool: "seedrop_index", use_when: "Discover Seedrop MCP tools grouped by intent.", example: {} },
      { tool: "seedrop_manual", use_when: "Load the Seedrop concepts and workflow guide once per session.", example: { section: "workflows" } },
      { tool: "seedrop_boot", use_when: "Start a stateless-agent session and get the canonical Situation packet plus single safest next action.", example: { cwd: "/path/to/repo", json: true, peek: true } },
      { tool: "seedrop_continuity", use_when: "Start a Seedrop-aware session or answer 'where was I?'.", example: { cwd: "/path/to/repo", messages: 5 } },
      { tool: "seedrop_bootstrap", use_when: "Create first passport or link the current repo View.", example: { cwd: "/path/to/repo" } },
    ],
    view: [
      { tool: "seedrop_view_context", use_when: "Read full repo View state, active runs, tasks, signals, and open threads.", example: { cwd: "/path/to/repo" } },
      { tool: "seedrop_view_brief", use_when: "Read the compact stable repo orientation packet.", example: { cwd: "/path/to/repo" } },
      { tool: "seedrop_view_preflight", use_when: "Check whether it is safe to start or continue repo work.", example: { cwd: "/path/to/repo" } },
      { tool: "seedrop_view_sync", use_when: "Refresh the View manifest after file changes or drift.", example: { cwd: "/path/to/repo" } },
      { tool: "seedrop_view_audit", use_when: "Run deep View validation for manifest drift and expired signals.", example: { cwd: "/path/to/repo" } },
      { tool: "seedrop_view_explain", use_when: "Explain View success criteria or why a path is not represented.", example: { cwd: "/path/to/repo", topic: "success" } },
      { tool: "seedrop_diff", use_when: "Inspect View changes since last-session, earliest, or an ISO timestamp.", example: { cwd: "/path/to/repo", since: "last-session" } },
      { tool: "seedrop_view_log", use_when: "Leave a durable continuity packet after meaningful work.", example: { cwd: "/path/to/repo", mission: "Ship fix", summary: "Changed X and validated Y" } },
    ],
    run: [
      { tool: "seedrop_run_start", use_when: "Start or attach to a repo-local run journal for meaningful work.", example: { cwd: "/path/to/repo", goal: "Implement task" } },
      { tool: "seedrop_run_log", use_when: "Record progress and changed paths on the active run.", example: { cwd: "/path/to/repo", summary: "Implemented parser", changed_paths: ["src/parser.ts"] } },
      { tool: "seedrop_run_verify", use_when: "Record validation evidence for the active run.", example: { cwd: "/path/to/repo", command: "npm test", status: "passed" } },
      { tool: "seedrop_run_decision", use_when: "Record a decision on the active run journal.", example: { cwd: "/path/to/repo", decision: "Use MCP wrapper parity for this command" } },
      { tool: "seedrop_run_thread", use_when: "Record an open thread on the active run journal.", example: { cwd: "/path/to/repo", thread: "Confirm CLI parity after daemon restart" } },
      { tool: "seedrop_run_finish", use_when: "Close the active run as completed, blocked, or failed.", example: { cwd: "/path/to/repo", status: "completed" } },
    ],
    task: [
      { tool: "seedrop_task_create", use_when: "Create an idempotent repo-local task.", example: { cwd: "/path/to/repo", title: "Implement feature", dedup_key: "sprint-1:feature" } },
      { tool: "seedrop_task_claim", use_when: "Claim an open task for the active agent.", example: { cwd: "/path/to/repo", task_id: "abcd1234" } },
      { tool: "seedrop_task_assign", use_when: "Assign a task to another agent.", example: { cwd: "/path/to/repo", task_id: "abcd1234", to: "claude" } },
      { tool: "seedrop_task_accept", use_when: "Accept a task assigned to the active agent.", example: { cwd: "/path/to/repo", task_id: "abcd1234" } },
      { tool: "seedrop_task_decline", use_when: "Decline an assigned task and return it to open.", example: { cwd: "/path/to/repo", task_id: "abcd1234", reason: "not my area" } },
      { tool: "seedrop_task_start", use_when: "Mark a claimed task in progress.", example: { cwd: "/path/to/repo", task_id: "abcd1234" } },
      { tool: "seedrop_task_pause", use_when: "Pause or reopen a task.", example: { cwd: "/path/to/repo", task_id: "abcd1234", status: "blocked" } },
      { tool: "seedrop_task_done", use_when: "Mark a task done.", example: { cwd: "/path/to/repo", task_id: "abcd1234" } },
      { tool: "seedrop_task_drop", use_when: "Drop a task as superseded or abandoned.", example: { cwd: "/path/to/repo", task_id: "abcd1234", reason: "duplicate" } },
      { tool: "seedrop_task_list", use_when: "List tasks with optional filters.", example: { cwd: "/path/to/repo", status: "open" } },
      { tool: "seedrop_task_show", use_when: "Read a task by id or prefix.", example: { cwd: "/path/to/repo", task_id: "abcd1234" } },
    ],
    signal: [
      { tool: "seedrop_signal_claim", use_when: "Create an advisory claim signal for a target.", example: { cwd: "/path/to/repo", target: "mcp/src/tools.ts", intent: "edit MCP wrappers" } },
      { tool: "seedrop_signal_lock", use_when: "Create an advisory lock signal for exclusive target work.", example: { cwd: "/path/to/repo", target: "mcp/src/tools.ts", intent: "avoid conflicting edits" } },
      { tool: "seedrop_signal_list", use_when: "List current signal leases.", example: { cwd: "/path/to/repo" } },
      { tool: "seedrop_signal_release", use_when: "Release signal leases by id, target, owner, or type.", example: { cwd: "/path/to/repo", target: "mcp/src/tools.ts" } },
    ],
    handoff: [
      { tool: "seedrop_handoff_create", use_when: "Create a durable handoff for another agent or human.", example: { cwd: "/path/to/repo", to: "claude", summary: "Continue from X" } },
      { tool: "seedrop_handoff_list", use_when: "List repo-local handoff artifacts.", example: { cwd: "/path/to/repo" } },
      { tool: "seedrop_handoff_read", use_when: "Read one handoff artifact.", example: { cwd: "/path/to/repo", id: "handoff-id" } },
      { tool: "seedrop_handoff_accept", use_when: "Mark a handoff accepted without deleting it.", example: { cwd: "/path/to/repo", id: "handoff-id" } },
    ],
    space: [
      { tool: "seedrop_space_join", use_when: "Open or join a durable coordination Space.", example: { space: "seedrop-team" } },
      { tool: "seedrop_space_post", use_when: "Post a coordination message to a Space.", example: { space: "seedrop-team", content: "status update" } },
      { tool: "seedrop_space_messages", use_when: "Read recent durable messages from a Space.", example: { space: "seedrop-team" } },
      { tool: "seedrop_space_register", use_when: "Register live presence for this agent session.", example: { working_on: "Implementing MCP tools" } },
      { tool: "seedrop_space_heartbeat", use_when: "Refresh live presence after registering.", example: { working_on: "Still validating" } },
      { tool: "seedrop_space_presence", use_when: "List currently live sessions.", example: {} },
      { tool: "seedrop_inbox", use_when: "Read mentions addressed to this passport.", example: { limit: 10 } },
      { tool: "seedrop_inbox_ack", use_when: "Close a mention with done, deferred, or ignored semantics.", example: { item_id: "mention-id", result: "done" } },
    ],
    daemon: [
      { tool: "seedrop_daemon_status", use_when: "Check launchd daemon status when HTTP or continuity disagree.", example: {} },
    ],
  };
}
