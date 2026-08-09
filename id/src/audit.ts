import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import type { ActiveProject, ContinuityState, LearnedBlock, Passport } from "./schema.js";

export interface PassportChanges {
  session_count?: { before: number; after: number };
  last_session_at?: { before?: string; after: string };
  learned_blocks_added?: LearnedBlock[];
  active_projects?: { before: ActiveProject[]; after: ActiveProject[] };
  continuity?: { before?: ContinuityState; after?: ContinuityState };
}

export interface AuditEntry {
  timestamp: string;
  before_hash: string;
  after_hash: string;
  prev_hash: string | null;
  changes: PassportChanges;
  notes?: string;
}

export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .filter((k) => obj[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new TypeError(`canonicalJSON does not support values of type ${typeof value}`);
}

export function hashPassport(passport: Passport): string {
  return createHash("sha256").update(canonicalJSON(passport)).digest("hex");
}

export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

export async function readAuditLog(path: string): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch (error) {
        throw new Error(`Failed to parse passport audit entry ${index + 1} at ${path}`, { cause: error });
      }
    });
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const prior = entries[index - 1];
    const expectedPrev = prior?.after_hash ?? null;
    if (entry.prev_hash !== expectedPrev) {
      throw new Error(`Passport audit chain mismatch at entry ${index + 1} in ${path}`);
    }
  }
  return entries;
}

export function reversePassportChange(passport: Passport, entry: AuditEntry): Passport {
  const next: Passport = {
    ...passport,
    metadata: { ...passport.metadata },
    learned_blocks: [...passport.learned_blocks],
  };
  const c = entry.changes;
  if (c.session_count) {
    next.metadata.session_count = c.session_count.before;
  }
  if (c.last_session_at) {
    if (c.last_session_at.before === undefined) {
      delete next.metadata.last_session_at;
    } else {
      next.metadata.last_session_at = c.last_session_at.before;
    }
  }
  if (c.learned_blocks_added && c.learned_blocks_added.length > 0) {
    const removed = c.learned_blocks_added.length;
    next.learned_blocks = next.learned_blocks.slice(0, next.learned_blocks.length - removed);
  }
  if (c.active_projects) {
    next.active_projects = c.active_projects.before;
  }
  if (c.continuity) {
    if (c.continuity.before === undefined) {
      delete next.continuity;
    } else {
      next.continuity = c.continuity.before;
    }
  }
  return next;
}
