import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProtocolError,
  projectTransactionBytes,
  projectTransactionDigest,
} from "@seedrop/protocol";
import type { ProjectTransactionDigest } from "@seedrop/protocol";
import {
  projectStoreLayout,
  projectTransactionRelativePath,
  publishProjectTransaction,
  scanProjectTransactions,
} from "../src/index.js";
import type { ProjectPublishBoundary } from "../src/index.js";
import { makeTransaction, OTHER_PROJECT_ID, PROJECT_ID } from "./fixtures.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function storeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-project-store-"));
  roots.push(root);
  return root;
}

describe("content-addressed project transaction publication", () => {
  it("publishes immutable canonical bytes and treats an identical retry as one logical transaction", async () => {
    const root = await storeRoot();
    const transaction = makeTransaction(1, null);
    const digest = projectTransactionDigest(transaction);
    const first = await publishProjectTransaction({ root, transaction });
    const second = await publishProjectTransaction({ root, transaction });

    expect(first).toMatchObject({ status: "published", digest, relative_path: projectTransactionRelativePath(digest) });
    expect(second.status).toBe("already_present");
    const bytes = await readFile(join(root, ...first.relative_path.split("/")));
    expect(bytes.equals(Buffer.from(projectTransactionBytes(transaction)))).toBe(true);
    const scan = await scanProjectTransactions(root, PROJECT_ID);
    expect(scan.transactions).toHaveLength(1);
    expect(scan.sources).toEqual([expect.objectContaining({ status: "valid", expected_digest: digest, actual_digest: digest })]);
    expect(scan.diagnostics).toEqual([]);
  });

  it("never acknowledges before the file and containing directory are synced", async () => {
    const root = await storeRoot();
    const observed: ProjectPublishBoundary[] = [];
    await publishProjectTransaction({
      root,
      transaction: makeTransaction(1, null),
      fault: (boundary) => { observed.push(boundary); },
    });
    expect(observed).toEqual([
      "before_temp_write", "after_temp_write", "after_file_sync", "after_publish", "after_directory_sync",
    ]);
  });

  it("refuses to replace an existing content address whose bytes differ", async () => {
    const root = await storeRoot();
    const transaction = makeTransaction(1, null);
    const receipt = await publishProjectTransaction({ root, transaction });
    const path = join(root, ...receipt.relative_path.split("/"));
    await writeFile(path, Buffer.alloc(receipt.byte_length, 0x20));
    await expect(publishProjectTransaction({ root, transaction })).rejects.toMatchObject<Partial<ProtocolError>>({
      code: "seedrop.protocol.project_transaction_digest_mismatch",
    });
    expect(await readFile(path)).toEqual(Buffer.alloc(receipt.byte_length, 0x20));
  });

  it.each<ProjectPublishBoundary>([
    "before_temp_write",
    "after_temp_write",
    "after_file_sync",
    "after_publish",
    "after_directory_sync",
  ])("exposes the whole transaction or none after a crash at %s", async (boundary) => {
    const root = await storeRoot();
    const transaction = makeTransaction(1, null);
    await expect(publishProjectTransaction({
      root,
      transaction,
      fault: (observed) => {
        if (observed === boundary) throw new Error(`crash:${boundary}`);
      },
    })).rejects.toThrow(`crash:${boundary}`);

    const afterCrash = await scanProjectTransactions(root, PROJECT_ID);
    const committed = boundary === "after_publish" || boundary === "after_directory_sync";
    expect(afterCrash.transactions).toHaveLength(committed ? 1 : 0);
    expect(afterCrash.transactions.every((entry) => entry.digest === projectTransactionDigest(transaction))).toBe(true);

    await publishProjectTransaction({ root, transaction });
    const recovered = await scanProjectTransactions(root, PROJECT_ID);
    expect(recovered.transactions).toHaveLength(1);
    expect(recovered.transactions[0]?.transaction).toEqual(transaction);
  });
});

describe("honest project artifact discovery", () => {
  it("reports corrupt, noncanonical, malformed, unexpected, and wrong-project artifacts without deleting bytes", async () => {
    const root = await storeRoot();
    const valid = makeTransaction(1, null);
    const validReceipt = await publishProjectTransaction({ root, transaction: valid });
    const validPath = join(root, ...validReceipt.relative_path.split("/"));
    await writeFile(validPath, Buffer.from("{\"truncated\":"));

    const invalidJson = Buffer.from("{", "utf8");
    const invalidJsonPath = await writeRaw(root, invalidJson);
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
    const invalidUtf8Path = await writeRaw(root, invalidUtf8);
    const noncanonical = Buffer.from(JSON.stringify(makeTransaction(2, null), null, 2));
    const noncanonicalPath = await writeRaw(root, noncanonical);
    const wrongProject = makeTransaction(3, null, { projectId: OTHER_PROJECT_ID });
    await publishProjectTransaction({ root, transaction: wrongProject });
    await writeFile(join(projectStoreLayout(root).transactions_dir, "unexpected.txt"), "evidence");

    const scan = await scanProjectTransactions(root, PROJECT_ID);
    expect(scan.transactions).toEqual([]);
    expect(new Set(scan.diagnostics.map((item) => item.code))).toEqual(new Set([
      "digest_mismatch", "invalid_json", "invalid_utf8", "noncanonical_bytes", "project_mismatch", "unexpected_path",
    ]));
    expect(await readFile(validPath, "utf8")).toBe("{\"truncated\":");
    expect(await readFile(invalidJsonPath)).toEqual(invalidJson);
    expect(await readFile(invalidUtf8Path)).toEqual(invalidUtf8);
    expect(await readFile(noncanonicalPath)).toEqual(noncanonical);
  });

  it("returns a typed read_failed diagnostic for an unreadable canonical artifact", async () => {
    const root = await storeRoot();
    const receipt = await publishProjectTransaction({ root, transaction: makeTransaction(1, null) });
    const path = join(root, ...receipt.relative_path.split("/"));
    await chmod(path, 0o000);
    try {
      const scan = await scanProjectTransactions(root, PROJECT_ID);
      expect(scan.diagnostics).toEqual([
        expect.objectContaining({ code: "read_failed", path: receipt.relative_path, details: { error_code: "EACCES" } }),
      ]);
      expect(scan.transactions).toEqual([]);
    } finally {
      await chmod(path, 0o600);
    }
  });

  it("contains a denied transaction subtree as a typed diagnostic instead of aborting the scan", async () => {
    const root = await storeRoot();
    const receipt = await publishProjectTransaction({ root, transaction: makeTransaction(1, null) });
    const prefix = dirname(join(root, ...receipt.relative_path.split("/")));
    await chmod(prefix, 0o000);
    try {
      const scan = await scanProjectTransactions(root, PROJECT_ID);
      expect(scan.transactions).toEqual([]);
      expect(scan.diagnostics).toEqual([
        expect.objectContaining({ code: "read_failed", path: receipt.relative_path.split("/").slice(0, 2).join("/"), details: { error_code: "EACCES" } }),
      ]);
    } finally {
      await chmod(prefix, 0o700);
    }
  });
});

async function writeRaw(root: string, bytes: Uint8Array): Promise<string> {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ProjectTransactionDigest;
  const relativePath = projectTransactionRelativePath(digest);
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}
