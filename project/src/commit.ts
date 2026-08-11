import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  projectTransactionDigest,
  protocolError,
} from "@seedrop/protocol";
import { projectStoreLayout } from "./layout.js";
import {
  PROJECT_WRITER_LOCK_OWNER_FILE,
  readProjectWriterLockOwner,
} from "./lock-owner.js";
import type { ProjectWriterLockOwner } from "./lock-owner.js";
import { projectProjectionDigest, rebuildProjectProjection, reduceProjectTransactions } from "./projection.js";
import { publishProjectTransaction, scanProjectTransactions } from "./store.js";
import type {
  ProjectCommitOptions,
  ProjectCommitReceipt,
  ProjectProjectionReference,
  ProjectWriterLockOptions,
} from "./types.js";

const DEFAULT_ACQUISITION_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 10;
export interface HeldProjectWriterLock {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export async function commitProjectTransaction(options: ProjectCommitOptions): Promise<ProjectCommitReceipt> {
  const lock = await acquireProjectWriterLock(options.root, options.lock);
  try {
    await options.fault?.("after_lock_acquired");
    const before = reduceProjectTransactions(await scanProjectTransactions(
      options.root,
      options.transaction.project_id,
    ));
    assertCompleteProjection(before, "before_commit");
    await options.fault?.("after_snapshot");

    const digest = projectTransactionDigest(options.transaction);
    const alreadyCommitted = before.source_high_watermark === digest;
    if (!alreadyCommitted && before.source_high_watermark !== options.expected_high_watermark) {
      throw protocolError("seedrop.protocol.project_transaction_conflict", {
        reason: "expected_high_watermark_mismatch",
        expected: options.expected_high_watermark,
        observed: before.source_high_watermark,
      });
    }
    if (options.transaction.previous_transaction_digest !== options.expected_high_watermark) {
      throw protocolError("seedrop.protocol.project_transaction_conflict", {
        reason: "transaction_predecessor_mismatch",
        expected: options.expected_high_watermark,
        found: options.transaction.previous_transaction_digest,
      });
    }
    if (alreadyCommitted && before.applied.at(-1)?.command_id !== options.transaction.command_id) {
      throw protocolError("seedrop.protocol.project_transaction_conflict", {
        reason: "committed_digest_command_mismatch",
        digest,
      });
    }

    const published = await publishProjectTransaction({
      root: options.root,
      transaction: options.transaction,
      fault: options.publish_fault,
      publication_guard: lock.assertOwned,
    });
    await options.fault?.("after_transaction_publish");
    const projection = await rebuildProjectProjection(options.root, options.transaction.project_id);
    assertCompleteProjection(projection, "after_commit");
    if (projection.source_high_watermark !== digest) {
      throw protocolError("seedrop.protocol.project_projection_inconsistent", {
        reason: "committed_transaction_not_high_watermark",
        expected: digest,
        observed: projection.source_high_watermark,
      });
    }
    await options.fault?.("after_projection");
    const projectionReference: ProjectProjectionReference = Object.freeze({
      project_id: projection.project_id,
      projection_version: projection.projection_version,
      source_high_watermark: projection.source_high_watermark,
      source_digest: projection.source_digest,
    });
    return Object.freeze({
      status: alreadyCommitted ? "already_committed" : "committed",
      transaction: published,
      previous_high_watermark: options.expected_high_watermark,
      projection: projectionReference,
    });
  } finally {
    await lock.release();
  }
}

export async function acquireProjectWriterLock(
  root: string,
  input: ProjectWriterLockOptions = {},
): Promise<HeldProjectWriterLock> {
  const acquisitionTimeout = positiveInteger(input.acquisition_timeout_ms, DEFAULT_ACQUISITION_TIMEOUT_MS, "acquisition_timeout_ms");
  const staleAfter = positiveInteger(input.stale_after_ms, DEFAULT_STALE_AFTER_MS, "stale_after_ms");
  const pollInterval = positiveInteger(input.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, "poll_interval_ms");
  const layout = projectStoreLayout(root);
  await mkdir(layout.locks_dir, { recursive: true });
  const deadline = Date.now() + acquisitionTimeout;
  const localHostname = hostname();

  while (true) {
    const now = Date.now();
    const owner: ProjectWriterLockOwner = Object.freeze({
      schema_version: "1.0",
      token: randomUUID(),
      hostname: localHostname,
      pid: process.pid,
      acquired_at: new Date(now).toISOString(),
      stale_after: new Date(now + staleAfter).toISOString(),
    });
    try {
      await mkdir(layout.writer_lock);
      const ownerPath = join(layout.writer_lock, PROJECT_WRITER_LOCK_OWNER_FILE);
      const handle = await open(ownerPath, "wx", 0o600);
      try {
        await handle.writeFile(canonicalJsonBytes(owner));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(layout.writer_lock);
      await syncDirectory(layout.locks_dir);
      return heldLock(layout.writer_lock, layout.locks_dir, owner);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await recoverDeadLocalLock(layout.writer_lock, layout.locks_dir, localHostname, now, staleAfter);
      if (Date.now() >= deadline) {
        throw protocolError("seedrop.protocol.project_transaction_conflict", {
          reason: "writer_lock_busy",
          lock_path: "locks/project-writer.lock",
        });
      }
      await delay(Math.min(pollInterval, Math.max(1, deadline - Date.now())));
    }
  }
}

function heldLock(lockPath: string, locksDir: string, owner: ProjectWriterLockOwner): HeldProjectWriterLock {
  let released = false;
  const assertOwned = async (): Promise<void> => {
    if (released) throw lockLost();
    const observed = await readProjectWriterLockOwner(lockPath);
    if (observed.status !== "valid" || observed.owner.token !== owner.token
      || observed.owner.pid !== owner.pid || observed.owner.hostname !== owner.hostname) throw lockLost();
  };
  return {
    assertOwned,
    release: async () => {
      if (released) return;
      await assertOwned();
      released = true;
      await rm(lockPath, { recursive: true, force: false });
      await syncDirectory(locksDir);
    },
  };
}

async function recoverDeadLocalLock(
  lockPath: string,
  locksDir: string,
  localHostname: string,
  now: number,
  staleAfterMs: number,
): Promise<void> {
  const observed = await readProjectWriterLockOwner(lockPath);
  let stale = false;
  if (observed.status === "valid") {
    const owner = observed.owner;
    stale = owner.hostname === localHostname
      && Date.parse(owner.stale_after) <= now
      && !isProcessAlive(owner.pid);
  } else if (observed.status === "missing_owner") {
    try {
      const info = await stat(lockPath);
      stale = now - info.mtimeMs >= staleAfterMs;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
  } else if (observed.status === "absent_lock") {
    return;
  } else {
    // mkdir(owner lock) and writing owner.json are separate filesystem steps. A
    // concurrent contender may briefly observe empty/partial bytes; treat that
    // bounded publication window as busy, then fail closed once it is stale.
    let lockAgeMs = staleAfterMs;
    try {
      const info = await stat(lockPath);
      lockAgeMs = now - info.mtimeMs;
      if (lockAgeMs < staleAfterMs) return;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    throw protocolError("seedrop.protocol.project_transaction_conflict", {
      reason: observed.status === "read_failed" ? "writer_lock_unreadable" : "writer_lock_invalid",
      lock_path: "locks/project-writer.lock/owner.json",
      lock_age_ms: Math.max(0, Math.floor(lockAgeMs)),
      stale_after_ms: staleAfterMs,
      ...(observed.status === "read_failed" ? { error_code: observed.error_code } : { diagnostic_code: observed.code }),
    });
  }
  if (!stale) return;
  const quarantine = join(locksDir, `.stale-project-writer.${randomUUID()}`);
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  await syncDirectory(locksDir);
  await rm(quarantine, { recursive: true, force: true });
  await syncDirectory(locksDir);
}

function assertCompleteProjection(
  projection: { lag: { complete: boolean }; quarantined: readonly unknown[] },
  phase: string,
): void {
  if (!projection.lag.complete) {
    throw protocolError("seedrop.protocol.project_transaction_conflict", {
      reason: "projection_incomplete",
      phase,
      quarantine_count: projection.quarantined.length,
    });
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw protocolError("seedrop.protocol.project_transaction_conflict", { reason: "invalid_lock_option", field });
  }
  return resolved;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function lockLost() {
  return protocolError("seedrop.protocol.project_transaction_conflict", { reason: "writer_lock_lost" });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}
