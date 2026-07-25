/**
 * The Seedrop capability map: the single, test-guaranteed source of truth for
 * what the `seed` CLI can do and which commands have an MCP-tool equivalent.
 *
 * `mcp/src/coverage.ts` re-exports these so the MCP coverage tests keep the map
 * complete and accurate (every command has a policy entry; every exposed MCP
 * tool maps back to one). Because that contract is enforced in CI, surfacing
 * this map to agents — via `seed capabilities` / `seedrop_capabilities` — gives
 * a full-capabilities-at-a-glance view that cannot silently drift from reality.
 */

export type CliCoverageStatus = "covered" | "partial" | "cli_only" | "todo" | "mcp_only";

export interface CliCommandCoverage {
  command: string;
  status: CliCoverageStatus;
  tools?: string[];
  reason: string;
}

export interface DeprecatedCapabilityAlias {
  alias: string;
  replacement: string;
  reason: string;
}

export const CLI_COMMAND_SURFACE = [
  "seed",
  "seed boot",
  "seed bench",
  "seed bootstrap",
  "seed capabilities",
  "seed clients scan",
  "seed continuity",
  "seed daemon install",
  "seed daemon status",
  "seed daemon uninstall",
  "seed diff",
  "seed doctor",
  "seed focus",
  "seed id <command>",
  "seed id list",
  "seed inbox",
  "seed inbox ack",
  "seed init",
  "seed install",
  "seed login",
  "seed logout",
  "seed manual",
  "seed migrate-acorn",
  "seed print-boot-protocol",
  "seed run decision",
  "seed run finish",
  "seed run log",
  "seed run start",
  "seed run thread",
  "seed run verify",
  "seed space ack",
  "seed space end",
  "seed space heartbeat",
  "seed space inbox",
  "seed space inbox-ack",
  "seed space join",
  "seed space messages",
  "seed space notifications",
  "seed space notify",
  "seed space post",
  "seed space presence",
  "seed space register",
  "seed space serve",
  "seed task accept",
  "seed task assign",
  "seed task claim",
  "seed task create",
  "seed task decline",
  "seed task done",
  "seed task drop",
  "seed task list",
  "seed task pause",
  "seed task show",
  "seed task start",
  "seed view audit",
  "seed view brief",
  "seed view claim",
  "seed view context",
  "seed view explain",
  "seed view init",
  "seed view lock",
  "seed view log",
  "seed view preflight",
  "seed view release",
  "seed view signals",
  "seed view sync",
  "seed whoami",
] as const;

export const MCP_ONLY_COMMANDS = ["MCP-only: seedrop_index"] as const;

export const DEPRECATED_CAPABILITY_ALIASES: DeprecatedCapabilityAlias[] = [
  {
    alias: "seedrop_continuity",
    replacement: "seedrop_boot",
    reason: "ADR 0001 made the Situation boot packet the canonical MCP cold-start surface; `seed continuity` remains CLI-only for humans.",
  },
  {
    alias: "seedrop_view_brief",
    replacement: "seedrop_focus or seedrop_view_context",
    reason: "The brief tier collapsed into cheap mission focus plus full budgeted View context.",
  },
];

export const MCP_CLI_COVERAGE: CliCommandCoverage[] = [
  { command: "MCP-only: seedrop_index", status: "mcp_only", tools: ["seedrop_index"], reason: "Local MCP catalog for routing tool choice; no CLI equivalent by design." },
  { command: "seed", status: "covered", tools: ["seedrop_boot"], reason: "Bare seed now renders the Situation brief, and MCP exposes the same Situation packet directly." },
  { command: "seed bench", status: "cli_only", reason: "Bench starts a local read-only workbench server and is an operator-facing desktop/browser surface." },
  { command: "seed boot", status: "covered", tools: ["seedrop_boot"], reason: "Boot is wrapped with Situation JSON, messages, passport/url, peek, and since options." },
  { command: "seed bootstrap", status: "covered", tools: ["seedrop_bootstrap"], reason: "Setup/link flow is wrapped with agent, autonomous, passport, identity, and space-root flags." },
  { command: "seed capabilities", status: "covered", tools: ["seedrop_capabilities"], reason: "Full capability map (command -> MCP tool -> status) is exposed for at-a-glance agent orientation." },
  { command: "seed clients scan", status: "cli_only", reason: "Local client inventory is an operator/admin workflow." },
  { command: "seed continuity", status: "cli_only", tools: [], reason: "ADR 0001 orientation tiers: seedrop_boot is the canonical MCP cold-start surface; the continuity render stays CLI for humans." },
  { command: "seed daemon install", status: "cli_only", reason: "Launchd installation mutates host configuration and should stay operator-controlled." },
  { command: "seed daemon status", status: "covered", tools: ["seedrop_daemon_status"], reason: "Daemon status is exposed directly." },
  { command: "seed daemon uninstall", status: "cli_only", reason: "Launchd removal mutates host configuration and should stay operator-controlled." },
  { command: "seed diff", status: "covered", tools: ["seedrop_diff"], reason: "View diff is wrapped with optional since support." },
  { command: "seed doctor", status: "cli_only", reason: "Local setup diagnosis and fixes are operator/admin workflows." },
  { command: "seed focus", status: "covered", tools: ["seedrop_focus"], reason: "Focus pre-flight is wrapped with json/passport/url; always peeks (never advances the watermark)." },
  { command: "seed id <command>", status: "cli_only", reason: "Passport mutation/repair is identity administration, not repo coordination." },
  { command: "seed id list", status: "cli_only", reason: "Identity inventory is an operator/admin workflow." },
  { command: "seed inbox", status: "covered", tools: ["seedrop_inbox"], reason: "Inbox read is wrapped with explicit url/passport support." },
  { command: "seed inbox ack", status: "covered", tools: ["seedrop_inbox_ack"], reason: "Inbox ack is wrapped with result, note, deferred-until, and explicit url/passport support." },
  { command: "seed init", status: "cli_only", reason: "Guided local machine setup remains an operator workflow." },
  { command: "seed install", status: "cli_only", reason: "Client config installation mutates host/application configuration." },
  { command: "seed login", status: "cli_only", reason: "Shell identity switching is intentionally local CLI state." },
  { command: "seed logout", status: "cli_only", reason: "Shell identity switching is intentionally local CLI state." },
  { command: "seed manual", status: "covered", tools: ["seedrop_manual"], reason: "Manual sections are exposed directly." },
  { command: "seed migrate-acorn", status: "cli_only", reason: "Legacy AcornKit migration is operator-controlled and not part of normal MCP flow." },
  { command: "seed print-boot-protocol", status: "cli_only", reason: "Static protocol text is CLI documentation rather than live coordination state." },
  { command: "seed run decision", status: "covered", tools: ["seedrop_run_decision"], reason: "Run decision is exposed directly." },
  { command: "seed run finish", status: "covered", tools: ["seedrop_run_finish"], reason: "Run finish is wrapped with status, force, run-id, and handoff-to support (handoffs are assigned tasks per ADR 0001)." },
  { command: "seed run log", status: "covered", tools: ["seedrop_run_log"], reason: "Run log is wrapped with summary, changed paths, and explicit run-id support." },
  { command: "seed run start", status: "covered", tools: ["seedrop_run_start"], reason: "Run start is wrapped with goal, new, task, claim, and force support." },
  { command: "seed run thread", status: "covered", tools: ["seedrop_run_thread"], reason: "Run thread is exposed directly." },
  { command: "seed run verify", status: "covered", tools: ["seedrop_run_verify"], reason: "Run verify is wrapped with command, status, notes, and explicit run-id support." },
  { command: "seed space ack", status: "cli_only", reason: "Pointer-notification ack is not yet part of the MCP coordination surface." },
  { command: "seed space end", status: "cli_only", reason: "Ending a shared Space is intentionally left to CLI/admin use for now." },
  { command: "seed space heartbeat", status: "covered", tools: ["seedrop_space_heartbeat"], reason: "Heartbeat is wrapped with working-on plus explicit url/passport support." },
  { command: "seed space inbox", status: "covered", tools: ["seedrop_inbox"], reason: "Space inbox maps to the top-level inbox MCP tool with url/passport support." },
  { command: "seed space inbox-ack", status: "covered", tools: ["seedrop_inbox_ack"], reason: "Space inbox ack maps to the top-level inbox ack MCP tool with url/passport support." },
  { command: "seed space join", status: "covered", tools: ["seedrop_space_join"], reason: "Space join is wrapped with explicit url/passport support." },
  { command: "seed space messages", status: "covered", tools: ["seedrop_space_messages"], reason: "Space messages is wrapped with explicit url/passport support." },
  { command: "seed space notifications", status: "cli_only", reason: "Pointer notifications are not yet part of the MCP coordination surface." },
  { command: "seed space notify", status: "cli_only", reason: "Pointer notifications are not yet part of the MCP coordination surface." },
  { command: "seed space post", status: "covered", tools: ["seedrop_space_post"], reason: "Space post is wrapped with role plus explicit url/passport support." },
  { command: "seed space presence", status: "covered", tools: ["seedrop_space_presence"], reason: "Presence is wrapped with space-id, ttl, filter-passport, and explicit url/passport support." },
  { command: "seed space register", status: "covered", tools: ["seedrop_space_register"], reason: "Register is wrapped with working-on, space-id, and explicit url/passport support." },
  { command: "seed space serve", status: "cli_only", reason: "Starting an HTTP daemon/server is an operator/admin workflow." },
  { command: "seed task accept", status: "covered", tools: ["seedrop_task_accept"], reason: "Task accept is exposed directly through the MCP task surface." },
  { command: "seed task assign", status: "covered", tools: ["seedrop_task_assign"], reason: "Task assign is exposed directly through the MCP task surface." },
  { command: "seed task claim", status: "covered", tools: ["seedrop_task_claim"], reason: "Task claim is exposed directly through the MCP task surface." },
  { command: "seed task create", status: "covered", tools: ["seedrop_task_create"], reason: "Task create is exposed with title, description, blockers, knowledge source, and dedup-key support." },
  { command: "seed task decline", status: "covered", tools: ["seedrop_task_decline"], reason: "Task decline is exposed directly through the MCP task surface." },
  { command: "seed task done", status: "covered", tools: ["seedrop_task_done"], reason: "Task done is exposed directly through the MCP task surface." },
  { command: "seed task drop", status: "covered", tools: ["seedrop_task_drop"], reason: "Task drop is exposed directly through the MCP task surface." },
  { command: "seed task list", status: "covered", tools: ["seedrop_task_list"], reason: "Task list is exposed with JSON output and common filters." },
  { command: "seed task pause", status: "covered", tools: ["seedrop_task_pause"], reason: "Task pause is exposed with blocked/open status support." },
  { command: "seed task show", status: "covered", tools: ["seedrop_task_show"], reason: "Task show is exposed directly through the MCP task surface." },
  { command: "seed task start", status: "covered", tools: ["seedrop_task_start"], reason: "Task start is exposed directly through the MCP task surface." },
  { command: "seed view audit", status: "covered", tools: ["seedrop_view_audit"], reason: "View audit is exposed directly." },
  { command: "seed view brief", status: "cli_only", tools: [], reason: "ADR 0001 orientation tiers: focus (cheap) and budgeted view context (deep) cover the brief's MCP role." },
  { command: "seed view claim", status: "covered", tools: ["seedrop_signal_claim"], reason: "Signal leases are exposed with type claim|lock support." },
  { command: "seed view context", status: "covered", tools: ["seedrop_view_context"], reason: "View context is exposed directly." },
  { command: "seed view explain", status: "covered", tools: ["seedrop_view_explain"], reason: "View explain is exposed with topic support." },
  { command: "seed view init", status: "cli_only", reason: "View initialization also links identity project state and remains CLI setup." },
  { command: "seed view lock", status: "cli_only", tools: [], reason: "ADR 0001: seedrop_signal_claim carries type=lock; the CLI verb stays for shell agents." },
  { command: "seed view log", status: "covered", tools: ["seedrop_view_log"], reason: "Continuity packets are wrapped with decisions, assumptions, threads, changed paths, and validation notes." },
  { command: "seed view preflight", status: "covered", tools: ["seedrop_view_preflight"], reason: "View preflight is exposed directly." },
  { command: "seed view release", status: "covered", tools: ["seedrop_signal_release"], reason: "Signal release is exposed by id, target, owner, or type." },
  { command: "seed view signals", status: "covered", tools: ["seedrop_signal_list"], reason: "Signal list is exposed directly." },
  { command: "seed view sync", status: "covered", tools: ["seedrop_view_sync"], reason: "View sync is exposed with workspace-id support." },
  { command: "seed whoami", status: "cli_only", reason: "Local shell identity inspection is intentionally CLI-only." },
];

const DOMAINS = ["bench", "view", "run", "task", "space", "daemon", "inbox", "id"] as const;
const GROUP_ORDER = ["core", ...DOMAINS] as const;

function domainOf(command: string): string {
  if (command.startsWith("MCP-only:")) return "core";
  const second = command.split(" ")[1] ?? "core";
  return (DOMAINS as readonly string[]).includes(second) ? second : "core";
}

export interface CapabilityEntry {
  command: string;
  tool: string | null;
  status: CliCoverageStatus;
  reason: string;
}

export interface CapabilityCatalog {
  /** All entries in the map (CLI commands + the one MCP-only catalog tool). */
  total: number;
  /** CLI commands (everything except the MCP-only entries). */
  cli_commands: number;
  /** CLI commands that ALSO have an MCP tool (covered/partial). */
  via_mcp: number;
  /** CLI commands with no MCP equivalent. */
  cli_only: number;
  /** Tools exposed only over MCP, with no CLI command (e.g. seedrop_index). */
  mcp_only: number;
  /** Removed/deprecated tool aliases and the current command/tool to use instead. */
  deprecated_aliases: DeprecatedCapabilityAlias[];
  groups: Record<string, CapabilityEntry[]>;
}

/** Structured capability catalog grouped by domain — the `--json` surface. */
export function buildCapabilities(): CapabilityCatalog {
  const groups: Record<string, CapabilityEntry[]> = {};
  let viaMcp = 0;
  let cliOnly = 0;
  let mcpOnly = 0;
  for (const entry of MCP_CLI_COVERAGE) {
    const tool = entry.tools?.[0] ?? null;
    if (entry.status === "mcp_only") mcpOnly += 1;
    else if (entry.status === "cli_only") cliOnly += 1;
    else if (tool) viaMcp += 1;
    const group = domainOf(entry.command);
    (groups[group] ??= []).push({ command: entry.command, tool, status: entry.status, reason: entry.reason });
  }
  return {
    total: MCP_CLI_COVERAGE.length,
    cli_commands: MCP_CLI_COVERAGE.length - mcpOnly,
    via_mcp: viaMcp,
    cli_only: cliOnly,
    mcp_only: mcpOnly,
    deprecated_aliases: DEPRECATED_CAPABILITY_ALIASES,
    groups,
  };
}

function toolCell(entry: CapabilityEntry): string {
  if (entry.tool && entry.status !== "cli_only") return `-> ${entry.tool}`;
  if (entry.status === "cli_only") return "(CLI only)";
  if (entry.status === "mcp_only") return "(MCP only)";
  return "-";
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** Human at-a-glance render of the full capability surface, grouped by domain. */
export function renderCapabilities(catalog: CapabilityCatalog = buildCapabilities()): string {
  const lines: string[] = [
    `Seedrop capabilities — ${catalog.cli_commands} CLI commands (${catalog.via_mcp} also via MCP, ${catalog.cli_only} CLI-only) + ${catalog.mcp_only} MCP-only tool`,
    "",
  ];
  for (const group of GROUP_ORDER) {
    const entries = catalog.groups[group];
    if (!entries || entries.length === 0) continue;
    lines.push(group.toUpperCase());
    const cmdWidth = Math.min(28, Math.max(...entries.map((entry) => entry.command.length)) + 1);
    for (const entry of entries) {
      const cmd = entry.command.padEnd(cmdWidth);
      const tool = toolCell(entry).padEnd(30);
      lines.push(`  ${cmd}${tool}${truncate(entry.reason, 64)}`);
    }
    lines.push("");
  }
  if (catalog.deprecated_aliases.length > 0) {
    lines.push("DEPRECATED ALIASES");
    for (const alias of catalog.deprecated_aliases) {
      lines.push(`  ${alias.alias} -> ${alias.replacement}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
