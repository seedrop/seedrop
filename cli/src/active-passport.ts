import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = "1.0";

export interface ActivePassportState {
  schema_version: string;
  agent_id: string;
  passport_path: string;
  set_at: string;
}

export function activePassportStatePath(): string {
  return join(homedir(), ".seedrop", "state", "active-passport.json");
}

/**
 * Synchronous read for hot paths (defaultPassportPath()). Returns null on
 * missing/invalid file rather than throwing.
 */
export function readActivePassportSync(): ActivePassportState | null {
  const path = activePassportStatePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ActivePassportState;
    if (parsed.schema_version !== SCHEMA_VERSION) return null;
    if (!parsed.passport_path || !parsed.agent_id) return null;
    if (!existsSync(parsed.passport_path)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readActivePassport(): Promise<ActivePassportState | null> {
  const path = activePassportStatePath();
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ActivePassportState;
    if (parsed.schema_version !== SCHEMA_VERSION) return null;
    if (!parsed.passport_path || !parsed.agent_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeActivePassport(state: Omit<ActivePassportState, "schema_version">): Promise<void> {
  const path = activePassportStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ schema_version: SCHEMA_VERSION, ...state }, null, 2),
    "utf8",
  );
}

export async function clearActivePassport(): Promise<boolean> {
  const path = activePassportStatePath();
  if (!existsSync(path)) return false;
  await rm(path, { force: true });
  return true;
}
