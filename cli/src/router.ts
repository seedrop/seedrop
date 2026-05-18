import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readActivePassportSync, readActivePassport, writeActivePassport, clearActivePassport } from "./active-passport.js";
import {
  buildMcpServerEntry,
  clientHasSeedConfig,
  configuredPassport,
  detectClients,
  installClientConfig,
  loadClientRegistry,
  loadClientRegistryWithDiagnostics,
  operatorPassportAllowed,
  renderManualInstall,
  resolveClientDefinition,
  userClientsPath,
  verificationStatus,
  type McpServerCommand,
  type ClientDefinition,
  type ResolvedClientDefinition,
  upsertTomlServer,
} from "./clients.js";
import { runContinuity } from "./continuity.js";
import { seedError, renderCliError } from "./errors.js";
import { runMigrateAcorn, failClosedIfUnmigrated } from "./migrate-acorn.js";

const DEFAULT_SPACE_PORT = 18791;
const DEFAULT_SPACE_URL = `http://127.0.0.1:${DEFAULT_SPACE_PORT}`;

export function defaultSpaceUrl(): string {
  return process.env.SEEDROP_SPACE_URL?.trim() || DEFAULT_SPACE_URL;
}

const DAEMON_LABEL = "com.seedrop.daemon";
const DOCTOR_SCHEMA_VERSION = "1.0";
const SETUP_SCHEMA_VERSION = "1.0";
const SETUP_STEP_IDS = [
  "operator_passport",
  "detect_clients",
  "agent_passports",
  "client_configs",
  "daemon_install",
  "boot_protocol",
] as const;

type SetupStepId = (typeof SETUP_STEP_IDS)[number];
type SetupStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";
type SetupStatus = "in_progress" | "completed" | "failed";

interface SetupJournalStep {
  id: SetupStepId;
  status: SetupStepStatus;
  summary: string;
  output_path?: string;
  next_command?: string;
  error: string | null;
}

interface SetupJournal {
  schema_version: "1.0";
  setup_id: string;
  started_at: string;
  updated_at: string;
  status: SetupStatus;
  steps: SetupJournalStep[];
}

interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "warn";
  summary: string;
  details: Record<string, unknown>;
  next_command: string | null;
  docs_url: string | null;
}

interface ClientScanRow {
  id: string;
  label: string;
  status: "detected" | "not_found" | "unsupported";
  config_path: string | null;
  wired: boolean;
  passport: string | null;
  default_agent: string;
  verification: string;
  next_command: string | null;
}

interface SpaceHealthResponse {
  schema_version?: string;
  ok?: boolean;
  registered_passports?: Array<{ passport_id?: string; agent_id?: string; path?: string }>;
  known_agent_ids?: string[];
  [key: string]: unknown;
}

function launchAgentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
}

export function defaultPassportPath(): string {
  // Resolution order:
  //   1. $SEEDROP_PASSPORT (per-process override; MCP server config sets this)
  //   2. ~/.seedrop/state/active-passport.json (shell login)
  //   3. ~/.seedrop/id/passport.json (operator default)
  const envPath = process.env.SEEDROP_PASSPORT?.trim();
  if (envPath) return envPath;
  const active = readActivePassportSync();
  if (active) return active.passport_path;
  return join(homedir(), ".seedrop", "id", "passport.json");
}

export function defaultSpaceRoot(): string {
  const envPath = process.env.SEEDROP_SPACE_ROOT?.trim();
  if (envPath) return envPath;
  return join(homedir(), ".seedrop", "space");
}

function operatorPassportPath(): string {
  return join(homedir(), ".seedrop", "id", "passport.json");
}

function setupJournalPath(): string {
  return join(homedir(), ".seedrop", "state", "setup.json");
}

export function agentPassportPath(agent: string): string {
  const slug = agent.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || agent;
  return join(homedir(), ".seedrop", "id", "agents", `${slug}.json`);
}

async function runLogin(argv: readonly string[], io: RunCliIO): Promise<number> {
  // Accept either an agent name or path: `seed login codex` or `seed login --passport /path.json`
  const json = argv.includes("--json");
  const explicit = flagValue(argv, "passport");
  const positional = argv.find((a) => !a.startsWith("--") && a.length > 0);
  const target = explicit ?? (positional ? agentPassportPath(positional) : null);
  if (!target) {
    writeCliFailure(io, json, "seedrop.validation.failed", "Usage: seed login <agent>", "validation", "seed login <agent>", {
      usage: "seed login <agent> (or --passport <absolute path>)",
    });
    return 1;
  }
  if (!existsSync(target)) {
    writeCliFailure(
      io,
      json,
      "seedrop.passport.missing",
      `No passport at ${target}.`,
      "config",
      `seed bootstrap --as ${positional ?? "<agent>"} --name <name> --purpose "<mission>"`,
      { path: target },
    );
    return 1;
  }
  const passport = await safeReadPassport(target);
  if (!passport?.agent_id) {
    writeCliFailure(io, json, "seedrop.passport.invalid", `Passport at ${target} is missing agent_id.`, "validation", null, { path: target });
    return 1;
  }
  await writeActivePassport({
    agent_id: passport.agent_id,
    passport_path: target,
    set_at: new Date().toISOString(),
  });
  io.stdout.write(`identity ready: ${passport.agent_id}\n`);
  io.stdout.write(`passport: ${target}\n`);
  io.stdout.write(`${formatRepoViewStatus(process.cwd())}\n`);
  io.stdout.write(
    `\nNote: this affects future \`seed …\` calls in this and other shells.\n` +
      `MCP-launched agents (Claude Code, Codex CLI) read passport from their MCP config — use \`seed install <agent> --to <client>\` to set those.\n`,
  );
  return 0;
}

function formatRepoViewStatus(cwd: string): string {
  if (sameDirectory(cwd, homedir())) {
    return "repo view: skipped (cwd is $HOME; run `seed bootstrap` from a repo to create `.seedrop/view/`)";
  }
  const viewPath = join(cwd, ".seedrop", "view");
  if (existsSync(viewPath)) {
    return `repo view: present (${viewPath})`;
  }
  return "repo view: absent (run `seed bootstrap` here to link this repo)";
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

async function runLogout(io: RunCliIO): Promise<number> {
  const removed = await clearActivePassport();
  if (removed) {
    io.stdout.write(`logged out; falling back to operator passport at ${defaultPassportPath()}\n`);
  } else {
    io.stdout.write(`already logged out (no active-passport state)\n`);
  }
  return 0;
}

async function runWhoami(io: RunCliIO): Promise<number> {
  const envPath = process.env.SEEDROP_PASSPORT?.trim();
  const active = await readActivePassport();
  let source: string;
  let path: string;
  if (envPath) {
    source = "$SEEDROP_PASSPORT";
    path = envPath;
  } else if (active) {
    source = "seed login";
    path = active.passport_path;
  } else {
    source = "operator default";
    path = join(homedir(), ".seedrop", "id", "passport.json");
  }
  if (!existsSync(path)) {
    io.stdout.write(`no passport at ${path} (source: ${source})\n`);
    io.stdout.write(`run \`seed bootstrap --name <you> --purpose "<mission>"\` to create one.\n`);
    return 0;
  }
  const passport = await safeReadPassport(path);
  const agent = passport?.agent_id ?? "?";
  const issuedBy = passport?.issued_by ? ` ← ${passport.issued_by}` : "";
  const auto = passport?.autonomous ? " [autonomous]" : "";
  io.stdout.write(`agent: ${agent}${issuedBy}${auto}\n`);
  io.stdout.write(`source: ${source}\n`);
  io.stdout.write(`passport: ${path}\n`);
  return 0;
}

async function runIdList(io: RunCliIO): Promise<number> {
  const operatorPath = defaultPassportPath();
  const lines: string[] = [];
  if (existsSync(operatorPath)) {
    const op = await safeReadPassport(operatorPath);
    lines.push(`operator: ${op?.agent_id ?? "?"} @ ${operatorPath}`);
  } else {
    lines.push(`operator: (none — run \`seed bootstrap --name <you> --purpose "<mission>"\`)`);
  }

  const agentsDir = join(homedir(), ".seedrop", "id", "agents");
  if (existsSync(agentsDir)) {
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(agentsDir)).filter((e) => e.endsWith(".json"));
    if (entries.length > 0) {
      lines.push("agents:");
      for (const entry of entries) {
        const path = join(agentsDir, entry);
        const p = await safeReadPassport(path);
        const issued = p?.issued_by ? ` ← ${p.issued_by}` : "";
        const auto = p?.autonomous ? " [autonomous]" : "";
        lines.push(`  - ${p?.agent_id ?? entry}${issued}${auto} @ ${path}`);
      }
    } else {
      lines.push("agents: (none)");
    }
  } else {
    lines.push("agents: (none — run `seed bootstrap --as <agent>` to create one)");
  }

  io.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function safeReadPassport(path: string): Promise<{ agent_id?: string; issued_by?: string; autonomous?: boolean } | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readOperatorAgentId(io: RunCliIO): Promise<string | undefined> {
  const operatorPath = operatorPassportPath();
  if (!existsSync(operatorPath)) return undefined;
  try {
    const raw = await readFile(operatorPath, "utf8");
    const parsed = JSON.parse(raw) as { agent_id?: string };
    return parsed.agent_id;
  } catch (error) {
    io.stderr.write(`warning: could not read operator passport at ${operatorPath}: ${String(error)}\n`);
    return undefined;
  }
}

export interface CommandDispatch {
  command: string;
  args: string[];
}

export interface RunCliIO {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CommandRunner {
  run(dispatch: CommandDispatch): Promise<number>;
}

export type CommandPlan = CommandDispatch | CommandDispatch[];

const usage = `Usage:
  seed                          (alias for \`seed continuity\` — your boot block)
  seed init                     (guided one-shot local setup)
  seed continuity [--json] [--messages N]
  seed doctor [--fix]           (diagnose local setup + exact next commands)
  seed bootstrap [--name <name>] [--purpose <purpose>] [--no-link]
  seed bootstrap --as <agent> --name <human-name> --purpose "<mission>"
  seed bootstrap --as <bot>   --autonomous --name <name> --purpose "..."
  seed login <agent>            (switch this shell's identity)
  seed logout                   (back to operator default)
  seed whoami                   (show active passport + source)
  seed clients scan [--json]    (inventory supported MCP clients)
  seed install <agent> --to <client>                  (wire MCP client config)
  seed install --all-detected                         (wire every detected client)
  seed install <agent> --manual                       (print JSON/TOML snippets)
  seed print-boot-protocol                            (print agent boot reflex)
  seed daemon <install|uninstall|status>
  seed id list                  (operator + all agent passports)
  seed id <command> [options]
  seed space <command> [options]
  seed view <command> [options]
  seed run <command> [options]
  seed handoff <command> [options]
  seed inbox [--unacked-only]   (mentions addressed to this passport)
  seed inbox ack <id> [--result done|deferred|ignored] [--note "..."]
  seed migrate-acorn [--remove-acorn] [--json]   (one-shot copy of ~/.acorn/ → ~/.seedrop/)

Examples:
  seed                          # who am I, where am I, what's next
  seed init                     # guided setup for this machine
  seed bootstrap --name mc --purpose "Operate seedrop"     # one-time, root principal
  seed bootstrap --as claude --name claude --purpose "..."  # add an agent under mc
  seed install codex --to codex-cli
  seed install --all-detected
  seed install kimi --manual
  seed id list
  seed view init
  seed run start --goal "..."
  seed handoff list --json
  seed space join seedrop-team
  seed space register --working-on "<what>"
  seed space heartbeat --working-on "<update>"

Defaults:
  Passport     $SEEDROP_PASSPORT or ~/.seedrop/id/passport.json
  Space root   $SEEDROP_SPACE_ROOT or ~/.seedrop/space
  Space URL    $SEEDROP_SPACE_URL or http://127.0.0.1:18791
`;

export function resolveCommand(argv: readonly string[]): CommandPlan | "help" | "init" | "doctor" | "bootstrap" | "daemon" | "continuity" | "id-list" | "login" | "logout" | "whoami" | "clients" | "install" | "boot-protocol" | "migrate-acorn" {
  const [domain, ...rest] = argv;

  if (!domain) {
    // Bare `seed` is the boot block when identity or repo View context is available.
    return existsSync(defaultPassportPath()) || existsSync(join(process.cwd(), ".seedrop", "view")) ? "continuity" : "help";
  }

  if (domain === "help" || domain === "--help" || domain === "-h") {
    return "help";
  }

  if (domain === "bootstrap") {
    // Bootstrap is orchestrated dynamically in runCli (filesystem checks).
    return "bootstrap";
  }

  if (domain === "daemon") {
    return "daemon";
  }

  if (domain === "init") return "init";
  if (domain === "doctor") return "doctor";
  if (domain === "print-boot-protocol") return "boot-protocol";

  if (domain === "continuity") {
    return "continuity";
  }

  if (domain === "login") return "login";
  if (domain === "logout") return "logout";
  if (domain === "whoami") return "whoami";
  if (domain === "clients") return "clients";
  if (domain === "install") return "install";
  if (domain === "migrate-acorn") return "migrate-acorn";

  if (domain === "id") {
    if (rest[0] === "list") {
      return "id-list";
    }
    return { command: "seed-id", args: normalizeIdArgs(rest) };
  }

  if (domain === "inbox") {
    // `seed inbox` → `seed-space inbox`
    // `seed inbox ack <id>` → `seed-space inbox-ack <id>`
    if (rest[0] === "ack") {
      return { command: "seed-space", args: ["inbox-ack", ...rest.slice(1)] };
    }
    return { command: "seed-space", args: ["inbox", ...rest] };
  }

  if (domain === "space") {
    return { command: "seed-space", args: [...rest] };
  }

  if (domain === "view") {
    return resolveViewCommand(rest);
  }

  if (domain === "run") {
    return { command: "seed-space", args: ["run", ...rest] };
  }

  if (domain === "handoff") {
    return { command: "seed-space", args: ["handoff", ...rest] };
  }

  if (domain === "task") {
    return { command: "seed-space", args: ["task", ...rest] };
  }

  if (domain === "diff") {
    return { command: "seed-space", args: ["diff", ...rest] };
  }

  if (domain === "manual") {
    return { command: "seed-space", args: ["manual", ...rest] };
  }

  throw new Error(`Unknown seed domain: ${domain}`);
}

export async function runCli(
  argv: readonly string[],
  io: RunCliIO = { stdout: process.stdout, stderr: process.stderr },
  runner: CommandRunner = spawnCommandRunner(),
): Promise<number> {
  try {
    const dispatch = resolveCommand(argv);
    if (dispatch === "help") {
      io.stdout.write(renderHelp());
      return 0;
    }
    if (dispatch === "bootstrap") {
      return await runBootstrap(argv.slice(1), io, runner);
    }
    if (dispatch === "init") {
      return await runInit(argv.slice(1), io, runner);
    }
    if (dispatch === "doctor") {
      return await runDoctor(argv.slice(1), io, runner);
    }
    if (dispatch === "boot-protocol") {
      io.stdout.write(renderBootProtocol());
      return 0;
    }
    if (dispatch === "daemon") {
      return await runDaemon(argv.slice(1), io);
    }
    if (dispatch === "continuity") {
      return await runContinuity(argv.slice(1), io, {
        defaultPassport: defaultPassportPath(),
        defaultUrl: defaultSpaceUrl(),
      });
    }
    if (dispatch === "id-list") {
      return await runIdList(io);
    }
    if (dispatch === "login") {
      return await runLogin(argv.slice(1), io);
    }
    if (dispatch === "logout") {
      return await runLogout(io);
    }
    if (dispatch === "whoami") {
      return await runWhoami(io);
    }
    if (dispatch === "clients") {
      return await runClients(argv.slice(1), io);
    }
    if (dispatch === "install") {
      return await runInstall(argv.slice(1), io, runner);
    }
    if (dispatch === "migrate-acorn") {
      return await runMigrateAcorn(argv.slice(1), io);
    }
    const plan = Array.isArray(dispatch) ? dispatch : [dispatch];
    for (const step of plan) {
      const code = await runner.run(step);
      if (code !== 0) return code;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wantsJson = argv.includes("--json");
    io.stderr.write(renderCliError(seedError({
      code: "seedrop.command.failed",
      message,
      class: classifyError(error),
      details: { argv },
    }), wantsJson));
    if (!wantsJson) io.stderr.write(`\n${usage}`);
    return 1;
  }
}

function classifyError(error: unknown): "config" | "validation" | "auth" | "not_found" | "conflict" | "io" | "internal" {
  const name = error instanceof Error ? error.name : "";
  if (name.includes("Validation") || name === "ZodError") return "validation";
  if (name.includes("Auth")) return "auth";
  if (name.includes("NotFound")) return "not_found";
  if (name.includes("Parse") || name.includes("IO") || name.includes("Delivery")) return "io";
  if (name.includes("Conflict")) return "conflict";
  if (name.includes("Config")) return "config";
  return "internal";
}

function renderHelp(): string {
  const operatorPath = operatorPassportPath();
  if (!existsSync(operatorPath)) {
    return [
      "You have not initialized Seedrop on this machine yet. Start with:",
      "  seed init",
      "",
      "Manual path:",
      "  seed bootstrap --name <you> --purpose \"<mission>\"",
      "",
      usage,
    ].join("\n");
  }
  const agentsDir = join(homedir(), ".seedrop", "id", "agents");
  if (!existsSync(agentsDir)) {
    return [
      "Seedrop has an operator passport. Next, wire an agent client:",
      "  seed init",
      "  seed install <agent> --manual",
      "",
      usage,
    ].join("\n");
  }
  return [
    "Seedrop is initialized. Useful next checks:",
    "  seed doctor",
    "  seed",
    "",
    usage,
  ].join("\n");
}

function writeCliFailure(
  io: RunCliIO,
  json: boolean,
  code: string,
  message: string,
  klass: "config" | "validation" | "auth" | "not_found" | "conflict" | "io" | "internal",
  nextCommand: string | null,
  details: Record<string, unknown> = {},
): void {
  io.stderr.write(renderCliError(seedError({
    code,
    message,
    class: klass,
    nextCommand: nextCommand ?? undefined,
    details,
  }), json));
}

async function runBootstrap(argv: readonly string[], io: RunCliIO, runner: CommandRunner): Promise<number> {
  const name = flagValue(argv, "name");
  const purpose = flagValue(argv, "purpose");
  const agentIdFlag = flagValue(argv, "agent-id");
  const asAgent = flagValue(argv, "as");
  const autonomous = argv.includes("--autonomous");
  const issuedByFlag = flagValue(argv, "issued-by");
  const explicitPassport = flagValue(argv, "passport");
  const spaceRoot = flagValue(argv, "space-root") ?? defaultSpaceRoot();
  const skipLink = argv.includes("--no-link");
  const role = flagValue(argv, "role");
  const currentFocus = flagValue(argv, "current-focus");

  // When `--as` is set, mint a per-agent passport under ~/.seedrop/id/agents/<agent>.json
  // Otherwise use the operator passport at ~/.seedrop/id/passport.json (or $SEEDROP_PASSPORT).
  let passportPath: string;
  let resolvedIssuedBy: string | undefined;
  let resolvedAgentId: string | undefined = agentIdFlag;
  if (asAgent) {
    passportPath = explicitPassport ?? agentPassportPath(asAgent);
    resolvedAgentId = agentIdFlag ?? asAgent;
    if (!autonomous) {
      resolvedIssuedBy = issuedByFlag ?? (await readOperatorAgentId(io));
      if (!resolvedIssuedBy) {
        io.stderr.write(
          `\`seed bootstrap --as ${asAgent}\` needs a parent operator passport.\n` +
            `Run \`seed bootstrap --name <you> --purpose "<mission>"\` first, or pass --autonomous.\n`,
        );
        return 1;
      }
    }
  } else {
    passportPath = explicitPassport ?? defaultPassportPath();
    if (issuedByFlag) resolvedIssuedBy = issuedByFlag;
  }

  await mkdir(dirname(passportPath), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });

  if (!existsSync(passportPath)) {
    if (!name || !purpose) {
      const hint = asAgent
        ? `Run with --name <human-name-for-${asAgent}> --purpose "<one-line mission>".`
        : `Re-run with --name <name> --purpose "<purpose>" to create one.`;
      io.stderr.write(`No passport at ${passportPath}. ${hint}\n`);
      return 1;
    }
    const initArgs = ["init", "--name", name, "--purpose", purpose, "--out", passportPath];
    if (resolvedAgentId) initArgs.push("--agent-id", resolvedAgentId);
    if (resolvedIssuedBy) initArgs.push("--issued-by", resolvedIssuedBy);
    if (autonomous) initArgs.push("--autonomous");
    const code = await runner.run({ command: "seed-id", args: initArgs });
    if (code !== 0) return code;
  } else {
    io.stdout.write(`passport: ${passportPath}\n`);
  }

  io.stdout.write(`space root: ${spaceRoot}\n`);

  if (!skipLink) {
    const cwd = process.cwd();
    if (cwd === homedir()) {
      io.stdout.write(`cwd is $HOME; skipping repo link (pass a repo dir or --no-link to silence)\n`);
    } else {
      const viewArgs = ["view", "init", "--passport", passportPath, "--root", cwd];
      if (role) viewArgs.push("--role", role);
      if (currentFocus) viewArgs.push("--current-focus", currentFocus);
      const viewPlan = resolveViewCommand(viewArgs.slice(1));
      const steps = Array.isArray(viewPlan) ? viewPlan : [viewPlan];
      for (const step of steps) {
        const code = await runner.run(step);
        if (code !== 0) return code;
      }
      io.stdout.write(`linked repo: ${cwd}\n`);
    }
  }

  return 0;
}

async function runClients(argv: readonly string[], io: RunCliIO): Promise<number> {
  const [sub] = argv;
  if (!sub || sub === "scan") {
    const rows = await scanClients();
    if (argv.includes("--json")) {
      io.stdout.write(`${JSON.stringify({ schema_version: "1.0", clients: rows }, null, 2)}\n`);
      return 0;
    }
    for (const row of rows) {
      const marker = row.status === "detected" ? (row.wired ? "✓" : "!") : row.status === "unsupported" ? "?" : "-";
      const wired = row.status === "detected" ? (row.wired ? "wired" : "not wired") : row.status;
      io.stdout.write(`${marker} ${row.id}\t${row.label}\t${wired}\t${row.verification}`);
      if (row.config_path) io.stdout.write(`\t${row.config_path}`);
      io.stdout.write("\n");
      if (row.next_command) io.stdout.write(`  → run: ${row.next_command}\n`);
    }
    return 0;
  }
  io.stderr.write(`Usage:\n  seed clients scan [--json]\n`);
  return 1;
}

async function scanClients(): Promise<ClientScanRow[]> {
  const registry = await loadClientRegistry(import.meta.url);
  const rows: ClientScanRow[] = [];
  for (const [id, def] of Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = resolveClientDefinition(id, def);
    const defaultAgent = def.default_agent ?? id;
    if (!resolved) {
      rows.push({
        id,
        label: def.label ?? id,
        status: "unsupported",
        config_path: null,
        wired: false,
        passport: null,
        default_agent: defaultAgent,
        verification: verificationStatus(def),
        next_command: `seed install ${defaultAgent} --manual`,
      });
      continue;
    }
    const configExists = existsSync(resolved.configPath);
    const wired = configExists ? await clientHasSeedConfig(resolved) : false;
    const passport = configExists ? await configuredPassport(resolved) : null;
    rows.push({
      id,
      label: resolved.label,
      status: configExists ? "detected" : "not_found",
      config_path: resolved.configPath,
      wired,
      passport,
      default_agent: defaultAgent,
      verification: verificationStatus(def),
      next_command: configExists && !wired
        ? `seed install ${defaultAgent} --to ${id}`
        : !configExists
          ? `seed install ${defaultAgent} --to ${id} --create-config`
          : null,
    });
  }
  return rows;
}

async function runInstall(argv: readonly string[], io: RunCliIO, runner: CommandRunner): Promise<number> {
  const json = argv.includes("--json");
  const positional = argv.find((a) => !a.startsWith("--") && a.length > 0);
  const client = flagValue(argv, "to");
  const customConfig = flagValue(argv, "config");
  const manual = argv.includes("--manual");
  const createConfig = argv.includes("--create-config");
  const listClients = argv.includes("--list-clients");
  const allDetected = argv.includes("--all-detected");
  const registry = await loadClientRegistry(import.meta.url);
  if (listClients) {
    await printClientList(registry, io);
    return 0;
  }
  if (allDetected) {
    return await installDetectedClients(registry, io, runner, { createConfig });
  }
  if (!positional || (!client && !manual)) {
    writeCliFailure(io, json, "seedrop.validation.failed", "Usage: seed install <agent> --to <client>", "validation", "seed install --all-detected", {
      known_clients: Object.keys(registry).sort(),
    });
    return 1;
  }
  const passportPath = agentPassportPath(positional);
  if (!existsSync(passportPath)) {
    writeCliFailure(
      io,
      json,
      "seedrop.passport.missing",
      `No passport at ${passportPath}.`,
      "config",
      `seed bootstrap --as ${positional} --name <name> --purpose "<mission>"`,
      { path: passportPath },
    );
    return 1;
  }

  const command = resolveMcpServerCommand();
  if (manual) {
    io.stdout.write(renderManualInstall(passportPath, command));
    return 0;
  }

  const clientDef = registry[client!];
  if (!clientDef) {
    writeCliFailure(io, json, "seedrop.client.unknown", `Unknown client: ${client}.`, "validation", `seed install ${positional} --manual`, {
      known_clients: Object.keys(registry).sort(),
    });
    return 1;
  }
  const resolved = resolveClientDefinition(client!, {
    ...clientDef,
    config: customConfig ?? clientDef.config,
  });
  if (!resolved) {
    writeCliFailure(io, json, "seedrop.client.unsupported_platform", `No config path for ${client} on ${platform()}.`, "config", `seed install ${positional} --manual`, {
      client,
      platform: platform(),
    });
    return 1;
  }

  try {
    await installClientConfig(resolved, buildMcpServerEntry(passportPath, command), { create: createConfig });
  } catch (error) {
    writeCliFailure(io, json, "seedrop.client.config_write_failed", (error as Error).message, "io", `seed install ${positional} --manual`, {
      client_id: resolved.id,
      config_path: resolved.configPath,
    });
    return 1;
  }

  io.stdout.write(`✓ wrote ${resolved.label} MCP config: ${resolved.configPath}\n`);
  io.stdout.write(`  ${resolved.section}.env.SEEDROP_PASSPORT = ${passportPath}\n`);
  if (resolved.restart) io.stdout.write(`\n${resolved.restart}\n`);
  return 0;
}

async function installDetectedClients(
  registry: Record<string, ClientDefinition>,
  io: RunCliIO,
  runner: CommandRunner,
  opts: { createConfig?: boolean } = {},
): Promise<number> {
  const detected = await detectClients(registry);
  if (detected.length === 0) {
    io.stdout.write(`No MCP client configs detected. Run \`seed clients scan\` or \`seed install <agent> --manual\`.\n`);
    return 1;
  }

  const command = resolveMcpServerCommand();
  let failures = 0;
  for (const client of detected) {
    const registryDef = registry[client.id]!;
    const agent = client.default_agent ?? client.id;
    const passportPath = agentPassportPath(agent);
    if (!existsSync(passportPath)) {
      const bootstrapArgs = ["--as", agent, "--name", agent, "--purpose", `Use Seedrop from ${client.label}`, "--no-link"];
      if (!existsSync(operatorPassportPath())) bootstrapArgs.push("--autonomous");
      const bootstrapCode = await runBootstrap(
        bootstrapArgs,
        io,
        runner,
      );
      if (bootstrapCode !== 0) {
        failures += 1;
        continue;
      }
    }
    try {
      await installClientConfig(client, buildMcpServerEntry(passportPath, command), { create: opts.createConfig });
      io.stdout.write(`✓ wired ${client.label} → ${agent}\n`);
      if (client.restart) io.stdout.write(`  ${client.restart}\n`);
    } catch (error) {
      failures += 1;
      io.stdout.write(`✗ ${client.label}: ${(error as Error).message}\n`);
      io.stdout.write(`  → run: seed install ${agent} --to ${client.id}\n`);
    }
    if (verificationStatus(registryDef) === "unverified") {
      io.stdout.write(`  note: ${client.id} adapter is unverified; confirm in the client after restart.\n`);
    }
  }

  return failures === 0 ? 0 : 1;
}

async function runInit(argv: readonly string[], io: RunCliIO, runner: CommandRunner): Promise<number> {
  const yes = argv.includes("--yes");
  const noInstall = argv.includes("--no-install");
  const noDaemon = argv.includes("--no-daemon");
  const resume = argv.includes("--resume");
  let name = flagValue(argv, "name") ?? flagValue(argv, "operator-name");
  let purpose = flagValue(argv, "purpose");
  const operatorPath = operatorPassportPath();
  const rl = shouldPrompt(yes) ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let journal = await readSetupJournal();
  if (!resume && journal && journal.status !== "completed") {
    writeCliFailure(io, argv.includes("--json"), "seedrop.setup.incomplete", `Incomplete setup journal at ${setupJournalPath()}.`, "conflict", "seed init --resume", {
      path: setupJournalPath(),
      status: journal.status,
    });
    return 1;
  }
  if (!journal || !resume || journal.status === "completed") {
    journal = createSetupJournal();
    await writeSetupJournal(journal);
  }
  if (resume) {
    io.stdout.write(`resuming setup: ${journal.setup_id}\n`);
  }

  let registry = await loadClientRegistry(import.meta.url);
  let detected: ResolvedClientDefinition[] = [];
  let wireDetected: Array<{ agent: string; clientId: string }> = [];

  try {
    let code = await runSetupStep(journal, "operator_passport", resume, async () => {
      if (!existsSync(operatorPath)) {
        name = name ?? await askRequired(rl, "Operator name");
        purpose = purpose ?? await askRequired(rl, "One-line purpose");
        if (!name || !purpose) {
          io.stderr.write(`No operator passport at ${operatorPath}.\n`);
          io.stderr.write(`Run \`seed init --name <you> --purpose "<mission>" --yes\`, or use an interactive terminal.\n`);
          return 1;
        }
        const initCode = await runner.run({
          command: "seed-id",
          args: ["init", "--name", name, "--purpose", purpose, "--out", operatorPath],
        });
        if (initCode !== 0) return initCode;
        io.stdout.write(`operator passport: ${operatorPath}\n`);
      } else {
        const passport = await safeReadPassport(operatorPath);
        io.stdout.write(`operator passport: ${passport?.agent_id ?? "?"} @ ${operatorPath}\n`);
      }
      return 0;
    });
    if (code !== 0) return code;

    code = await runSetupStep(journal, "detect_clients", resume, async () => {
      registry = await loadClientRegistry(import.meta.url);
      detected = await detectClients(registry);
      io.stdout.write(`\nDetecting installed MCP clients...\n`);
      if (detected.length === 0) {
        io.stdout.write(`  none detected\n`);
      } else {
        for (const client of detected) {
          io.stdout.write(`  ✓ ${client.label} (${client.configPath})\n`);
        }
      }
      return 0;
    });
    if (code !== 0) return code;

    const explicitWires = flagValues(argv, "wire").map(parseWireSpec);
    const shouldWire = !noInstall && (explicitWires.length > 0 || detected.length > 0);
    wireDetected = explicitWires.length > 0
      ? explicitWires
      : detected.map((client) => ({ agent: client.default_agent ?? client.id, clientId: client.id }));

    if (shouldWire && (yes || explicitWires.length > 0 || await askYesNo(rl, "Wire detected MCP clients?", true))) {
      code = await runSetupStep(journal, "agent_passports", resume, async () => {
        for (const wire of wireDetected) {
          const clientDef = registry[wire.clientId];
          const client = clientDef ? resolveClientDefinition(wire.clientId, clientDef) : null;
          if (!client || !existsSync(client.configPath)) continue;
          const passportPath = agentPassportPath(wire.agent);
          if (!existsSync(passportPath)) {
            const bootstrapCode = await runBootstrap(
              ["--as", wire.agent, "--name", wire.agent, "--purpose", `Use Seedrop from ${client.label}`, "--no-link"],
              io,
              runner,
            );
            if (bootstrapCode !== 0) return bootstrapCode;
          }
        }
        return 0;
      });
      if (code !== 0) return code;

      code = await runSetupStep(journal, "client_configs", resume, async () => {
        const command = resolveMcpServerCommand();
        for (const wire of wireDetected) {
        const clientDef = registry[wire.clientId];
        const client = clientDef ? resolveClientDefinition(wire.clientId, clientDef) : null;
        if (!client || !existsSync(client.configPath)) {
          io.stdout.write(`  - skipped ${wire.clientId}: config not found; run \`seed install ${wire.agent} --manual\`\n`);
          continue;
        }
        const passportPath = agentPassportPath(wire.agent);
        try {
          await installClientConfig(client, buildMcpServerEntry(passportPath, command));
          io.stdout.write(`  ✓ wired ${client.label} → ${wire.agent}\n`);
        } catch (error) {
          io.stdout.write(`  ✗ ${client.label}: ${(error as Error).message}\n`);
          io.stdout.write(`    → run: seed install ${wire.agent} --to ${wire.clientId} --manual\n`);
        }
      }
        return 0;
      });
      if (code !== 0) return code;
    } else if (!noInstall) {
      await markSetupStepSkipped(journal, "agent_passports");
      await markSetupStepSkipped(journal, "client_configs");
      io.stdout.write(`\nManual MCP setup is always available: seed install <agent> --manual\n`);
    } else {
      await markSetupStepSkipped(journal, "agent_passports");
      await markSetupStepSkipped(journal, "client_configs");
    }

    if (!noDaemon && platform() === "darwin" && (yes || await askYesNo(rl, "Install or refresh the always-on Space daemon?", true))) {
      code = await runSetupStep(journal, "daemon_install", resume, async () => runDaemon(["install"], io));
      if (code !== 0) return code;
    } else {
      await markSetupStepSkipped(journal, "daemon_install");
    }

    code = await runSetupStep(journal, "boot_protocol", resume, async () => {
      io.stdout.write(`\nBoot reflex:\n`);
      io.stdout.write(renderBootProtocol());
      return 0;
    });
    if (code !== 0) return code;
    journal.status = "completed";
    journal.updated_at = new Date().toISOString();
    await writeSetupJournal(journal);
    io.stdout.write(`Done. Try: seed doctor\n`);
    return 0;
  } finally {
    rl?.close();
  }
}

function createSetupJournal(): SetupJournal {
  const now = new Date().toISOString();
  return {
    schema_version: SETUP_SCHEMA_VERSION,
    setup_id: randomUUID(),
    started_at: now,
    updated_at: now,
    status: "in_progress",
    steps: SETUP_STEP_IDS.map((id) => ({
      id,
      status: "pending",
      summary: setupStepSummary(id),
      output_path: setupStepOutputPath(id),
      next_command: "seed init --resume",
      error: null,
    })),
  };
}

async function readSetupJournal(): Promise<SetupJournal | null> {
  const path = setupJournalPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SetupJournal;
    if (parsed.schema_version !== SETUP_SCHEMA_VERSION || !Array.isArray(parsed.steps)) return null;
    for (const id of SETUP_STEP_IDS) {
      if (!parsed.steps.some((step) => step.id === id)) {
        parsed.steps.push({
          id,
          status: "pending",
          summary: setupStepSummary(id),
          output_path: setupStepOutputPath(id),
          next_command: "seed init --resume",
          error: null,
        });
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeSetupJournal(journal: SetupJournal): Promise<void> {
  const path = setupJournalPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

async function runSetupStep(
  journal: SetupJournal,
  id: SetupStepId,
  resume: boolean,
  run: () => Promise<number>,
): Promise<number> {
  const step = setupStep(journal, id);
  if (resume && (step.status === "completed" || step.status === "skipped")) {
    return 0;
  }
  journal.status = "in_progress";
  journal.updated_at = new Date().toISOString();
  step.status = "running";
  step.error = null;
  await writeSetupJournal(journal);
  let code: number;
  try {
    code = await run();
  } catch (error) {
    code = 1;
    step.error = error instanceof Error ? error.message : String(error);
  }
  journal.updated_at = new Date().toISOString();
  if (code === 0) {
    step.status = "completed";
    step.error = null;
  } else {
    step.status = "failed";
    step.error = step.error ?? `command exited ${code}`;
    journal.status = "failed";
  }
  await writeSetupJournal(journal);
  return code;
}

async function markSetupStepSkipped(journal: SetupJournal, id: SetupStepId): Promise<void> {
  const step = setupStep(journal, id);
  if (step.status === "completed") return;
  step.status = "skipped";
  step.error = null;
  journal.updated_at = new Date().toISOString();
  await writeSetupJournal(journal);
}

function setupStep(journal: SetupJournal, id: SetupStepId): SetupJournalStep {
  let step = journal.steps.find((candidate) => candidate.id === id);
  if (!step) {
    step = {
      id,
      status: "pending",
      summary: setupStepSummary(id),
      output_path: setupStepOutputPath(id),
      next_command: "seed init --resume",
      error: null,
    };
    journal.steps.push(step);
  }
  return step;
}

function setupStepSummary(id: SetupStepId): string {
  switch (id) {
    case "operator_passport":
      return "create operator passport";
    case "detect_clients":
      return "detect installed MCP clients";
    case "agent_passports":
      return "create agent passports";
    case "client_configs":
      return "write client MCP configs";
    case "daemon_install":
      return "install Space daemon";
    case "boot_protocol":
      return "print boot protocol";
  }
}

function setupStepOutputPath(id: SetupStepId): string | undefined {
  switch (id) {
    case "operator_passport":
      return operatorPassportPath();
    case "agent_passports":
      return join(homedir(), ".seedrop", "id", "agents");
    case "daemon_install":
      return launchAgentPlistPath();
    default:
      return undefined;
  }
}

async function runDoctor(argv: readonly string[], io: RunCliIO, runner: CommandRunner): Promise<number> {
  const json = argv.includes("--json");
  const fix = argv.includes("--fix");
  const { registry, diagnostics } = await loadClientRegistryWithDiagnostics(import.meta.url);
  const checks: DoctorCheck[] = [];
  const add = (
    id: string,
    status: DoctorCheck["status"],
    summary: string,
    details: Record<string, unknown> = {},
    nextCommand: string | null = null,
  ): void => {
    checks.push({ id, status, summary, details, next_command: nextCommand, docs_url: null });
  };

  const operatorPath = operatorPassportPath();
  if (existsSync(operatorPath)) {
    const passport = await safeReadPassport(operatorPath);
    add("operator_passport", "pass", `operator passport exists`, { agent_id: passport?.agent_id ?? null, path: operatorPath });
  } else {
    add("operator_passport", "fail", `operator passport missing`, { path: operatorPath }, `seed init`);
  }

  const agentsDir = join(homedir(), ".seedrop", "id", "agents");
  const agentPassports = await listAgentPassports(agentsDir);
  if (agentPassports.length > 0) {
    add("agent_passports", "pass", `agent passports exist`, { agents: agentPassports });
  } else {
    add("agent_passports", "fail", `no agent passports`, { path: agentsDir }, `seed bootstrap --as <agent> --name <agent> --purpose "<mission>"`);
  }

  if (diagnostics.length > 0) {
    add("client_registry", "fail", `client registry has invalid entries`, { diagnostics }, `edit ${userClientsPath()}`);
  } else {
    add("client_registry", "pass", `client registry loaded`, {
      clients: Object.keys(registry).sort(),
    });
  }

  const detected = await detectClients(registry);
  const clientConfigIssues: Array<Record<string, unknown>> = [];
  if (detected.length === 0) {
    clientConfigIssues.push({ issue: "none_detected" });
  }
  for (const client of detected) {
    const registryDef = registry[client.id]!;
    if (verificationStatus(registryDef) === "unverified") {
      add("client_registry_unverified", "warn", `${client.label} registry entry is unverified`, {
        client_id: client.id,
        config_path: client.configPath,
      }, `seed install ${client.default_agent ?? client.id} --manual`);
    }
    const configured = await clientHasSeedConfig(client);
    if (!configured) {
      const agent = client.default_agent ?? client.id;
      clientConfigIssues.push({ client_id: client.id, label: client.label, issue: "not_wired", config_path: client.configPath, next_command: `seed install ${agent} --to ${client.id}` });
      continue;
    }
    const passport = await configuredPassport(client);
    if (passport && !existsSync(passport)) {
      clientConfigIssues.push({ client_id: client.id, label: client.label, issue: "missing_passport", passport, next_command: `seed bootstrap --as ${client.default_agent ?? "<agent>"} --name <name> --purpose "<mission>"` });
      continue;
    }
    if (passport && sameFilePath(passport, operatorPath) && !operatorPassportAllowed(registryDef)) {
      clientConfigIssues.push({ client_id: client.id, label: client.label, issue: "operator_passport", passport });
    }
  }
  const hardClientFailures = clientConfigIssues.filter((issue) => issue.issue !== "operator_passport");
  if (clientConfigIssues.length === 0) {
    add("client_configs", "pass", `detected client configs are wired`, { detected: detected.map((client) => client.id) });
  } else if (hardClientFailures.length > 0) {
    const next = hardClientFailures.find((issue) => typeof issue.next_command === "string")?.next_command as string | undefined;
    add("client_configs", "fail", `client config issues found`, { issues: clientConfigIssues }, next ?? `seed install <agent> --manual`);
  } else {
    add("client_configs", "warn", `client is wired to operator passport`, { issues: clientConfigIssues }, `seed install <agent> --to <client>`);
  }

  const daemon = await checkDaemon(defaultSpaceUrl());
  if (daemon.ok) {
    add("daemon_reachable", "pass", `Space daemon reachable`, { url: defaultSpaceUrl() });
    add("daemon_health", "pass", `Space daemon health ok`, { health: daemon.health });
  } else {
    const next = platform() === "darwin" ? "seed daemon install" : "seed space serve";
    add("daemon_reachable", "fail", `Space daemon not reachable`, { url: defaultSpaceUrl() }, next);
    add("daemon_health", "fail", `Space daemon health unavailable`, { url: defaultSpaceUrl() }, next);
  }

  const expectedPassports = [{ agent: "operator", path: operatorPath }, ...agentPassports].filter((passport) => existsSync(passport.path));
  if (daemon.ok && daemon.health) {
    const registered = new Set((daemon.health.registered_passports ?? []).map((passport) => passport.path).filter(Boolean));
    const missing = expectedPassports.filter((passport) => !registered.has(passport.path));
    if (missing.length === 0) {
      add("daemon_registered_passports", "pass", `daemon has registered known passports`, { registered: [...registered] });
    } else {
      add("daemon_registered_passports", "fail", `daemon is missing registered passports`, { missing }, "seed daemon install");
    }
  } else if (platform() === "darwin" && existsSync(launchAgentPlistPath())) {
    const plist = await readFile(launchAgentPlistPath(), "utf8");
    const expectedAgentsDir = join(homedir(), ".seedrop", "id", "agents");
    if (plist.includes(`>${expectedAgentsDir}<`) && plist.includes(`>${operatorPath}<`)) {
      // New-style plist uses --agents-dir; daemon will auto-discover at startup.
      add("daemon_registered_passports", "pass", `daemon plist uses --agents-dir (${expectedAgentsDir.replace(homedir(), "~")})`, { plist: launchAgentPlistPath() });
    } else {
      // Legacy plist with hardcoded --passport per agent; check each.
      const missing = expectedPassports.filter((passport) => !plist.includes(passport.path));
      if (missing.length === 0) {
        add("daemon_registered_passports", "pass", `daemon plist registers known passports`, { plist: launchAgentPlistPath() });
      } else {
        add("daemon_registered_passports", "fail", `daemon plist does not register all passports`, { missing }, "seed daemon install");
      }
    }
  } else {
    add("daemon_registered_passports", "warn", `daemon passport registration unknown`, {}, platform() === "darwin" ? "seed daemon install" : "seed space serve");
  }

  const view = formatRepoViewStatus(process.cwd());
  add("repo_view", !view.includes("absent") && !view.includes("skipped") ? "pass" : "warn", view, { cwd: process.cwd() }, "seed bootstrap");

  const activePath = defaultPassportPath();
  add(
    "active_passport",
    existsSync(activePath) ? "pass" : "fail",
    existsSync(activePath) ? `active passport exists` : `active passport missing`,
    { path: activePath },
    existsSync(activePath) ? null : "seed login <agent>",
  );

  const command = resolveMcpServerCommand();
  const localScript = command.command === process.execPath ? command.args[0] : undefined;
  const commandOk = localScript ? existsSync(localScript) : command.command.length > 0;
  add(
    "mcp_server_command",
    commandOk ? "pass" : "fail",
    commandOk ? `MCP server command resolved` : `MCP server command missing`,
    { command },
    commandOk ? null : "npm run build",
  );

  const setup = await readSetupJournal();
  if (setup && setup.status !== "completed") {
    add("setup_journal", "fail", `setup journal is incomplete`, { path: setupJournalPath(), setup }, "seed init --resume");
  }

  if (fix) {
    if (diagnostics.length > 0) {
      io.stderr.write(`Cannot auto-fix while client registry has invalid entries. Edit ${userClientsPath()} first.\n`);
      return 1;
    }
    io.stdout.write("Applying safe fixes...\n");
    const installCode = await installDetectedClients(registry, io, runner);
    if (installCode !== 0) return installCode;
    if (platform() === "darwin") {
      const daemonCheck = checks.find((check) => check.id === "daemon_reachable");
      if (daemonCheck?.status === "fail") {
        io.stdout.write("Space daemon is not reachable; refreshing launchd registration...\n");
        return await runDaemon(["install"], io);
      }
    }
    io.stdout.write("Done. Re-run `seed doctor` after restarting wired clients.\n");
    return 0;
  }

  if (json) {
    const payload = {
      schema_version: DOCTOR_SCHEMA_VERSION,
      ok: !checks.some((check) => check.status === "fail"),
      generated_at: new Date().toISOString(),
      checks,
    };
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload.ok ? 0 : 1;
  }

  for (const check of checks) {
    const symbol = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    io.stdout.write(`${symbol} ${check.summary}\n`);
    if (check.status !== "pass" && check.next_command) io.stdout.write(`  → run: ${check.next_command}\n`);
  }
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

function resolveMcpServerCommand(): McpServerCommand {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    here.replace(/cli\/dist\/router\.js$/, "mcp/dist/cli.js"),
    here.replace(/cli\/src\/router\.ts$/, "mcp/dist/cli.js"),
  ];
  const local = candidates.find((candidate) => candidate !== here && existsSync(candidate));
  if (local) {
    return { command: process.execPath, args: [local] };
  }
  return { command: "npx", args: ["-y", "@seedrop/mcp"] };
}

async function printClientList(registry: Record<string, { label?: string; config: unknown; format: string; section: string }>, io: RunCliIO): Promise<void> {
  for (const [id, def] of Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = resolveClientDefinition(id, def as never);
    const status = resolved && existsSync(resolved.configPath) ? "detected" : "not found";
    const verified = verificationStatus(def as never);
    io.stdout.write(`${id}\t${def.label ?? id}\t${status}\t${verified}${resolved ? `\t${resolved.configPath}` : ""}\n`);
  }
}

function renderBootProtocol(): string {
  return [
    "## Seedrop Boot Reflex",
    "",
    "At the start of every session, run:",
    "",
    "```bash",
    "seed",
    "```",
    "",
    "This loads persistent identity, checks the current repo View, verifies Space daemon reachability, and shows the next move.",
    "",
    "For a new repo, run:",
    "",
    "```bash",
    "seed bootstrap",
    "```",
    "",
  ].join("\n");
}

function shouldPrompt(yes: boolean): boolean {
  return !yes && Boolean(process.stdin.isTTY);
}

async function askRequired(rl: ReturnType<typeof createInterface> | null, prompt: string): Promise<string | undefined> {
  if (!rl) return undefined;
  const answer = (await rl.question(`${prompt}: `)).trim();
  return answer.length > 0 ? answer : undefined;
}

async function askYesNo(rl: ReturnType<typeof createInterface> | null, prompt: string, defaultYes: boolean): Promise<boolean> {
  if (!rl) return defaultYes;
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${prompt} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function parseWireSpec(spec: string): { agent: string; clientId: string } {
  const [agent, clientId] = spec.split(":");
  if (!agent || !clientId) {
    throw new Error(`Invalid --wire value "${spec}". Use --wire <agent>:<client>, e.g. --wire codex:codex-cli.`);
  }
  return { agent, clientId };
}

async function listAgentPassports(agentsDir: string): Promise<Array<{ agent: string; path: string }>> {
  if (!existsSync(agentsDir)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(agentsDir)).filter((entry) => entry.endsWith(".json"));
  const agents: Array<{ agent: string; path: string }> = [];
  for (const entry of entries) {
    const path = join(agentsDir, entry);
    const passport = await safeReadPassport(path);
    agents.push({ agent: passport?.agent_id ?? entry.replace(/\.json$/, ""), path });
  }
  return agents;
}

async function checkDaemon(url: string): Promise<{ ok: boolean; health?: SpaceHealthResponse }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { ok: false };
    const health = await response.json() as SpaceHealthResponse;
    return { ok: health.ok === true, health };
  } catch {
    return { ok: false };
  }
}

function sameFilePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

async function installClaudeCode(
  passportPath: string,
  mcpServerScript: string,
  customConfig: string | undefined,
  io: RunCliIO,
): Promise<number> {
  const configPath = customConfig ?? join(homedir(), ".claude.json");
  if (!existsSync(configPath)) {
    io.stderr.write(
      `Claude Code config not found at ${configPath}. Open Claude Code at least once, or pass --config <path>.\n`,
    );
    return 1;
  }
  const raw = await readFile(configPath, "utf8");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    io.stderr.write(`Could not parse ${configPath}: ${(error as Error).message}\n`);
    return 1;
  }
  const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = (mcpServers.seedrop as Record<string, unknown> | undefined) ?? {};
  const existingEnv = (existing.env as Record<string, string> | undefined) ?? {};
  const updated = {
    type: "stdio",
    command: existing.command ?? process.execPath,
    args: existing.args ?? [mcpServerScript],
    env: { ...existingEnv, SEEDROP_PASSPORT: passportPath },
  };
  config.mcpServers = { ...mcpServers, seedrop: updated };

  // Backup before writing.
  await writeFile(`${configPath}.bak.${Date.now()}`, raw, "utf8");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  io.stdout.write(`✓ wrote claude-code MCP config: ${configPath}\n`);
  io.stdout.write(`  mcpServers.seedrop.env.SEEDROP_PASSPORT = ${passportPath}\n`);
  io.stdout.write(`\nRestart Claude Code to pick up the change.\n`);
  return 0;
}

async function installCodexCli(
  passportPath: string,
  mcpServerScript: string,
  customConfig: string | undefined,
  io: RunCliIO,
): Promise<number> {
  const configPath = customConfig ?? join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) {
    io.stderr.write(
      `Codex CLI config not found at ${configPath}. Launch \`codex\` at least once, or pass --config <path>.\n`,
    );
    return 1;
  }
  const raw = await readFile(configPath, "utf8");
  // Surgical TOML edit: locate [mcp_servers.seedrop] (and optional [mcp_servers.seedrop.env]).
  // We don't want a heavy TOML parser dependency for one targeted change; the format here is regular.
  const updated = upsertCodexSeedEntry(raw, {
    command: process.execPath,
    script: mcpServerScript,
    passportPath,
  });

  // Backup before writing.
  await writeFile(`${configPath}.bak.${Date.now()}`, raw, "utf8");
  await writeFile(configPath, updated, "utf8");

  io.stdout.write(`✓ wrote codex-cli MCP config: ${configPath}\n`);
  io.stdout.write(`  [mcp_servers.seedrop.env] SEEDROP_PASSPORT = "${passportPath}"\n`);
  io.stdout.write(`\nRestart Codex (exit and re-launch) to pick up the change.\n`);
  return 0;
}

/**
 * Idempotent surgical edit of ~/.codex/config.toml for the seedrop MCP entry.
 * - Ensures `[mcp_servers.seedrop]` exists with command/args.
 * - Ensures `[mcp_servers.seedrop.env]` contains SEEDROP_PASSPORT pointing at the right file.
 *
 * Conservative: if existing command/args differ, we leave them alone. We only
 * own the env entry. If the section is missing entirely, we append a clean one.
 */
export function upsertCodexSeedEntry(
  raw: string,
  opts: { command: string; script: string; passportPath: string },
): string {
  const hasSection = /\[mcp_servers\.seedrop\]/.test(raw);
  const hasEnvSection = /\[mcp_servers\.seedrop\.env\]/.test(raw);

  if (!hasSection) {
    const trailing = raw.endsWith("\n") ? "" : "\n";
    const block = `${trailing}\n[mcp_servers.seedrop]\ncommand = "${opts.command}"\nargs = ["${opts.script}"]\n\n[mcp_servers.seedrop.env]\nSEEDROP_PASSPORT = "${opts.passportPath}"\n`;
    return raw + block;
  }

  if (hasEnvSection) {
    // Replace or add SEEDROP_PASSPORT inside the existing env section.
    const lines = raw.split("\n");
    const envIdx = lines.findIndex((l) => l.trim() === "[mcp_servers.seedrop.env]");
    let nextHeaderIdx = lines.length;
    for (let i = envIdx + 1; i < lines.length; i += 1) {
      if (/^\[/.test(lines[i]!.trim())) {
        nextHeaderIdx = i;
        break;
      }
    }
    let replaced = false;
    for (let i = envIdx + 1; i < nextHeaderIdx; i += 1) {
      if (/^\s*SEEDROP_PASSPORT\s*=/.test(lines[i]!)) {
        lines[i] = `SEEDROP_PASSPORT = "${opts.passportPath}"`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.splice(envIdx + 1, 0, `SEEDROP_PASSPORT = "${opts.passportPath}"`);
    }
    return lines.join("\n");
  }

  // Section exists but no env block — insert one immediately after the section header block.
  const lines = raw.split("\n");
  const sectionIdx = lines.findIndex((l) => l.trim() === "[mcp_servers.seedrop]");
  let nextHeaderIdx = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i += 1) {
    if (/^\[/.test(lines[i]!.trim())) {
      nextHeaderIdx = i;
      break;
    }
  }
  // Insert before nextHeaderIdx (after any blank line).
  let insertAt = nextHeaderIdx;
  while (insertAt > sectionIdx + 1 && lines[insertAt - 1]?.trim() === "") insertAt -= 1;
  lines.splice(
    insertAt,
    0,
    "",
    "[mcp_servers.seedrop.env]",
    `SEEDROP_PASSPORT = "${opts.passportPath}"`,
  );
  return lines.join("\n");
}

async function runDaemon(argv: readonly string[], io: RunCliIO): Promise<number> {
  const [sub] = argv;
  if (platform() !== "darwin") {
    io.stderr.write(`seed daemon currently only supports macOS (launchd). Detected: ${platform()}.\n`);
    return 1;
  }
  if (sub === "install") return daemonInstall(argv.slice(1), io);
  if (sub === "uninstall") return daemonUninstall(io);
  if (sub === "status") return daemonStatus(io);
  io.stderr.write(`Usage:\n  seed daemon install [--port N]\n  seed daemon uninstall\n  seed daemon status\n`);
  return 1;
}

async function daemonInstall(argv: readonly string[], io: RunCliIO): Promise<number> {
  const operatorPath = flagValue(argv, "passport") ?? operatorPassportPath();
  const spaceRoot = flagValue(argv, "space-root") ?? defaultSpaceRoot();
  const port = flagValue(argv, "port") ?? "18791";

  if (!existsSync(operatorPath)) {
    io.stderr.write(`No passport at ${operatorPath}. Run \`seed bootstrap --name <name> --purpose "<purpose>"\` first.\n`);
    return 1;
  }

  // Pass --agents-dir to the daemon instead of one --passport per agent. The
  // daemon discovers agent passports under ~/.seedrop/id/agents/ at startup
  // AND watches that directory at runtime, so adding a new agent (via
  // `seed bootstrap --as <agent>`) does NOT require a plist edit or daemon
  // restart. The plist becomes static.
  const agentsDir = join(homedir(), ".seedrop", "id", "agents");
  await mkdir(agentsDir, { recursive: true });

  // Resolve the seed binary the daemon should invoke. Prefer the source-first
  // bin shim (cli/bin/seed.mjs) when present so edits to src/ are reflected
  // without a build. Fall back to dist/cli.js for published tarballs.
  const routerPath = fileURLToPath(import.meta.url);
  const workspaceRoot = dirname(dirname(routerPath)); // .../cli/src/router.ts -> .../cli  (or .../cli/dist/router.js -> .../cli)
  const sourceShim = join(workspaceRoot, "bin", "seed.mjs");
  const distBin = join(workspaceRoot, "dist", "cli.js");
  const seedBin = existsSync(sourceShim) ? sourceShim : distBin;
  const node = process.execPath;
  const logDir = join(spaceRoot, "logs");
  await mkdir(logDir, { recursive: true });

  const plist = renderPlist({
    label: DAEMON_LABEL,
    node,
    seedBin,
    operatorPassportPath: operatorPath,
    agentsDir,
    spaceRoot,
    port,
    home: homedir(),
    logDir,
  });
  const plistPath = launchAgentPlistPath();
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, "utf8");

  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plistPath]);
  const load = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plistPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (load.status !== 0) {
    io.stderr.write(`launchctl bootstrap failed (exit ${load.status}): ${load.stderr.toString()}\n`);
    return 1;
  }

  io.stdout.write(`installed daemon plist: ${plistPath}\n`);
  io.stdout.write(`daemon listening on http://127.0.0.1:${port} (root: ${spaceRoot})\n`);
  io.stdout.write(`operator passport: ${operatorPath.replace(homedir(), "~")}\n`);
  io.stdout.write(`agents dir (auto-discovered + watched): ${agentsDir.replace(homedir(), "~")}\n`);
  io.stdout.write(`logs: ${logDir}/{out,err}.log\n`);
  return 0;
}

async function daemonUninstall(io: RunCliIO): Promise<number> {
  const plistPath = launchAgentPlistPath();
  if (existsSync(plistPath)) {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plistPath]);
    await rm(plistPath, { force: true });
    io.stdout.write(`uninstalled daemon plist: ${plistPath}\n`);
  } else {
    io.stdout.write(`no daemon plist at ${plistPath}\n`);
  }
  return 0;
}

async function daemonStatus(io: RunCliIO): Promise<number> {
  const plistPath = launchAgentPlistPath();
  if (!existsSync(plistPath)) {
    io.stdout.write(`not installed (no plist at ${plistPath})\n`);
    return 0;
  }
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${DAEMON_LABEL}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    io.stdout.write(`plist installed at ${plistPath} but launchctl reports not loaded\n`);
    return 0;
  }
  const out = result.stdout.toString();
  const state = out.match(/state\s*=\s*(\S+)/)?.[1] ?? "unknown";
  const pid = out.match(/pid\s*=\s*(\d+)/)?.[1];
  io.stdout.write(`daemon ${DAEMON_LABEL}: state=${state}${pid ? ` pid=${pid}` : ""}\n`);
  io.stdout.write(`plist: ${plistPath}\n`);
  return 0;
}

function renderPlist(opts: {
  label: string;
  node: string;
  seedBin: string;
  operatorPassportPath: string;
  agentsDir: string;
  spaceRoot: string;
  port: string;
  home: string;
  logDir: string;
}): string {
  const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(opts.node)}</string>
    <string>${escape(opts.seedBin)}</string>
    <string>space</string>
    <string>serve</string>
    <string>--passport</string>
    <string>${escape(opts.operatorPassportPath)}</string>
    <string>--agents-dir</string>
    <string>${escape(opts.agentsDir)}</string>
    <string>--root</string>
    <string>${escape(opts.spaceRoot)}</string>
    <string>--port</string>
    <string>${escape(opts.port)}</string>
    <string>--host</string>
    <string>127.0.0.1</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escape(opts.home)}</string>
    <key>SEEDROP_PASSPORT</key>
    <string>${escape(opts.operatorPassportPath)}</string>
    <key>SEEDROP_SPACE_ROOT</key>
    <string>${escape(opts.spaceRoot)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escape(opts.spaceRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escape(join(opts.logDir, "out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(join(opts.logDir, "err.log"))}</string>
</dict>
</plist>
`;
}

function resolveViewCommand(argv: readonly string[]): CommandPlan {
  const [command, ...rest] = argv;
  if (command !== "init") {
    return { command: "seed-space", args: ["view", ...argv] };
  }
  const passportPath = flagValue(rest, "passport") ?? defaultPassportPath();

  const root = resolve(flagValue(rest, "root") ?? process.cwd());
  const workspaceId = flagValue(rest, "workspace-id") ?? basename(root);
  const role = flagValue(rest, "role");
  const currentFocus = flagValue(rest, "current-focus");
  const space = flagValue(rest, "space");
  const viewArgs = ["view", "init", ...removeFlags(rest, new Set(["passport", "role", "current-focus", "space"]))];
  const linkArgs = [
    "project",
    "link",
    "--passport",
    passportPath,
    "--id",
    workspaceId,
    "--root",
    root,
    "--view",
    ".seedrop/view",
  ];
  if (role) linkArgs.push("--role", role);
  if (currentFocus) linkArgs.push("--current-focus", currentFocus);
  if (space) linkArgs.push("--space", space);

  return [
    { command: "seed-space", args: viewArgs },
    { command: "seed-id", args: linkArgs },
  ];
}

function normalizeIdArgs(argv: readonly string[]): string[] {
  const [command, maybePassport, ...rest] = argv;
  const acceptsPositionalPassport = command
    ? ["audit", "repair", "show", "status", "validate"].includes(command)
    : false;
  if (command && acceptsPositionalPassport && maybePassport && !maybePassport.startsWith("-")) {
    return [command, "--passport", maybePassport, ...rest];
  }
  return [...argv];
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) return undefined;
    return next;
  }
  return undefined;
}

function flagValues(argv: readonly string[], name: string): string[] {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) values.push(next);
  }
  return values;
}

function removeFlags(argv: readonly string[], names: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) {
      if (arg) result.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (names.has(name)) {
      if (next && !next.startsWith("--")) i += 1;
      continue;
    }
    result.push(arg);
    if (next && !next.startsWith("--")) {
      result.push(next);
      i += 1;
    }
  }
  return result;
}

function resolveBundledScript(command: string): string | null {
  const pkg = command === "seed-id"
    ? "@seedrop/id"
    : command === "seed-space"
      ? "@seedrop/space"
      : null;
  if (!pkg) return null;
  try {
    const entryUrl = import.meta.resolve(pkg);
    const entryPath = fileURLToPath(entryUrl);
    // Prefer the source-first bin shim (bin/<command>.mjs) when present —
    // edits to src/ are reflected on the next invocation without a build.
    // Falls back to dist/cli.js for published tarballs that ship only dist.
    const workspaceRoot = dirname(dirname(entryPath));
    const sourceShim = join(workspaceRoot, "bin", `${command}.mjs`);
    if (existsSync(sourceShim)) return sourceShim;
    return join(dirname(entryPath), "cli.js");
  } catch {
    return null;
  }
}

function spawnCommandRunner(): CommandRunner {
  return {
    run(dispatch) {
      return new Promise<number>((resolve, reject) => {
        const bundled = resolveBundledScript(dispatch.command);
        const cmd = bundled ? process.execPath : dispatch.command;
        const args = bundled ? [bundled, ...dispatch.args] : dispatch.args;
        const child = spawn(cmd, args, { stdio: "inherit" });
        const forwardSigint = (): void => {
          child.kill("SIGINT");
        };
        const forwardSigterm = (): void => {
          child.kill("SIGTERM");
        };
        const cleanup = (): void => {
          process.off("SIGINT", forwardSigint);
          process.off("SIGTERM", forwardSigterm);
        };
        process.once("SIGINT", forwardSigint);
        process.once("SIGTERM", forwardSigterm);
        child.on("error", (error) => {
          cleanup();
          reject(error);
        });
        child.on("close", (code) => {
          cleanup();
          resolve(code ?? 1);
        });
      });
    },
  };
}
