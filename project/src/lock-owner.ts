import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonBytes } from "@seedrop/protocol";
import type { ProjectTransactionDigest } from "@seedrop/protocol";

export const PROJECT_WRITER_LOCK_OWNER_FILE = "owner.json" as const;

export interface ProjectWriterLockOwner {
  schema_version: "1.0";
  token: string;
  hostname: string;
  pid: number;
  acquired_at: string;
  stale_after: string;
}

export type ProjectWriterLockOwnerRead =
  | { status: "absent_lock" }
  | { status: "missing_owner"; path: string }
  | { status: "read_failed"; path: string; error_code: string }
  | { status: "invalid"; path: string; code: "invalid_json" | "invalid_lock_owner" | "noncanonical_bytes"; byte_length: number; content_digest: ProjectTransactionDigest }
  | { status: "valid"; path: string; owner: ProjectWriterLockOwner; byte_length: number; content_digest: ProjectTransactionDigest };

export async function readProjectWriterLockOwner(lockPath: string): Promise<ProjectWriterLockOwnerRead> {
  const ownerPath = join(lockPath, PROJECT_WRITER_LOCK_OWNER_FILE);
  let bytes: Buffer;
  try {
    bytes = await readFile(ownerPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return { status: "read_failed", path: ownerPath, error_code: errorCode(error) };
    }
    try {
      await stat(lockPath);
      return { status: "missing_owner", path: ownerPath };
    } catch (lockError) {
      if (errorCode(lockError) === "ENOENT") return { status: "absent_lock" };
      return { status: "read_failed", path: ownerPath, error_code: errorCode(lockError) };
    }
  }
  const contentDigest = rawDigest(bytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { status: "invalid", path: ownerPath, code: "invalid_json", byte_length: bytes.byteLength, content_digest: contentDigest };
  }
  if (!isProjectWriterLockOwner(decoded)) {
    return { status: "invalid", path: ownerPath, code: "invalid_lock_owner", byte_length: bytes.byteLength, content_digest: contentDigest };
  }
  if (!bytes.equals(Buffer.from(canonicalJsonBytes(decoded)))) {
    return { status: "invalid", path: ownerPath, code: "noncanonical_bytes", byte_length: bytes.byteLength, content_digest: contentDigest };
  }
  return { status: "valid", path: ownerPath, owner: decoded, byte_length: bytes.byteLength, content_digest: contentDigest };
}

function isProjectWriterLockOwner(value: unknown): value is ProjectWriterLockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectWriterLockOwner>;
  if (Object.keys(value).sort().join(",") !== "acquired_at,hostname,pid,schema_version,stale_after,token") return false;
  return candidate.schema_version === "1.0"
    && typeof candidate.token === "string" && candidate.token.length > 0
    && typeof candidate.hostname === "string" && candidate.hostname.length > 0
    && Number.isSafeInteger(candidate.pid) && (candidate.pid ?? 0) > 0
    && typeof candidate.acquired_at === "string" && Number.isFinite(Date.parse(candidate.acquired_at))
    && typeof candidate.stale_after === "string" && Number.isFinite(Date.parse(candidate.stale_after));
}

function rawDigest(bytes: Uint8Array): ProjectTransactionDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ProjectTransactionDigest;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}
