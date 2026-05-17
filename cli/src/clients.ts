import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ClientFormat = "json" | "toml";
export type ClientVerificationStatus = "verified" | "community" | "unverified";
export type ClientEntryShape = "standard" | "kilo";

export interface ClientDefinition {
  label?: string;
  config: string | Partial<Record<NodeJS.Platform, string>>;
  format: ClientFormat;
  section: string;
  entry_shape?: ClientEntryShape;
  default_agent?: string;
  restart?: string;
  verified?: {
    status?: ClientVerificationStatus;
    last_verified_at?: string;
    platforms?: string[];
    client_versions?: string[];
    source?: string;
  };
  diagnostic?: {
    config_required?: boolean;
    supports_create_config?: boolean;
    operator_passport_allowed?: boolean;
  };
}

export interface ResolvedClientDefinition extends ClientDefinition {
  id: string;
  label: string;
  configPath: string;
}

export interface McpServerCommand {
  command: string;
  args: string[];
}

export interface McpServerEntry extends McpServerCommand {
  type: "stdio";
  env: Record<string, string>;
}

export interface ClientRegistryDiagnostic {
  path: string;
  key: string;
  message: string;
}

export interface LoadedClientRegistry {
  registry: Record<string, ClientDefinition>;
  diagnostics: ClientRegistryDiagnostic[];
}

export function builtinClientsPath(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "clients.json");
}

export function userClientsPath(): string {
  return join(homedir(), ".seedrop", "clients.json");
}

export async function loadClientRegistry(moduleUrl: string): Promise<Record<string, ClientDefinition>> {
  return (await loadClientRegistryWithDiagnostics(moduleUrl)).registry;
}

export async function loadClientRegistryWithDiagnostics(moduleUrl: string): Promise<LoadedClientRegistry> {
  const builtInPath = builtinClientsPath(moduleUrl);
  const userPath = userClientsPath();
  const builtInRaw = await readJsonFile<Record<string, unknown>>(builtInPath, {});
  const userRaw = await readJsonFile<Record<string, unknown>>(userPath, {});
  const diagnostics: ClientRegistryDiagnostic[] = [];
  const builtIn = validateRegistryEntries(builtInRaw, builtInPath, diagnostics);
  const user = validateRegistryEntries(userRaw, userPath, diagnostics);
  return { registry: { ...builtIn, ...user }, diagnostics };
}

export function resolveClientDefinition(id: string, def: ClientDefinition): ResolvedClientDefinition | null {
  const rawPath = typeof def.config === "string" ? def.config : def.config[platform()];
  if (!rawPath) return null;
  return {
    ...def,
    id,
    label: def.label ?? id,
    configPath: expandPath(rawPath),
  };
}

export function verificationStatus(def: ClientDefinition): ClientVerificationStatus {
  const status = def.verified?.status;
  if (status === "verified" || status === "community" || status === "unverified") return status;
  return "unverified";
}

export function operatorPassportAllowed(def: ClientDefinition): boolean {
  return def.diagnostic?.operator_passport_allowed === true;
}

export async function detectClients(registry: Record<string, ClientDefinition>): Promise<ResolvedClientDefinition[]> {
  const detected: ResolvedClientDefinition[] = [];
  for (const [id, def] of Object.entries(registry)) {
    const resolved = resolveClientDefinition(id, def);
    if (resolved && existsSync(resolved.configPath)) detected.push(resolved);
  }
  return detected;
}

export async function installClientConfig(
  client: ResolvedClientDefinition,
  entry: McpServerEntry,
  opts: { create?: boolean } = {},
): Promise<void> {
  if (!existsSync(client.configPath)) {
    if (!opts.create) {
      throw new Error(`Config not found at ${client.configPath}`);
    }
    await mkdir(dirname(client.configPath), { recursive: true });
  }
  const raw = existsSync(client.configPath) ? await readFile(client.configPath, "utf8") : "";
  const updated = client.format === "json"
    ? upsertJsonServer(raw, client.section, entry, client.entry_shape)
    : upsertTomlServer(raw, client.section, entry);
  if (existsSync(client.configPath)) {
    await writeFile(`${client.configPath}.bak.${Date.now()}`, raw, "utf8");
  }
  await writeFile(client.configPath, updated, "utf8");
}

export async function clientHasSeedConfig(client: ResolvedClientDefinition): Promise<boolean> {
  if (!existsSync(client.configPath)) return false;
  const raw = await readFile(client.configPath, "utf8");
  if (client.format === "json") {
    try {
      return getNested(parseJsonLike(raw || "{}"), client.section) !== undefined;
    } catch {
      return false;
    }
  }
  return new RegExp(`^\\s*\\[${escapeRegExp(client.section)}\\]\\s*$`, "m").test(raw);
}

export async function configuredPassport(client: ResolvedClientDefinition): Promise<string | null> {
  if (!existsSync(client.configPath)) return null;
  const raw = await readFile(client.configPath, "utf8");
  if (client.format === "json") {
    try {
      const server = getNested(parseJsonLike(raw || "{}"), client.section) as { env?: Record<string, string>; environment?: Record<string, string> } | undefined;
      return server?.env?.SEEDROP_PASSPORT ?? server?.environment?.SEEDROP_PASSPORT ?? null;
    } catch {
      return null;
    }
  }
  const match = raw.match(/^\s*SEEDROP_PASSPORT\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? null;
}

export function buildMcpServerEntry(passportPath: string, command: McpServerCommand): McpServerEntry {
  return {
    type: "stdio",
    command: command.command,
    args: command.args,
    env: { SEEDROP_PASSPORT: passportPath },
  };
}

export function renderManualInstall(passportPath: string, command: McpServerCommand): string {
  const json = {
    mcpServers: {
      seedrop: buildMcpServerEntry(passportPath, command),
    },
  };
  return [
    "# Paste one of these into your MCP client config.",
    "",
    "# JSON form",
    JSON.stringify(json, null, 2),
    "",
    "# TOML form",
    "[mcp_servers.seedrop]",
    `command = "${escapeToml(command.command)}"`,
    `args = [${command.args.map((arg) => `"${escapeToml(arg)}"`).join(", ")}]`,
    "",
    "[mcp_servers.seedrop.env]",
    `SEEDROP_PASSPORT = "${escapeToml(passportPath)}"`,
    "",
  ].join("\n");
}

export function upsertJsonServer(raw: string, section: string, entry: McpServerEntry, shape: ClientEntryShape = "standard"): string {
  let parsed: unknown;
  try {
    parsed = raw.trim().length > 0 ? parseJsonLike(raw) : {};
  } catch (error) {
    throw new Error(`Could not parse JSON config: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON config root must be an object");
  }
  const root = parsed as Record<string, unknown>;
  const existing = getNested(root, section) as { env?: Record<string, string>; environment?: Record<string, string> } | undefined;
  const value = shape === "kilo"
    ? {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: { ...(existing?.environment ?? {}), ...entry.env },
        enabled: true,
      }
    : {
        ...entry,
        env: { ...(existing?.env ?? {}), ...entry.env },
      };
  setNested(root, section, value);
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function upsertTomlServer(raw: string, section: string, entry: McpServerEntry): string {
  const lines = raw.split("\n");
  const sectionHeader = `[${section}]`;
  const envHeader = `[${section}.env]`;
  const ensured = upsertTomlSection(lines, sectionHeader, [
    `command = "${escapeToml(entry.command)}"`,
    `args = [${entry.args.map((arg) => `"${escapeToml(arg)}"`).join(", ")}]`,
  ]);
  const withEnv = upsertTomlSection(ensured, envHeader, [
    `SEEDROP_PASSPORT = "${escapeToml(entry.env.SEEDROP_PASSPORT ?? "")}"`,
  ]);
  return withEnv.join("\n").replace(/\n*$/, "\n");
}

export function expandPath(input: string): string {
  let out = input;
  if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  out = out.replace(/%APPDATA%/gi, process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"));
  out = out.replace(/\$HOME/g, homedir());
  return resolve(out);
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function validateRegistryEntries(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: ClientRegistryDiagnostic[],
): Record<string, ClientDefinition> {
  const registry: Record<string, ClientDefinition> = {};
  for (const [key, value] of Object.entries(raw)) {
    const message = validateClientDefinition(value);
    if (message) {
      diagnostics.push({ path, key, message });
      continue;
    }
    registry[key] = value as ClientDefinition;
  }
  return registry;
}

function validateClientDefinition(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "entry must be an object";
  const def = value as Record<string, unknown>;
  const config = def.config;
  if (!(typeof config === "string" || (config && typeof config === "object" && !Array.isArray(config)))) {
    return "config must be a string or platform map";
  }
  if (def.format !== "json" && def.format !== "toml") return "format must be json or toml";
  if (typeof def.section !== "string" || def.section.length === 0) return "section must be a non-empty string";
  if (def.entry_shape !== undefined && def.entry_shape !== "standard" && def.entry_shape !== "kilo") {
    return "entry_shape must be standard or kilo";
  }
  const status = (def.verified as { status?: unknown } | undefined)?.status;
  if (status !== undefined && status !== "verified" && status !== "community" && status !== "unverified") {
    return "verified.status must be verified, community, or unverified";
  }
  return null;
}

function parseJsonLike(raw: string): unknown {
  return JSON.parse(stripJsonComments(raw));
}

function stripJsonComments(raw: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function getNested(root: unknown, section: string): unknown {
  const parts = section.split(".");
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNested(root: Record<string, unknown>, section: string, value: unknown): void {
  const parts = section.split(".");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function upsertTomlSection(lines: string[], header: string, assignments: string[]): string[] {
  const existingIdx = lines.findIndex((line) => line.trim() === header);
  if (existingIdx === -1) {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    if (out.length > 0) out.push("");
    out.push(header, ...assignments);
    return out;
  }

  let nextHeaderIdx = lines.length;
  for (let i = existingIdx + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      nextHeaderIdx = i;
      break;
    }
  }

  const out = [...lines];
  for (const assignment of assignments) {
    const key = assignment.split("=")[0]!.trim();
    let replaced = false;
    for (let i = existingIdx + 1; i < nextHeaderIdx; i += 1) {
      if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(out[i] ?? "")) {
        out[i] = assignment;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      out.splice(nextHeaderIdx, 0, assignment);
      nextHeaderIdx += 1;
    }
  }
  return out;
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
