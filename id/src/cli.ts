#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassport, readAuditLog } from "./audit.js";
import {
  defaultCommitJournalPath,
  readCommitJournal,
  repairPendingCommit,
  type CommitRepairOptions,
} from "./commit-journal.js";
import { Identity } from "./identity.js";
import { readPassport, writePassport } from "./passport.js";
import type { AuditEntry } from "./audit.js";
import type { Passport } from "./schema.js";

interface CliIO {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface ParsedOptions extends CommitRepairOptions {
  agentId?: string;
  force: boolean;
  json: boolean;
  name?: string;
  outPath?: string;
  projectId?: string;
  projectRoot?: string;
  purpose?: string;
  role?: string;
  currentFocus?: string;
  space?: string;
  view?: string;
  issuedBy?: string;
  autonomous?: boolean;
}

const usage = `Usage:
  seed-id init [--name <name>] [--purpose <purpose>] [--agent-id <id>] [--issued-by <agent_id>] [--autonomous] [--out <path>] [--force] [--json]
  seed-id update [--passport <path>] [--name <name>] [--purpose <purpose>] [--json]
  seed-id validate [--passport <path>] [--json]
  seed-id show [--passport <path>] [--json]
  seed-id audit [--passport <path>] [--audit <path>] [--json]
  seed-id project link [--passport <path>] --id <id> --root <path> [--role <role>] [--current-focus <text>] [--space <id>] [--view <path>] [--json]
  seed-id repair [--passport <path>] [--audit <path>] [--journal <path>] [--json]
  seed-id status [--passport <path>] [--journal <path>] [--json]

Default passport path: $SEEDROP_PASSPORT or ~/.seedrop/id/passport.json

Commands:
  init     Create a minimal agent passport.
  update   Update mutable passport fields (name, purpose) after init.
  validate Validate a passport file against the schema.
  show     Print a passport summary or full JSON.
  audit    Inspect the passport audit log.
  project  Link project orientation into a passport.
  repair   Repair a pending passport commit journal if one exists.
  status   Inspect whether a pending passport commit journal exists.
`;

export async function runCli(argv: readonly string[], io: CliIO = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  const [command, ...rest] = argv;

  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout.write(usage);
      return 0;
    }

    if (command === "repair") {
      return await repairCommand(rest, io);
    }

    if (command === "init") {
      return await initCommand(rest, io);
    }

    if (command === "validate") {
      return await validateCommand(rest, io);
    }

    if (command === "show") {
      return await showCommand(rest, io);
    }

    if (command === "update") {
      return await updateCommand(rest, io);
    }

    if (command === "audit") {
      return await auditCommand(rest, io);
    }

    if (command === "project") {
      return await projectCommand(rest, io);
    }

    if (command === "status") {
      return await statusCommand(rest, io);
    }

    io.stderr.write(`Unknown command: ${command}\n\n${usage}`);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

async function initCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const options = parseOptions(argv, { requirePassport: false });
  const outPath = options.outPath ?? defaultPassportPath();

  if (!options.name) {
    throw new Error("--name <name> is required");
  }
  if (!options.purpose) {
    throw new Error("--purpose <purpose> is required");
  }
  if (!options.force && (await pathExists(outPath))) {
    throw new Error(`passport already exists: ${outPath} (pass --force to overwrite)`);
  }

  const passport = createMinimalPassport(options.name, options.purpose, {
    agentId: options.agentId,
    issuedBy: options.issuedBy,
    autonomous: options.autonomous,
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writePassport(passport, outPath);

  if (options.json) {
    writeJson(io, { passportPath: outPath, passport });
  } else {
    io.stdout.write(`created passport: ${outPath}\n`);
    io.stdout.write(`agent: ${passport.agent_id}\n`);
    if (passport.issued_by) io.stdout.write(`issued_by: ${passport.issued_by}\n`);
    if (passport.autonomous) io.stdout.write(`autonomous: true\n`);
  }

  return 0;
}

async function validateCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const options = parseOptions(argv, { requirePassport: true });
  const passport = await readPassport(options.passportPath!);
  const payload = {
    ok: true,
    passportPath: options.passportPath,
    agentId: passport.agent_id,
    name: passport.name,
    hash: hashPassport(passport),
  };

  if (options.json) {
    writeJson(io, payload);
  } else {
    io.stdout.write(`valid passport: ${options.passportPath}\n`);
    io.stdout.write(`agent: ${passport.name} (${passport.agent_id})\n`);
  }

  return 0;
}

async function updateCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const options = parseOptions(argv, { requirePassport: true });
  const passport = await readPassport(options.passportPath!);

  const changes: Record<string, { from: string; to: string }> = {};
  if (options.name !== undefined && options.name !== passport.name) {
    changes.name = { from: passport.name, to: options.name };
    passport.name = options.name;
  }
  if (options.purpose !== undefined && options.purpose !== passport.purpose) {
    changes.purpose = { from: passport.purpose, to: options.purpose };
    passport.purpose = options.purpose;
  }

  if (Object.keys(changes).length === 0) {
    if (options.json) {
      writeJson(io, { passportPath: options.passportPath, changed: false, changes: {} });
    } else {
      io.stdout.write(`no changes (pass --name and/or --purpose to update)\n`);
    }
    return 0;
  }

  await writePassport(passport, options.passportPath!);

  if (options.json) {
    writeJson(io, { passportPath: options.passportPath, changed: true, changes });
  } else {
    io.stdout.write(`updated passport: ${options.passportPath}\n`);
    for (const [field, { from, to }] of Object.entries(changes)) {
      io.stdout.write(`  ${field}: ${from} → ${to}\n`);
    }
  }

  return 0;
}

async function showCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const options = parseOptions(argv, { requirePassport: true });
  const passport = await readPassport(options.passportPath!);

  if (options.json) {
    writeJson(io, passport);
  } else {
    io.stdout.write(`name: ${passport.name}\n`);
    io.stdout.write(`agent_id: ${passport.agent_id}\n`);
    io.stdout.write(`purpose: ${passport.purpose}\n`);
    if (passport.issued_by) io.stdout.write(`issued_by: ${passport.issued_by}\n`);
    if (passport.autonomous) io.stdout.write(`autonomous: true\n`);
    io.stdout.write(`sessions: ${passport.metadata.session_count}\n`);
    io.stdout.write(`active_projects: ${passport.active_projects?.length ?? 0}\n`);
    io.stdout.write(`credential_refs: ${passport.credential_refs?.length ?? 0}\n`);
    if (passport.continuity?.current_focus) {
      io.stdout.write(`current_focus: ${passport.continuity.current_focus}\n`);
    }
  }

  return 0;
}

async function auditCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const options = parseOptions(argv, { requirePassport: true });
  const auditPath = options.auditPath ?? `${options.passportPath}.audit.jsonl`;
  const entries = await readAuditLog(auditPath);
  const latest = entries.at(-1);

  if (options.json) {
    writeJson(io, {
      auditPath,
      count: entries.length,
      latest,
      entries,
    });
  } else {
    io.stdout.write(`audit log: ${auditPath}\n`);
    io.stdout.write(`entries: ${entries.length}\n`);
    if (latest) {
      io.stdout.write(`latest: ${formatAuditSummary(latest)}\n`);
    }
  }

  return 0;
}

async function projectCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "link") {
    throw new Error(`Unknown project command: ${subcommand ?? ""}`.trim());
  }
  const options = parseOptions(rest, { requirePassport: true });
  if (!options.projectId) {
    throw new Error("--id <id> is required");
  }
  if (!options.projectRoot) {
    throw new Error("--root <path> is required");
  }

  const identity = await Identity.fromPassport(options.passportPath!);
  const result = await identity.upsertActiveProject(
    {
      id: options.projectId,
      root: options.projectRoot,
      role: options.role,
      currentFocus: options.currentFocus,
      space: options.space,
      view: options.view,
    },
    {
      write: true,
      passportPath: options.passportPath,
      auditPath: options.auditPath,
      journalPath: options.journalPath,
      notes: `linked active project ${options.projectId}`,
    },
  );
  const project = result.after.active_projects?.find((candidate) => candidate.id === options.projectId);

  if (options.json) {
    writeJson(io, {
      passportPath: result.passportPath,
      auditPath: result.auditPath,
      project,
    });
  } else {
    io.stdout.write(`linked active project: ${options.projectId}\n`);
    io.stdout.write(`passport: ${result.passportPath}\n`);
  }

  return 0;
}

async function repairCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const options = parseOptions(argv, { requirePassport: true });
  const result = await repairPendingCommit(options);

  if (options.json) {
    writeJson(io, result);
  } else if (result.status === "conflict") {
    io.stderr.write(`pending commit conflict: ${result.reason ?? "manual review required"}\n`);
  } else if (result.status === "no_pending_commit") {
    io.stdout.write(`no pending commit journal: ${result.journalPath}\n`);
  } else {
    const action = result.repaired ? "repaired" : "cleared";
    io.stdout.write(`${action} pending commit: ${result.status}\n`);
  }

  return result.status === "conflict" ? 2 : 0;
}

async function statusCommand(argv: readonly string[], io: CliIO): Promise<number> {
  const options = parseOptions(argv, { requirePassport: true });
  const journalPath = options.journalPath ?? defaultCommitJournalPath(options.passportPath!);
  const journal = await readCommitJournal(journalPath);
  const payload = {
    pending: journal !== null,
    journalPath,
    passportPath: journal?.passport_path ?? options.passportPath,
    auditPath: journal?.audit_path ?? options.auditPath,
    transactionId: journal?.transaction_id,
    createdAt: journal?.created_at,
  };

  if (options.json) {
    writeJson(io, payload);
  } else if (journal) {
    io.stdout.write(`pending commit journal: ${journalPath}\n`);
    io.stdout.write(`transaction: ${journal.transaction_id}\n`);
    io.stdout.write(`created: ${journal.created_at}\n`);
  } else {
    io.stdout.write(`no pending commit journal: ${journalPath}\n`);
  }

  return 0;
}

function parseOptions(argv: readonly string[], rules: { requirePassport: boolean }): ParsedOptions {
  const options: ParsedOptions = { force: false, json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--name") {
      options.name = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--purpose") {
      options.purpose = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--agent-id") {
      options.agentId = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--out") {
      options.outPath = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--id") {
      options.projectId = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--root") {
      options.projectRoot = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--role") {
      options.role = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--current-focus") {
      options.currentFocus = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--space") {
      options.space = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--view") {
      options.view = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--passport") {
      options.passportPath = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--audit") {
      options.auditPath = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--journal") {
      options.journalPath = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--issued-by") {
      options.issuedBy = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--autonomous") {
      options.autonomous = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (rules.requirePassport && !options.passportPath) {
    options.passportPath = defaultPassportPath();
  }

  return options;
}

export function defaultPassportPath(): string {
  // Resolution order:
  //   1. $SEEDROP_PASSPORT (per-process override)
  //   2. ~/.seedrop/state/active-passport.json (shell login)
  //   3. ~/.seedrop/id/passport.json (operator default)
  const envPath = process.env.SEEDROP_PASSPORT?.trim();
  if (envPath) return envPath;
  const active = readActivePassportFromState();
  if (active) return active;
  return join(homedir(), ".seedrop", "id", "passport.json");
}

function readActivePassportFromState(): string | null {
  const path = join(homedir(), ".seedrop", "state", "active-passport.json");
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      schema_version?: string;
      passport_path?: string;
    };
    if (parsed.schema_version !== "1.0") return null;
    if (!parsed.passport_path) return null;
    if (!existsSync(parsed.passport_path)) return null;
    return parsed.passport_path;
  } catch {
    return null;
  }
}

function createMinimalPassport(
  name: string,
  purpose: string,
  opts: { agentId?: string; issuedBy?: string; autonomous?: boolean } = {},
): Passport {
  const agentId = opts.agentId ?? slugifyAgentId(name);
  if (opts.issuedBy && opts.issuedBy === agentId) {
    throw new Error(`--issued-by must differ from agent_id (got "${agentId}" for both)`);
  }
  const passport: Passport = {
    version: "1.0",
    agent_id: agentId,
    name,
    purpose,
    core_commitments: [],
    value_anchors: [],
    competencies: [],
    limits: [],
    learned_blocks: [],
    active_projects: [],
    credential_refs: [],
    continuity: {
      next_actions: [],
      open_threads: [],
    },
    metadata: {
      created_at: new Date().toISOString(),
      session_count: 0,
    },
  };
  if (opts.issuedBy) passport.issued_by = opts.issuedBy;
  if (opts.autonomous) passport.autonomous = true;
  return passport;
}

function slugifyAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `agent-${randomUUID()}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function formatAuditSummary(entry: AuditEntry): string {
  return `${entry.timestamp} ${entry.before_hash.slice(0, 12)} -> ${entry.after_hash.slice(0, 12)}`;
}

function readOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function writeJson(io: CliIO, payload: unknown): void {
  io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (isInvokedAsScript(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

function isInvokedAsScript(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const target = fileURLToPath(metaUrl);
  if (entry === target) return true;
  try {
    return realpathSync(entry) === target;
  } catch {
    return false;
  }
}
