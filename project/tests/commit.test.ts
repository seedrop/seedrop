import { hostname } from "node:os";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProtocolError, canonicalJsonBytes, projectTransactionDigest } from "@seedrop/protocol";
import {
  acquireProjectWriterLock,
  commitProjectTransaction,
  projectStoreLayout,
  scanProjectTransactions,
} from "../src/index.js";
import { PROJECT_ID, makeTransaction } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project expected-version commit", () => {
  it("commits once and returns the same authoritative transaction on retry", async () => {
    const root = await tempRoot();
    const transaction = makeTransaction(1, null);
    const digest = projectTransactionDigest(transaction);
    const first = await commitProjectTransaction({ root, transaction, expected_high_watermark: null });
    const retry = await commitProjectTransaction({ root, transaction, expected_high_watermark: null });
    expect(first.status).toBe("committed");
    expect(first.projection.source_high_watermark).toBe(digest);
    expect(retry.status).toBe("already_committed");
    expect(retry.transaction.status).toBe("already_present");
    expect((await scanProjectTransactions(root, PROJECT_ID)).transactions).toHaveLength(1);
  });

  it("rejects stale writers without publishing a fork", async () => {
    const root = await tempRoot();
    await commitProjectTransaction({ root, transaction: makeTransaction(1, null), expected_high_watermark: null });
    await expect(commitProjectTransaction({
      root,
      transaction: makeTransaction(2, null),
      expected_high_watermark: null,
    })).rejects.toMatchObject({
      code: "seedrop.protocol.project_transaction_conflict",
      details: { reason: "expected_high_watermark_mismatch" },
    });
    expect((await scanProjectTransactions(root, PROJECT_ID)).transactions).toHaveLength(1);
  });

  it("serializes concurrent writers so exactly one expected-version CAS wins", async () => {
    const root = await tempRoot();
    const results = await Promise.allSettled([
      commitProjectTransaction({ root, transaction: makeTransaction(1, null), expected_high_watermark: null }),
      commitProjectTransaction({ root, transaction: makeTransaction(2, null), expected_high_watermark: null }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const scan = await scanProjectTransactions(root, PROJECT_ID);
    expect(scan.transactions).toHaveLength(1);
    expect(scan.diagnostics).toEqual([]);
  });

  it("recovers a committed transaction after a crash before projection publication", async () => {
    const root = await tempRoot();
    const transaction = makeTransaction(1, null);
    await expect(commitProjectTransaction({
      root,
      transaction,
      expected_high_watermark: null,
      fault: (boundary) => {
        if (boundary === "after_transaction_publish") throw new Error("injected crash");
      },
    })).rejects.toThrow("injected crash");
    expect((await scanProjectTransactions(root, PROJECT_ID)).transactions).toHaveLength(1);
    const recovered = await commitProjectTransaction({ root, transaction, expected_high_watermark: null });
    expect(recovered.status).toBe("already_committed");
    expect(recovered.projection.source_high_watermark).toBe(projectTransactionDigest(transaction));
  });
});

describe("project writer lock", () => {
  it("will not steal a live local writer lock", async () => {
    const root = await tempRoot();
    const held = await acquireProjectWriterLock(root);
    try {
      await expect(acquireProjectWriterLock(root, {
        acquisition_timeout_ms: 20,
        poll_interval_ms: 2,
        stale_after_ms: 5,
      })).rejects.toMatchObject({
        code: "seedrop.protocol.project_transaction_conflict",
        details: { reason: "writer_lock_busy" },
      });
    } finally {
      await held.release();
    }
  });

  it("recovers only an expired lock owned by a dead local process", async () => {
    const root = await tempRoot();
    const layout = projectStoreLayout(root);
    await mkdir(layout.writer_lock, { recursive: true });
    await writeFile(join(layout.writer_lock, "owner.json"), canonicalJsonBytes({
      schema_version: "1.0",
      token: "dead-owner",
      hostname: hostname(),
      pid: 2_147_483_647,
      acquired_at: "2026-08-11T09:00:00.000Z",
      stale_after: "2026-08-11T09:00:01.000Z",
    }));
    const held = await acquireProjectWriterLock(root, {
      acquisition_timeout_ms: 100,
      poll_interval_ms: 2,
      stale_after_ms: 5,
    });
    await held.assertOwned();
    await held.release();
    await expect(readFile(join(layout.writer_lock, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without deleting malformed writer-lock evidence", async () => {
    const root = await tempRoot();
    const layout = projectStoreLayout(root);
    const ownerPath = join(layout.writer_lock, "owner.json");
    await mkdir(layout.writer_lock, { recursive: true });
    await writeFile(ownerPath, "{\"truncated\":");
    await expect(acquireProjectWriterLock(root, {
      acquisition_timeout_ms: 20,
      poll_interval_ms: 2,
      stale_after_ms: 1,
    })).rejects.toMatchObject({
      code: "seedrop.protocol.project_transaction_conflict",
      details: { reason: "writer_lock_invalid", diagnostic_code: "invalid_json" },
    });
    expect(await readFile(ownerPath, "utf8")).toBe("{\"truncated\":");
  });

  it("returns a typed conflict and preserves an unreadable writer-lock owner", async () => {
    const root = await tempRoot();
    const layout = projectStoreLayout(root);
    const ownerPath = join(layout.writer_lock, "owner.json");
    await mkdir(layout.writer_lock, { recursive: true });
    await writeFile(ownerPath, "evidence");
    await chmod(ownerPath, 0o000);
    try {
      await expect(acquireProjectWriterLock(root, {
        acquisition_timeout_ms: 20,
        poll_interval_ms: 2,
        stale_after_ms: 1,
      })).rejects.toMatchObject({
        code: "seedrop.protocol.project_transaction_conflict",
        details: { reason: "writer_lock_unreadable", error_code: "EACCES" },
      });
    } finally {
      await chmod(ownerPath, 0o600);
    }
    expect(await readFile(ownerPath, "utf8")).toBe("evidence");
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-project-commit-"));
  roots.push(root);
  return root;
}
