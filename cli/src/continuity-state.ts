import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = "1.0";

export interface ContinuityState {
  schema_version: string;
  last_seen_at?: string;
}

export function continuityStatePath(agentId: string): string {
  const slug = agentId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || agentId;
  return join(homedir(), ".seedrop", "state", `continuity-${slug}.json`);
}

export async function readContinuityState(agentId: string): Promise<ContinuityState | null> {
  const path = continuityStatePath(agentId);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ContinuityState;
    if (parsed.schema_version !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeContinuityState(agentId: string, state: ContinuityState): Promise<void> {
  const path = continuityStatePath(agentId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...state, schema_version: SCHEMA_VERSION }, null, 2), "utf8");
}
