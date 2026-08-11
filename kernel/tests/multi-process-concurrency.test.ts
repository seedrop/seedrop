import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateCanonicalId } from "@seedrop/protocol";
import type { CanonicalIdKind } from "@seedrop/protocol";
import {
  reduceProjectTransactions,
  reduceWorkProjection,
  scanProjectTransactions,
} from "@seedrop/project";

const STRESS_LEVELS = [2, 8, 32] as const;
const WORKER = fileURLToPath(new URL("./fixtures/concurrency-worker.ts", import.meta.url));
const roots: string[] = [];
const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff);
const id = <K extends CanonicalIdKind>(kind: K, seed: number) => generateCanonicalId(kind, {
  now: 1_723_379_696_000 + seed,
  entropy: entropy(seed),
});
const PROJECT = id("project", 1);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("multi-process native command concurrency and idempotency", () => {
  it.each(STRESS_LEVELS)("commits all %i CAS writers without a lost acknowledged update", async (writers) => {
    const root = await tempRoot();
    const results = await runWorkers(root, "cas-append", writers);

    expect(results).toHaveLength(writers);
    expect(new Set(results.map((result) => result.pid)).size).toBe(writers);
    expect(results.every((result) => result.status === "committed")).toBe(true);
    expect(new Set(results.map((result) => result.command_id)).size).toBe(writers);
    expect(new Set(results.map((result) => result.transaction_digest)).size).toBe(writers);
    expect(results.reduce((sum, result) => sum + Number(result.conflicts), 0)).toBeGreaterThanOrEqual(writers - 1);

    const scan = await scanProjectTransactions(root, PROJECT);
    const projection = reduceProjectTransactions(scan);
    expect(scan.diagnostics).toEqual([]);
    expect(projection.lag).toMatchObject({ complete: true, unapplied_transactions: 0 });
    expect(projection.transaction_count).toBe(writers);
    expect(projection.applied).toHaveLength(writers);
    expect(new Set(projection.applied.map((entry) => entry.command_id))).toEqual(
      new Set(results.map((result) => result.command_id)),
    );
    expect(new Set(projection.applied.map((entry) => entry.transaction_digest))).toEqual(
      new Set(results.map((result) => result.transaction_digest)),
    );
  }, 120_000);

  it.each(STRESS_LEVELS)("collapses %i duplicate processes to one logical command outcome", async (writers) => {
    const root = await tempRoot();
    const results = await runWorkers(root, "duplicate-open", writers);

    expect(results).toHaveLength(writers);
    expect(new Set(results.map((result) => result.pid)).size).toBe(writers);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(new Set(results.map((result) => result.requested_command_id)).size).toBe(writers);
    expect(new Set(results.map((result) => result.command_id)).size).toBe(1);
    expect(new Set(results.map((result) => result.transaction_digest)).size).toBe(1);
    expect(results.filter((result) => result.idempotent_replay === false)).toHaveLength(1);
    expect(results.filter((result) => result.idempotent_replay === true)).toHaveLength(writers - 1);

    const scan = await scanProjectTransactions(root, PROJECT);
    const project = reduceProjectTransactions(scan);
    const work = reduceWorkProjection(scan);
    expect(scan.diagnostics).toEqual([]);
    expect(project.lag.complete).toBe(true);
    expect(project.transaction_count).toBe(1);
    expect(work.intents).toHaveLength(1);
    expect(work.episodes).toHaveLength(1);
    expect(work.claims).toHaveLength(1);
    expect(work.receipts).toHaveLength(1);
    expect(work.leases).toMatchObject([{ state: "active" }]);
  }, 120_000);

  it.each(STRESS_LEVELS)("elects one Lease winner from %i processes and rejects every loser explicitly", async (writers) => {
    const root = await tempRoot();
    const results = await runWorkers(root, "lease-race", writers);
    expect(new Set(results.map((result) => result.pid)).size).toBe(writers);
    const winners = results.filter((result) => result.status === "completed");
    const losers = results.filter((result) => result.status === "conflict");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(writers - 1);
    expect(losers.every((result) => (
      result.error_code === "seedrop.protocol.project_transaction_conflict"
      || result.error_code === "seedrop.protocol.lease_conflict"
    ))).toBe(true);
    expect(losers.every((result) => typeof result.error_code === "string")).toBe(true);

    const scan = await scanProjectTransactions(root, PROJECT);
    const project = reduceProjectTransactions(scan);
    const work = reduceWorkProjection(scan);
    expect(scan.diagnostics).toEqual([]);
    expect(project.lag.complete).toBe(true);
    expect(project.transaction_count).toBe(1);
    expect(work.intents).toHaveLength(1);
    expect(work.episodes).toHaveLength(1);
    expect(work.leases).toMatchObject([{
      state: "active",
      record: { target: "proof/shared-lease-target" },
    }]);
  }, 120_000);
});

type Scenario = "cas-append" | "duplicate-open" | "lease-race";
type WorkerResult = Readonly<Record<string, unknown>>;

async function runWorkers(root: string, scenario: Scenario, count: number): Promise<readonly WorkerResult[]> {
  return new Promise((resolve, reject) => {
    const children: ChildProcess[] = [];
    const stderr = new Map<number, string>();
    const results: WorkerResult[] = [];
    let ready = 0;
    let snapshots = 0;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`Timed out waiting for ${count} ${scenario} workers.`)), 110_000);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const child of children) child.kill();
      reject(error);
    };

    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const child = fork(WORKER, [scenario, root, String(ordinal)], {
        cwd: process.cwd(),
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      stderr.set(child.pid ?? ordinal, "");
      child.stderr?.on("data", (chunk: Buffer) => {
        const key = child.pid ?? ordinal;
        stderr.set(key, `${stderr.get(key) ?? ""}${chunk.toString("utf8")}`.slice(-4_000));
      });
      let returned = false;
      child.on("message", (message: unknown) => {
        if (!isWorkerMessage(message)) return;
        if (message.type === "ready") {
          ready += 1;
          if (ready === count) for (const worker of children) worker.send("start");
          return;
        }
        if (message.type === "snapshot") {
          if (message.high_watermark !== null) {
            fail(new Error(`CAS worker ${ordinal} did not observe the shared genesis head.`));
            return;
          }
          snapshots += 1;
          if (snapshots === count) for (const worker of children) worker.send("commit");
          return;
        }
        if (message.type === "fatal") {
          fail(new Error(`Worker ${ordinal} failed: ${JSON.stringify(message.error)}\n${stderr.get(child.pid ?? ordinal) ?? ""}`));
          return;
        }
        returned = true;
        results.push(Object.freeze({ ...message.result }));
        if (results.length === count && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(Object.freeze([...results].sort((left, right) => (
            Number(left.ordinal) - Number(right.ordinal)
          ))));
        }
      });
      child.on("error", fail);
      child.on("exit", (code, signal) => {
        if (!settled && !returned) {
          fail(new Error(
            `Worker ${ordinal} exited code=${String(code)} signal=${String(signal)}\n${stderr.get(child.pid ?? ordinal) ?? ""}`,
          ));
        }
      });
    }
  });
}

function isWorkerMessage(value: unknown): value is
  | { type: "ready"; pid: number }
  | { type: "snapshot"; high_watermark: string | null }
  | { type: "result"; result: WorkerResult }
  | { type: "fatal"; error: unknown } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "ready" || record.type === "snapshot"
    || record.type === "result" || record.type === "fatal";
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-kernel-multiprocess-"));
  roots.push(root);
  return root;
}
