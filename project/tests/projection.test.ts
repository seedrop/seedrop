import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { projectTransactionDigest } from "@seedrop/protocol";
import {
  deleteProjectProjectionIndex,
  projectProjectionBytes,
  projectProjectionDigest,
  projectStoreLayout,
  publishProjectTransaction,
  rebuildProjectProjection,
  reduceProjectTransactions,
  scanProjectTransactions,
} from "../src/index.js";
import { makeTransaction, PROJECT_ID } from "./fixtures.js";

const roots: string[] = [];
const exec = promisify(execFile);
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function storeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-project-projection-"));
  roots.push(root);
  return root;
}

describe("deterministic project reducer", () => {
  it("produces identical bytes for every discovery order", async () => {
    const root = await storeRoot();
    const first = makeTransaction(1, null);
    const second = makeTransaction(2, projectTransactionDigest(first));
    const third = makeTransaction(3, projectTransactionDigest(second));
    for (const transaction of [third, first, second]) await publishProjectTransaction({ root, transaction });
    const scan = await scanProjectTransactions(root, PROJECT_ID);
    const forward = reduceProjectTransactions(scan);
    const reverse = reduceProjectTransactions({ ...scan, transactions: [...scan.transactions].reverse() });

    expect(projectProjectionBytes(reverse)).toEqual(projectProjectionBytes(forward));
    expect(forward.lag).toEqual({
      committed_transactions: 3,
      applied_transactions: 3,
      unapplied_transactions: 0,
      quarantined_artifacts: 0,
      complete: true,
    });
    expect(forward.source_high_watermark).toBe(projectTransactionDigest(third));
    expect(forward.transaction_count).toBe(3);
    expect(forward.event_count).toBe(3);
  });

  it("refuses to choose across a fork and exposes every unapplied branch", async () => {
    const root = await storeRoot();
    const first = makeTransaction(1, null);
    const firstDigest = projectTransactionDigest(first);
    const left = makeTransaction(2, firstDigest);
    const right = makeTransaction(3, firstDigest);
    for (const transaction of [first, left, right]) await publishProjectTransaction({ root, transaction });

    const projection = reduceProjectTransactions(await scanProjectTransactions(root, PROJECT_ID));
    expect(projection.applied.map((entry) => entry.transaction_digest)).toEqual([firstDigest]);
    expect(projection.lag.unapplied_transactions).toBe(2);
    expect(projection.lag.complete).toBe(false);
    expect(projection.quarantined.filter((item) => item.code === "fork")).toHaveLength(2);
  });

  it("preserves a missing predecessor as typed lag instead of inventing a root", async () => {
    const root = await storeRoot();
    const missing = makeTransaction(2, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await publishProjectTransaction({ root, transaction: missing });
    const projection = reduceProjectTransactions(await scanProjectTransactions(root, PROJECT_ID));
    expect(projection.applied).toEqual([]);
    expect(new Set(projection.quarantined.map((item) => item.code))).toEqual(new Set(["missing_predecessor", "cycle_or_no_root"]));
    expect(projection.lag).toMatchObject({ committed_transactions: 1, applied_transactions: 0, unapplied_transactions: 1, complete: false });
  });

  it("rejects duplicate command and Event identities without selecting a transaction", async () => {
    const root = await storeRoot();
    const first = makeTransaction(1, null);
    const duplicate = makeTransaction(2, null, {
      commandId: first.command_id,
      eventId: first.events[0]!.event_id,
    });
    await publishProjectTransaction({ root, transaction: first });
    await publishProjectTransaction({ root, transaction: duplicate });
    const projection = reduceProjectTransactions(await scanProjectTransactions(root, PROJECT_ID));
    expect(projection.applied).toEqual([]);
    expect(new Set(projection.quarantined.map((item) => item.code))).toEqual(new Set([
      "duplicate_command", "duplicate_event", "multiple_roots",
    ]));
  });
});

describe("disposable projection and Git-portable canonical truth", () => {
  it("accounts for unexpected nested artifact bytes in quarantine and source invalidation", async () => {
    const root = await storeRoot();
    const rogue = join(projectStoreLayout(root).transactions_dir, "rogue", "nested", "evidence.bin");
    await mkdir(join(projectStoreLayout(root).transactions_dir, "rogue", "nested"), { recursive: true });
    await writeFile(rogue, "first");
    const first = await rebuildProjectProjection(root, PROJECT_ID);
    await writeFile(rogue, "second");
    const second = await rebuildProjectProjection(root, PROJECT_ID);
    expect(first.quarantined).toEqual([
      expect.objectContaining({ code: "unexpected_path", path: "transactions/rogue/nested/evidence.bin" }),
    ]);
    expect(second.source_digest).not.toBe(first.source_digest);
  });

  it("delete/rebuild emits byte-identical projection and index bytes", async () => {
    const root = await storeRoot();
    const first = makeTransaction(1, null);
    const second = makeTransaction(2, projectTransactionDigest(first));
    await publishProjectTransaction({ root, transaction: first });
    await publishProjectTransaction({ root, transaction: second });

    const firstProjection = await rebuildProjectProjection(root, PROJECT_ID);
    const firstBytes = projectProjectionBytes(firstProjection);
    const firstIndex = await readFile(projectStoreLayout(root).projection_index);
    await deleteProjectProjectionIndex(root);
    const rebuilt = await rebuildProjectProjection(root, PROJECT_ID);
    const rebuiltIndex = await readFile(projectStoreLayout(root).projection_index);

    expect(projectProjectionBytes(rebuilt)).toEqual(firstBytes);
    expect(rebuiltIndex).toEqual(firstIndex);
    expect(projectProjectionDigest(rebuilt)).toBe(projectProjectionDigest(firstProjection));
  });

  it("catches a persisted projection up to a newly committed transaction", async () => {
    const root = await storeRoot();
    const first = makeTransaction(1, null);
    await publishProjectTransaction({ root, transaction: first });
    const before = await rebuildProjectProjection(root, PROJECT_ID);
    const second = makeTransaction(2, before.source_high_watermark);
    await publishProjectTransaction({ root, transaction: second });
    const after = await rebuildProjectProjection(root, PROJECT_ID);
    expect(after.applied.map((entry) => entry.transaction_digest)).toEqual([
      projectTransactionDigest(first), projectTransactionDigest(second),
    ]);
    expect(after.source_high_watermark).toBe(projectTransactionDigest(second));
    expect(after.lag.complete).toBe(true);
  });

  it("a clean copy containing only canonical transactions rebuilds the same truth", async () => {
    const source = await storeRoot();
    const clone = await storeRoot();
    const first = makeTransaction(1, null);
    const second = makeTransaction(2, projectTransactionDigest(first));
    await publishProjectTransaction({ root: source, transaction: first });
    await publishProjectTransaction({ root: source, transaction: second });
    const sourceProjection = await rebuildProjectProjection(source, PROJECT_ID);

    await cp(projectStoreLayout(source).transactions_dir, projectStoreLayout(clone).transactions_dir, { recursive: true });
    const cloneProjection = await rebuildProjectProjection(clone, PROJECT_ID);
    expect(projectProjectionBytes(cloneProjection)).toEqual(projectProjectionBytes(sourceProjection));
    expect(cloneProjection.source_digest).toBe(sourceProjection.source_digest);
    expect(cloneProjection.source_high_watermark).toBe(sourceProjection.source_high_watermark);
  });

  it("an actual Git clone reproduces canonical digests and projection bytes", async () => {
    const sourceRepo = await storeRoot();
    const cloneParent = await storeRoot();
    const cloneRepo = join(cloneParent, "clone");
    const sourceStore = join(sourceRepo, ".seedrop", "view", "v2", "project");
    const cloneStore = join(cloneRepo, ".seedrop", "view", "v2", "project");
    const first = makeTransaction(1, null);
    const second = makeTransaction(2, projectTransactionDigest(first));
    await publishProjectTransaction({ root: sourceStore, transaction: first });
    await publishProjectTransaction({ root: sourceStore, transaction: second });

    await exec("git", ["init", "--quiet", sourceRepo]);
    await exec("git", ["-C", sourceRepo, "config", "user.name", "Seedrop Proof"]);
    await exec("git", ["-C", sourceRepo, "config", "user.email", "proof@seedrop.local"]);
    await exec("git", ["-C", sourceRepo, "add", ".seedrop/view/v2/project/transactions"]);
    await exec("git", ["-C", sourceRepo, "commit", "--quiet", "-m", "canonical project truth"]);
    await exec("git", ["clone", "--quiet", sourceRepo, cloneRepo]);

    const sourceProjection = await rebuildProjectProjection(sourceStore, PROJECT_ID);
    const cloneProjection = await rebuildProjectProjection(cloneStore, PROJECT_ID);
    expect(projectProjectionBytes(cloneProjection)).toEqual(projectProjectionBytes(sourceProjection));
    expect(cloneProjection.source_digest).toBe(sourceProjection.source_digest);
    expect(cloneProjection.source_high_watermark).toBe(sourceProjection.source_high_watermark);
  });
});
