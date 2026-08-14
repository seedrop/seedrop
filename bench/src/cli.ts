#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpaceUrl } from "@seedrop/observer";
import { startBenchServer } from "./server.js";

export interface BenchCliIO {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface ParsedBenchArgs {
  help: boolean;
  json: boolean;
  open: boolean;
  passportPath: string;
  spaceUrl: string | null;
  host: string;
  port: number;
  selectedProjectId?: string;
}

export async function runBenchCli(
  argv: readonly string[],
  io: BenchCliIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseBenchArgs(argv);
    if (parsed.help) {
      io.stdout.write(renderHelp());
      return 0;
    }
    const started = await startBenchServer({
      passportPath: parsed.passportPath,
      spaceUrl: parsed.spaceUrl,
      preferredRoot: process.cwd(),
      host: parsed.host,
      port: parsed.port,
      selectedProjectId: parsed.selectedProjectId,
    });
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify({ schema_version: "1.0", url: started.url, host: started.host, port: started.port }, null, 2)}\n`);
    } else {
      io.stdout.write(`Seedrop Bench: ${started.url}\n`);
      io.stdout.write("Press Ctrl-C to stop.\n");
    }
    if (parsed.open) openUrl(started.url, io);
    await waitForShutdown(started.close);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseBenchArgs(argv: readonly string[]): ParsedBenchArgs {
  let help = false;
  let json = false;
  let open = false;
  let passportPath = defaultPassportPath();
  let spaceUrl: string | null = defaultSpaceUrl();
  let host = "127.0.0.1";
  let port = 18792;
  let selectedProjectId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h" || arg === "help") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--open") open = true;
    else if (arg === "--no-space") spaceUrl = null;
    else if (arg === "--passport") passportPath = requireValue(argv, i += 1, "--passport");
    else if (arg === "--space-url" || arg === "--url") spaceUrl = requireValue(argv, i += 1, arg);
    else if (arg === "--host") host = requireValue(argv, i += 1, "--host");
    else if (arg === "--port") port = parsePort(requireValue(argv, i += 1, "--port"));
    else if (arg === "--project") selectedProjectId = requireValue(argv, i += 1, "--project");
    else throw new Error(`Unknown seed-bench option: ${arg}`);
  }
  return { help, json, open, passportPath, spaceUrl, host, port, selectedProjectId };
}

function defaultPassportPath(): string {
  const envPath = process.env.SEEDROP_PASSPORT?.trim();
  if (envPath) return envPath;
  const active = readActivePassportFromState();
  if (active) return active;
  return join(homedir(), ".seedrop", "id", "passport.json");
}

function readActivePassportFromState(): string | null {
  const statePath = join(homedir(), ".seedrop", "state", "active-passport.json");
  try {
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { passport_path?: string };
    return parsed.passport_path && existsSync(parsed.passport_path) ? parsed.passport_path : null;
  } catch {
    return null;
  }
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`--port must be 0-65535 (got ${value})`);
  return port;
}

function openUrl(url: string, io: BenchCliIO): void {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", (error) => {
    io.stderr.write(`warning: could not open browser: ${error.message}\n`);
  });
  child.unref();
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      void close().finally(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function renderHelp(): string {
  return `Usage:
  seed-bench [--passport PATH] [--space-url URL] [--host HOST] [--port PORT] [--project ID] [--open]
  seed bench [same options]

Starts a local read-only Seedrop Bench server and prints its localhost URL.

Defaults:
  Passport   $SEEDROP_PASSPORT, seed login, or ~/.seedrop/id/passport.json
  Space URL  $SEEDROP_SPACE_URL or http://127.0.0.1:18791
  Host       127.0.0.1
  Port       18792 (use --port 0 for an ephemeral port)
`;
}

if (isInvokedAsScript(import.meta.url)) {
  process.exitCode = await runBenchCli(process.argv.slice(2));
}

function isInvokedAsScript(metaUrl: string): boolean {
  if (process.env.SEEDROP_SHIM_INVOKE === "1") return true;
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
