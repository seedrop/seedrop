#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isMutatingCommand, shouldAnnounceIdentity } from "./announce.js";
import { SpaceHttpClient } from "./client.js";
import { startSpaceServer } from "./serve.js";
import { applyRootMigration, previewRootMigration, rollbackRootMigration } from "./root-migration.js";
import { readPassportIdentity } from "./serve.js";
import { WorkspaceView } from "./view.js";
import type { AuditReport, ViewBrief, ViewPreflightReport, WorkspaceContext } from "./view.js";

const DEFAULT_SPACE_PORT = 18791;
const DEFAULT_SPACE_URL = `http://127.0.0.1:${DEFAULT_SPACE_PORT}`;

function defaultPassportPath(): string {
  // Precedence: env > active-passport > operator. SEEDROP_PASSPORT is a
  // process-scoped MCP identity and must not be overridden by another
  // agent's global `seed login` state.
  const envPath = process.env.SEEDROP_PASSPORT?.trim();
  if (envPath) return envPath;
  const active = readActivePassportFromState();
  if (active) return active;
  return join(homedir(), ".seedrop", "id", "passport.json");
}

function defaultAgentId(): string {
  try {
    const passportPath = defaultPassportPath();
    if (!existsSync(passportPath)) return "agent";
    const parsed = JSON.parse(readFileSync(passportPath, "utf8")) as { agent_id?: string };
    return typeof parsed.agent_id === "string" && parsed.agent_id.length > 0 ? parsed.agent_id : "agent";
  } catch {
    return "agent";
  }
}

function readActivePassportFromState(): string | null {
  const statePath = join(homedir(), ".seedrop", "state", "active-passport.json");
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
      schema_version?: string;
      passport_path?: string;
    };
    if (parsed.schema_version !== "1.0" || !parsed.passport_path) return null;
    if (!existsSync(parsed.passport_path)) return null;
    return parsed.passport_path;
  } catch {
    return null;
  }
}

function defaultSpaceRoot(): string {
  const envPath = process.env.SEEDROP_SPACE_ROOT?.trim();
  if (envPath) return envPath;
  return join(homedir(), ".seedrop", "space");
}

function sessionStatePath(passportId: string): string {
  return join(defaultSpaceRoot(), "sessions", `${passportId}.json`);
}

async function readSessionState(passportId: string): Promise<{ sessionId: string; spaceId?: string } | null> {
  const path = sessionStatePath(passportId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as { sessionId: string; spaceId?: string };
  } catch {
    return null;
  }
}

async function writeSessionState(passportId: string, state: { sessionId: string; spaceId?: string }): Promise<void> {
  const path = sessionStatePath(passportId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

interface ParsedArgs {
  namespace?: string;
  command?: string;
  values: string[];
  flags: Map<string, string[]>;
}

const parsed = parseArgs(process.argv.slice(2));

try {
  await run(parsed);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  // Render structured recovery hints if the error carries any. They go
  // to stderr so JSON output on stdout stays parseable.
  const { renderRecovery } = await import("./errors.js");
  const recovery = renderRecovery(error);
  if (recovery) console.error(recovery);
  process.exitCode = 1;
}

async function run(args: ParsedArgs): Promise<void> {
  const command = args.command;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve") {
    await serveCommand(args);
    return;
  }

  if (command === "migrate-root") {
    await migrateRootCommand(args);
    return;
  }

  if (isSpaceClientCommand(command)) {
    await spaceClientCommand(command, args);
    return;
  }

  const resolvedAgent = args.flags.get("agent")?.[0] ?? defaultAgentId();
  const view = WorkspaceView.open({
    root: args.flags.get("root")?.[0] ?? process.cwd(),
    agent: resolvedAgent,
  });

  // Announce identity for mutating commands so a watching human sees who
  // they're acting as. Suppressed when stderr is piped/redirected — e.g.
  // `seed ... 2>&1 | jq` — so JSON consumers don't get a corrupted stream.
  if (
    shouldAnnounceIdentity({
      isMutating: isMutatingCommand(args.namespace, command),
      quietFlag: args.flags.has("quiet"),
      quietEnv: process.env.SEEDROP_QUIET,
      stderrIsTTY: process.stderr.isTTY,
    })
  ) {
    process.stderr.write(`[acting as ${resolvedAgent}]\n`);
  }

  if (args.namespace === "run") {
    await runJournalCommand(command, args, view);
    return;
  }

  if (args.namespace === "task") {
    await taskCommand(command, args, view);
    return;
  }

  if (command === "init") {
    printJson(await view.init(args.flags.get("workspace-id")?.[0]));
    return;
  }

  if (command === "brief") {
    const brief = await view.brief();
    if (args.flags.has("json")) printJson(brief);
    else printBrief(brief);
    return;
  }

  if (command === "sync") {
    printJson(await view.sync({ workspaceId: args.flags.get("workspace-id")?.[0] }));
    return;
  }

  if (command === "manual") {
    const { seedropManual } = await import("./manual.js");
    const sectionFlag = args.values[0] ?? args.flags.get("section")?.[0];
    const valid = ["all", "concepts", "workflows", "state", "anti-patterns"] as const;
    const section = (valid as readonly string[]).includes(sectionFlag ?? "")
      ? (sectionFlag as (typeof valid)[number])
      : "all";
    if (args.flags.has("json")) {
      printJson({ section, content: seedropManual(section) });
    } else {
      console.log(seedropManual(section));
    }
    return;
  }

  if (command === "diff") {
    const { diffView, renderViewDiff } = await import("./diff.js");
    const since = args.flags.get("since")?.[0];
    const report = await diffView(view, { since });
    if (args.flags.has("json")) printJson(report);
    else console.log(renderViewDiff(report));
    return;
  }

  if (command === "context") {
    const budgetFlag = args.flags.get("budget")?.[0];
    const budgetBytes = budgetFlag === undefined ? undefined : Number(budgetFlag);
    if (budgetBytes !== undefined && (!Number.isFinite(budgetBytes) || budgetBytes < 0)) {
      throw new Error(`--budget must be a non-negative byte count (got '${budgetFlag}').`);
    }
    const context = await view.context(budgetBytes === undefined ? {} : { budgetBytes });
    if (args.flags.has("json")) {
      // Budgeted output is compact: indentation would spend the budget on whitespace.
      if (context.budget) console.log(JSON.stringify(context));
      else printJson(context);
    } else printContext(context);
    return;
  }

  if (command === "preflight") {
    const report = await view.preflight();
    if (args.flags.has("json")) printJson(report);
    else printPreflight(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "audit") {
    const report = await view.audit();
    if (args.flags.has("json")) printJson(report);
    else printPreflight(report);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "graves") {
    const graves = await view.listGraves({
      paths: args.flags.get("path"),
      limit: Number(args.flags.get("limit")?.[0] ?? "5") || 5,
    });
    if (args.flags.has("json")) printJson({ graves });
    else if (graves.length === 0) console.log("no dead runs recorded.");
    else {
      for (const g of graves) {
        const mark = g.swept ? "swept" : "reported";
        console.log(`✝ [${g.status}/${mark}] ${g.goal}`);
        console.log(`  cause: ${g.cause ?? "(none recorded)"}`);
        console.log(`  ${g.agent_id} · ${g.finished_at.slice(0, 10)} · ${g.changed_paths.length} path(s)`);
      }
    }
    return;
  }

  if (command === "explain") {
    const topic = args.values[0];
    if (!topic) throw new Error("seed view explain requires a topic: a path, or 'success'");
    const { explainPath, explainSuccess, renderExplainPath, renderExplainSuccess } = await import("./explain.js");
    if (topic === "success") {
      const report = await explainSuccess(view);
      if (args.flags.has("json")) printJson(report);
      else {
        console.log(`acting as: ${resolvedAgent}`);
        console.log(renderExplainSuccess(report));
      }
      return;
    }
    const report = await explainPath(view, topic);
    if (args.flags.has("json")) printJson(report);
    else {
      console.log(`acting as: ${resolvedAgent}`);
      console.log(renderExplainPath(report));
    }
    return;
  }

  if (command === "log") {
    const mission = requireFlag(args, "mission");
    const summary = requireFlag(args, "summary");
    printJson(
      await view.log({
        mission,
        summary,
        decisions: args.flags.get("decision") ?? [],
        assumptions: args.flags.get("assumption") ?? [],
        openThreads: args.flags.get("open-thread") ?? [],
        changedPaths: args.flags.get("changed-path") ?? [],
        validation: {
          status: validationStatus(args.flags.get("validation-status")?.[0]),
          commands: args.flags.get("validation-command") ?? [],
          notes: args.flags.get("validation-notes")?.[0],
        },
      }),
    );
    return;
  }

  if (command === "claim" || command === "lock") {
    const target = args.values[0] ?? requireFlag(args, "target");
    const intent = args.values.slice(1).join(" ") || requireFlag(args, "intent");
    printJson(
      await view.claimSignal({
        type: command === "lock" ? "lock" : "claim",
        target,
        intent,
        owner: args.flags.get("owner")?.[0],
        ttlMs: parseTtl(args.flags.get("ttl")?.[0]),
        recovery: args.flags.get("recovery")?.[0],
      }),
    );
    return;
  }

  if (command === "signals") {
    const includeExpired = args.flags.has("include-expired");
    const live = await view.listSignals({ includeExpired });
    // The archive ledger holds GC-swept signals; surface it with the same
    // flag so expired history stays queryable after cleanup.
    if (includeExpired) {
      printJson({ live, archived: await view.listArchivedSignals() });
    } else {
      printJson(live);
    }
    return;
  }

  if (command === "release") {
    printJson(
      await view.releaseSignal({
        id: args.flags.get("id")?.[0],
        target: args.flags.get("target")?.[0] ?? args.values[0],
        owner: args.flags.get("owner")?.[0],
        type: signalType(args.flags.get("type")?.[0]),
        expiredOnly: args.flags.has("expired"),
        dryRun: args.flags.has("dry-run"),
        force: args.flags.has("force"),
      }),
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function serveCommand(args: ParsedArgs): Promise<void> {
  const explicitPassports = args.flags.get("passport");
  const agentsDirs = args.flags.get("agents-dir");
  const passportPaths = explicitPassports && explicitPassports.length > 0
    ? explicitPassports
    : agentsDirs && agentsDirs.length > 0
      ? [] // no explicit passports; the resolver discovers from agentsDirs
      : [defaultPassportPath()];
  const started = await startSpaceServer({
    // The daemon CLI receives an already-resolved machine data root. Older
    // launch agents call it --root, so retain that spelling as a deprecated
    // alias without appending the library's repo-relative .seedrop/space.
    dataDir: args.flags.get("data-dir")?.[0] ?? args.flags.get("root")?.[0] ?? defaultSpaceRoot(),
    passportPaths,
    passportId: args.flags.get("passport-id")?.[0],
    passportIds: args.flags.get("passport-id"),
    agentsDirs,
    watchAgentsDirs: agentsDirs && agentsDirs.length > 0 && !args.flags.has("no-watch"),
    host: args.flags.get("host")?.[0],
    port: parsePort(args.flags.get("port")?.[0]),
    version: args.flags.get("runtime-version")?.[0],
    buildHash: args.flags.get("build-hash")?.[0],
    runtimeProfile: args.flags.get("runtime-profile")?.[0],
    runtimeRoot: args.flags.get("runtime-root")?.[0],
    runtimeSourceHash: args.flags.get("runtime-source-hash")?.[0],
  });
  const payload = {
    event: "listening",
    url: started.url,
    host: started.host,
    port: started.port,
    passportId: started.identity.passportId,
    agentId: started.identity.agentId,
    identities: started.identities.map((identity) => ({
      passportId: identity.passportId,
      agentId: identity.agentId,
      path: identity.path,
    })),
  };

  if (args.flags.has("json")) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(`seed-space serve listening on ${started.url}`);
    console.log(`passport: ${started.identity.passportId}`);
  }

  await waitForShutdown(started.server);
}

async function migrateRootCommand(args: ParsedArgs): Promise<void> {
  const manifestPath = args.flags.get("rollback")?.[0];
  if (manifestPath) {
    printJson(await rollbackRootMigration(manifestPath));
    return;
  }
  const options = {
    canonicalRoot: args.flags.get("canonical-root")?.[0] ?? defaultSpaceRoot(),
    legacyRoot: args.flags.get("legacy-root")?.[0],
    backupBase: args.flags.get("backup-base")?.[0],
    migrationId: args.flags.get("migration-id")?.[0],
  };
  printJson(args.flags.has("apply") ? await applyRootMigration(options) : await previewRootMigration(options));
}

async function spaceClientCommand(command: SpaceClientCommand, args: ParsedArgs): Promise<void> {
  const client = await createClient(args);

  if (command === "join") {
    printJson(await client.join(requireValue(args, 0, "space name")));
    return;
  }

  if (command === "post") {
    const spaceName = requireValue(args, 0, "space name");
    const content = args.values.slice(1).join(" ") || requireFlag(args, "content");
    printJson(await client.post(spaceName, {
      content,
      role: messageRole(args.flags.get("role")?.[0]),
      requestId: args.flags.get("request-id")?.[0],
    }));
    return;
  }

  if (command === "messages") {
    printJson(await client.messages(requireValue(args, 0, "space name")));
    return;
  }

  if (command === "presence") {
    printJson(
      await client.presence({
        spaceId: args.flags.get("space-id")?.[0],
        passportId: args.flags.get("filter-passport")?.[0],
        ttlMs: parseTtl(args.flags.get("ttl")?.[0]),
      }),
    );
    return;
  }

  if (command === "register") {
    const result = (await client.register({
      spaceId: args.flags.get("space-id")?.[0],
      workingOn: args.flags.get("working-on")?.[0],
    })) as { session: { id: string; passport_id: string; space_id?: string } };
    await writeSessionState(result.session.passport_id, {
      sessionId: result.session.id,
      spaceId: result.session.space_id,
    });
    printJson(result);
    return;
  }

  if (command === "heartbeat") {
    const passportPath = args.flags.get("passport")?.[0] ?? defaultPassportPath();
    const passportId =
      args.flags.get("passport-id")?.[0] ?? (await passportIdFromPath(passportPath));
    const explicit = args.flags.get("session-id")?.[0];
    const sessionId = explicit ?? (await readSessionState(passportId))?.sessionId;
    if (!sessionId) {
      throw new Error(`No registered session for ${passportId}. Run \`seed space register\` first.`);
    }
    printJson(
      await client.heartbeat({
        sessionId,
        workingOn: args.flags.get("working-on")?.[0],
      }),
    );
    return;
  }

  if (command === "notify") {
    printJson(
      await client.notify({
        recipientPassportId: requireFlag(args, "to"),
        pointer: parsePointer(requireFlag(args, "pointer")),
        ttlMs: parseTtl(args.flags.get("ttl")?.[0]),
      }),
    );
    return;
  }

  if (command === "notifications") {
    printJson(await client.notifications());
    return;
  }

  if (command === "ack") {
    printJson(await client.ack(args.values[0] ?? requireFlag(args, "id")));
    return;
  }

  if (command === "end") {
    printJson(await client.end(requireValue(args, 0, "space name")));
    return;
  }

  if (command === "inbox") {
    printJson(
      await client.inbox({
        unackedOnly: args.flags.has("unacked-only"),
        limit: args.flags.get("limit")?.[0] ? Number(args.flags.get("limit")![0]) : undefined,
      }),
    );
    return;
  }

  if (command === "inbox-ack") {
    const itemId = requireValue(args, 0, "mention id");
    const resultArg = args.flags.get("result")?.[0] ?? "done";
    if (resultArg !== "done" && resultArg !== "deferred" && resultArg !== "ignored") {
      throw new Error(`--result must be one of done|deferred|ignored (got ${resultArg})`);
    }
    printJson(
      await client.ackInbox(itemId, {
        result: resultArg,
        note: args.flags.get("note")?.[0],
        deferredUntil: args.flags.get("deferred-until")?.[0],
      }),
    );
    return;
  }
}

async function runJournalCommand(command: string | undefined, args: ParsedArgs, view: WorkspaceView): Promise<void> {
  if (command === "start") {
    printJson(
      await view.startRun({
        goal: requireFlag(args, "goal"),
        newRun: args.flags.has("new"),
        taskId: args.flags.get("task")?.[0],
        claim: args.flags.get("claim") ?? [],
        force: args.flags.has("force"),
      }),
    );
    return;
  }
  if (command === "log") {
    printJson(
      await view.logRun({
        summary: requireFlag(args, "summary"),
        changedPaths: args.flags.get("changed-path") ?? [],
        runId: args.flags.get("run-id")?.[0],
      }),
    );
    return;
  }
  if (command === "decision") {
    printJson(await view.decideRun(args.values.join(" ") || requireFlag(args, "summary")));
    return;
  }
  if (command === "thread") {
    printJson(await view.threadRun(args.values.join(" ") || requireFlag(args, "summary")));
    return;
  }
  if (command === "verify") {
    printJson(
      await view.verifyRun({
        command: requireFlag(args, "command"),
        status: runValidationStatus(requireFlag(args, "status")),
        notes: args.flags.get("notes")?.[0],
        runId: args.flags.get("run-id")?.[0],
      }),
    );
    return;
  }
  if (command === "finish") {
    printJson(
      await view.finishRun({
        status: runFinishStatus(args.flags.get("status")?.[0] ?? args.values[0]),
        force: args.flags.has("force"),
        runId: args.flags.get("run-id")?.[0],
        cause: args.flags.get("cause")?.[0],
        handoffTo: args.flags.get("handoff-to")?.[0],
        handoffNote: args.flags.get("handoff-note")?.[0],
      }),
    );
    return;
  }
  if (command === "sweep") {
    const hours = Number(args.flags.get("older-than-hours")?.[0] ?? "72");
    const swept = await view.sweepOrphanedRuns({ olderThanHours: Number.isFinite(hours) ? hours : 72 });
    printJson({ swept_count: swept.length, swept });
    return;
  }
  throw new Error(`Unknown run command: ${command ?? ""}`);
}

async function taskCommand(command: string | undefined, args: ParsedArgs, view: WorkspaceView): Promise<void> {
  // Most task verbs take a task id as their first positional. Resolve once
  // here so short ID prefixes (the form `seed task list` displays) work
  // everywhere without each verb having to remember.
  const resolveId = (label = "task id"): Promise<string> => view.resolveTaskId(requireValue(args, 0, label));

  if (command === "create") {
    printJson(
      await view.createTask({
        title: requireFlag(args, "title"),
        description: args.flags.get("description")?.[0],
        dedupKey: args.flags.get("dedup-key")?.[0],
        fromKnowledge: args.flags.get("from-knowledge")?.[0],
        blockedBy: args.flags.get("blocked-by") ?? [],
      }),
    );
    return;
  }
  if (command === "claim") {
    printJson(await view.claimTask(await resolveId()));
    return;
  }
  if (command === "assign") {
    printJson(
      await view.assignTask({
        taskId: await resolveId(),
        to: requireValue(args, 1, "agent"),
        note: args.flags.get("note")?.[0],
      }),
    );
    return;
  }
  if (command === "accept") {
    printJson(await view.acceptTask(await resolveId()));
    return;
  }
  if (command === "decline") {
    printJson(
      await view.declineTask({
        taskId: await resolveId(),
        reason: args.flags.get("reason")?.[0],
      }),
    );
    return;
  }
  if (command === "update") {
    const taskId = await resolveId();
    const blockedBy = await Promise.all((args.flags.get("blocked-by") ?? []).map((id) => view.resolveTaskId(id)));
    printJson(
      await view.updateTask({
        taskId,
        description: args.flags.get("description")?.[0],
        assignedNote: args.flags.get("assigned-note")?.[0],
        fromKnowledge: args.flags.get("from-knowledge")?.[0],
        blockedBy,
        replaceBlockedBy: args.flags.has("replace-blocked-by"),
      }),
    );
    return;
  }
  if (command === "start") {
    printJson(await view.startTask(await resolveId()));
    return;
  }
  if (command === "pause") {
    const statusFlag = args.flags.get("status")?.[0];
    const status = statusFlag === "open" ? "open" : statusFlag === "blocked" || statusFlag === undefined ? "blocked" : (() => {
      throw new Error(`--status must be 'blocked' or 'open' (got '${statusFlag}').`);
    })();
    printJson(await view.pauseTask({ taskId: await resolveId(), status }));
    return;
  }
  if (command === "done") {
    printJson(await view.doneTask(await resolveId()));
    return;
  }
  if (command === "drop") {
    printJson(
      await view.dropTask({
        taskId: await resolveId(),
        reason: args.flags.get("reason")?.[0],
      }),
    );
    return;
  }
  if (command === "list") {
    const status = args.flags.get("status")?.[0];
    const tasks = await view.listTasks({
      status: status as Parameters<typeof view.listTasks>[0] extends infer T ? T extends { status?: infer S } ? S : never : never,
      owner: args.flags.get("owner")?.[0],
      fromKnowledge: args.flags.get("from-knowledge")?.[0],
    });
    if (args.flags.has("json")) printJson(tasks);
    else for (const task of tasks) {
      const owner = task.owner ?? "—";
      console.log(`${task.task_id.slice(0, 8)}\t${task.status}\t${owner}\t${task.title}`);
    }
    return;
  }
  if (command === "show") {
    printJson(await view.getTask(await resolveId()));
    return;
  }
  throw new Error(`Unknown task command: ${command ?? ""}`);
}


function parseArgs(argv: string[]): ParsedArgs {
  const [first, second, ...remaining] = argv;
  const isNamespace = first === "view" || first === "run" || first === "task";
  const namespace = isNamespace ? first : undefined;
  const command = isNamespace ? second : first;
  const rest = isNamespace ? remaining : argv.slice(1);
  const values: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith("--")) {
      if (arg) {
        values.push(arg);
      }
      continue;
    }

    const raw = arg.slice(2);
    const equalsAt = raw.indexOf("=");
    if (equalsAt > 0) {
      appendFlag(flags, raw.slice(0, equalsAt), raw.slice(equalsAt + 1));
      continue;
    }

    const key = raw;
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      appendFlag(flags, key, "true");
    } else {
      appendFlag(flags, key, next);
      index += 1;
    }
  }

  return { namespace, command, values, flags };
}

function appendFlag(flags: Map<string, string[]>, key: string, value: string): void {
  const values = flags.get(key) ?? [];
  values.push(value);
  flags.set(key, values);
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name)?.[0];
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function requireValue(args: ParsedArgs, index: number, label: string): string {
  const value = args.values[index];
  if (!value) {
    throw new Error(`Missing required ${label}`);
  }
  return value;
}

function validationStatus(value: string | undefined): "passed" | "failed" | "skipped" | "unknown" {
  if (value === "passed" || value === "failed" || value === "skipped" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function runValidationStatus(value: string): "passed" | "failed" | "skipped" {
  if (value === "passed" || value === "failed" || value === "skipped") return value;
  throw new Error("--status must be passed, failed, or skipped");
}

function runFinishStatus(value: string | undefined): "completed" | "blocked" | "failed" {
  if (value === "completed" || value === "blocked" || value === "failed") return value;
  throw new Error("--status must be completed, blocked, or failed");
}

function messageRole(value: string | undefined): "agent" | "human" | "system" | undefined {
  if (value === undefined) return undefined;
  if (value === "agent" || value === "human" || value === "system") return value;
  throw new Error("--role must be agent, human, or system");
}

function signalType(value: string | undefined): "claim" | "lock" | undefined {
  if (value === "claim" || value === "lock") {
    return value;
  }
  return undefined;
}

function parseTtl(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("--ttl must be a positive number of milliseconds");
  }
  return ttl;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  return port;
}

function parsePointer(value: string): { kind: string; ref: string } {
  const split = value.indexOf(":");
  if (split <= 0 || split === value.length - 1) {
    throw new Error("--pointer must use kind:ref format");
  }
  return {
    kind: value.slice(0, split),
    ref: value.slice(split + 1),
  };
}

async function createClient(args: ParsedArgs): Promise<SpaceHttpClient> {
  const baseUrl = args.flags.get("url")?.[0] ?? process.env.SEEDROP_SPACE_URL ?? DEFAULT_SPACE_URL;
  const passportPath = args.flags.get("passport")?.[0] ?? defaultPassportPath();
  const passportId = args.flags.get("passport-id")?.[0] ?? (await passportIdFromPath(passportPath));
  return new SpaceHttpClient({ baseUrl, passportId });
}

async function passportIdFromPath(passportPath: string): Promise<string> {
  return (await readPassportIdentity({ passportPath })).passportId;
}

type SpaceClientCommand =
  | "join"
  | "post"
  | "messages"
  | "presence"
  | "register"
  | "heartbeat"
  | "notify"
  | "notifications"
  | "ack"
  | "inbox"
  | "inbox-ack"
  | "end";

function isSpaceClientCommand(command: string): command is SpaceClientCommand {
  return (
    command === "join" ||
    command === "post" ||
    command === "messages" ||
    command === "presence" ||
    command === "register" ||
    command === "heartbeat" ||
    command === "notify" ||
    command === "notifications" ||
    command === "ack" ||
    command === "inbox" ||
    command === "inbox-ack" ||
    command === "end"
  );
}

function waitForShutdown(server: import("node:http").Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const shutdown = (): void => {
      server.close((error) => (error ? reject(error) : resolve()));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printBrief(brief: ViewBrief): void {
  console.log(`view: ${brief.view.present ? "present" : "absent"} (${brief.view.data_dir})`);
  if (brief.workspace) console.log(`workspace: ${brief.workspace.id}`);
  if (brief.manifest) {
    console.log(`manifest: ${brief.manifest.freshness}, ${brief.manifest.file_count} tracked file(s)`);
  }
  console.log(`success: ${brief.success.level} ${brief.success.label}${brief.success.required_level ? ` (requires ${brief.success.required_level})` : ""}`);
  if (brief.verification_commands.length > 0) {
    console.log("verification:");
    for (const command of brief.verification_commands) console.log(`  - ${command}`);
  }
  printNextActions(brief.next_actions);
}

function printContext(context: WorkspaceContext): void {
  if (context.brief) printBrief(context.brief);
  console.log(`active signals: ${context.active_signals.length}`);
  if (context.current_run) console.log(`current run: ${context.current_run.run_id} (${context.current_run.goal})`);
  printNextActions(context.next_actions ?? []);
}


function printPreflight(report: ViewPreflightReport | AuditReport): void {
  console.log(`ok: ${report.ok ? "yes" : "no"}`);
  for (const check of report.checks ?? []) {
    console.log(`  [${check.status}] ${check.id}: ${check.summary}`);
  }
  for (const issue of report.issues) {
    console.log(`  ${issue.severity}: ${issue.code}${issue.path ? ` (${issue.path})` : ""} — ${issue.message}`);
  }
  printNextActions(report.next_actions ?? []);
}


function printNextActions(actions: Array<{ kind: string; command?: string; reason: string }>): void {
  if (actions.length === 0) return;
  console.log("next actions:");
  for (const action of actions) {
    console.log(`  - ${action.command ?? action.kind}: ${action.reason}`);
  }
}

function printHelp(): void {
  console.log(`Usage:
  seed-space serve --passport <path> [--data-dir <path>] [--host <host>] [--port <port>] [--json]
  seed-space migrate-root [--canonical-root <path>] [--apply]
  seed-space migrate-root --rollback <manifest-path>
  seed-space join <space> --passport <path> [--url <url>]
  seed-space post <space> <message> --passport <path> [--request-id <uuid>] [--url <url>]
  seed-space messages <space> --passport <path> [--url <url>]
  seed-space view <command> [options]
  seed-space run <command> [options]

Commands:
  serve                        Run the HTTP coordination server
  migrate-root                 Preview/apply/rollback the legacy nested data-root migration
  join                         Join or open a coordination space over HTTP
  post                         Post a message to a coordination space over HTTP
  messages                     List messages from a coordination space over HTTP
  presence                     List live presence over HTTP
  register                     Register a live session (POST /sessions) and cache its id
  heartbeat                    Keep the cached session warm (POST /presence/heartbeat)
  notify                       Send a pointer notification over HTTP
  notifications                List current notifications over HTTP
  ack                          Ack one notification over HTTP
  inbox                        List @-mentions addressed to this passport
  inbox-ack <id>               Ack a mention (done|deferred|ignored)
  end                          End a coordination space over HTTP
  init                         Create .seedrop/view if needed
  sync                         Refresh the workspace manifest
  brief                        Print stable repo orientation
  context                      Print full repo operating packet
  preflight                    Check whether it is safe to start work
  audit                        Check manifest drift and expired signals
  log --mission M --summary S  Write a continuity packet
  run start --goal G           Start a repo-local run journal
  run log --summary S          Append a run journal step
  run decision TEXT            Record a run decision
  run thread TEXT              Record an open thread
  run verify --command C --status passed|failed|skipped
  run finish --status completed [--force]
  run finish --status failed|blocked --cause "<one line>"
  run sweep [--older-than-hours N]   Mark abandoned in_progress runs failed (default 72h)
  graves [--path P]... [--limit N]   Dead runs, optionally scoped to paths you're about to touch
  task update <id> [--description TEXT] [--assigned-note TEXT] [--from-knowledge REF] [--blocked-by ID] [--replace-blocked-by]
  claim <target> <intent>      Create a claim signal lease
  lock <target> <intent>       Create a lock signal lease
  signals                      List active signal leases
  release --id ID              Release signal leases by id, target, owner, or type

Common options:
  --root PATH                  Workspace root, defaults to cwd
  --agent NAME                 Agent name, defaults to "agent"
  --passport PATH              Passport file, defaults to $SEEDROP_PASSPORT, seed login, or operator passport
  --port PORT                  Serve port, defaults to 18791; use 0 for ephemeral
  --url URL                    Coordination server URL, defaults to $SEEDROP_SPACE_URL or http://127.0.0.1:18791

Daemon root for serve defaults to $SEEDROP_SPACE_ROOT or ~/.seedrop/space.

Compatibility:
  Flat commands such as "seed-space sync" still work during the alpha.
`);
}
