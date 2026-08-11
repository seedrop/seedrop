import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  ProtocolError,
  buildProjectTransaction,
  projectTransactionBytes,
  projectTransactionDigest,
  protocolError,
} from "@seedrop/protocol";
import type { CanonicalId, ProjectTransaction, ProjectTransactionDigest } from "@seedrop/protocol";
import { projectStoreLayout, projectTransactionRelativePath } from "./layout.js";
import type {
  ProjectArtifactDiagnostic,
  ProjectLogScan,
  ProjectPublishBoundary,
  ProjectPublishOptions,
  ProjectPublishReceipt,
  ProjectSourceArtifact,
  ProjectStoredTransaction,
} from "./types.js";

const FINAL_PATH = /^transactions\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/;

export async function publishProjectTransaction(options: ProjectPublishOptions): Promise<ProjectPublishReceipt> {
  const layout = projectStoreLayout(options.root);
  const bytes = projectTransactionBytes(options.transaction);
  const digest = projectTransactionDigest(options.transaction);
  const relativePath = projectTransactionRelativePath(digest);
  const finalPath = join(layout.root, ...relativePath.split("/"));
  const finalDir = dirname(finalPath);
  const hex = digest.slice("sha256:".length);
  await mkdir(finalDir, { recursive: true });
  await mkdir(layout.staging_dir, { recursive: true });
  const tempPath = join(layout.staging_dir, `${hex}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  let linked = false;
  try {
    await invoke(options.fault, "before_temp_write");
    await handle.writeFile(bytes);
    await invoke(options.fault, "after_temp_write");
    await handle.sync();
    await invoke(options.fault, "after_file_sync");
    await handle.close();
    let status: ProjectPublishReceipt["status"] = "published";
    try {
      await link(tempPath, finalPath);
      linked = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await readFile(finalPath);
      if (!existing.equals(Buffer.from(bytes))) {
        throw protocolError("seedrop.protocol.project_transaction_digest_mismatch", {
          digest,
          path: relativePath,
          reason: "existing_content_differs",
        });
      }
      status = "already_present";
    }
    await invoke(options.fault, "after_publish");
    await syncDirectory(finalDir);
    await invoke(options.fault, "after_directory_sync");
    await cleanupMatchingTemps(layout.staging_dir, hex, bytes);
    await syncDirectory(layout.staging_dir);
    return Object.freeze({
      status,
      project_id: options.transaction.project_id,
      command_id: options.transaction.command_id,
      digest,
      relative_path: relativePath,
      byte_length: bytes.byteLength,
    });
  } finally {
    if (!linked) await handle.close().catch(() => undefined);
  }
}

export async function scanProjectTransactions(
  root: string,
  projectId: CanonicalId<"project">,
): Promise<ProjectLogScan> {
  const layout = projectStoreLayout(root);
  const transactions: ProjectStoredTransaction[] = [];
  const sources: ProjectSourceArtifact[] = [];
  const diagnostics: ProjectArtifactDiagnostic[] = [];
  for (const artifact of await walkArtifacts(layout.transactions_dir)) {
    const relativePath = toRelative(layout.root, artifact.path);
    if (artifact.kind === "read_failed") {
      diagnostics.push(diagnostic("read_failed", relativePath, null, { error_code: artifact.error_code }));
      sources.push(Object.freeze({ path: relativePath, expected_digest: null, actual_digest: null, status: "quarantined" }));
      continue;
    }
    const match = artifact.kind === "file" ? FINAL_PATH.exec(relativePath) : null;
    if (!match || match[2]!.slice(0, 2) !== match[1]) {
      diagnostics.push(diagnostic("unexpected_path", relativePath, null));
      sources.push(await unexpectedSource(artifact.path, relativePath, artifact.kind));
      continue;
    }
    const expectedDigest = `sha256:${match[2]}` as ProjectTransactionDigest;
    const parsed = await readTransactionArtifact(artifact.path, relativePath, expectedDigest, projectId);
    sources.push(parsed.source);
    if (parsed.transaction) transactions.push(parsed.transaction);
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
  }

  try {
    for (const staging of await safeReadDir(layout.staging_dir)) {
      diagnostics.push(diagnostic("uncommitted_temp", toRelative(layout.root, join(layout.staging_dir, staging.name)), null));
    }
  } catch (error) {
    diagnostics.push(diagnostic("read_failed", toRelative(layout.root, layout.staging_dir), null, { error_code: errorCode(error) }));
  }

  transactions.sort((left, right) => left.digest.localeCompare(right.digest));
  sources.sort((left, right) => left.path.localeCompare(right.path));
  diagnostics.sort(compareDiagnostics);
  return deepFreeze({ project_id: projectId, transactions, sources, diagnostics });
}

async function readTransactionArtifact(
  path: string,
  relativePath: string,
  expectedDigest: ProjectTransactionDigest,
  projectId: CanonicalId<"project">,
): Promise<{ source: ProjectSourceArtifact; transaction?: ProjectStoredTransaction; diagnostic?: ProjectArtifactDiagnostic }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    return quarantined(relativePath, expectedDigest, null, "read_failed", { error_code: errorCode(error) });
  }
  const actualDigest = rawDigest(bytes);
  if (actualDigest !== expectedDigest) {
    return quarantined(relativePath, expectedDigest, actualDigest, "digest_mismatch", { expected: expectedDigest, actual: actualDigest });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return quarantined(relativePath, expectedDigest, actualDigest, "invalid_utf8");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return quarantined(relativePath, expectedDigest, actualDigest, "invalid_json");
  }
  let transaction: ProjectTransaction;
  try {
    transaction = buildProjectTransaction(decoded as ProjectTransaction);
  } catch (error) {
    const details: ProjectArtifactDiagnostic["details"] = error instanceof ProtocolError
      ? { protocol_error_code: error.code }
      : {};
    return quarantined(relativePath, expectedDigest, actualDigest, "invalid_transaction", details);
  }
  const canonicalBytes = projectTransactionBytes(transaction);
  if (!bytes.equals(Buffer.from(canonicalBytes))) {
    return quarantined(relativePath, expectedDigest, actualDigest, "noncanonical_bytes");
  }
  if (transaction.project_id !== projectId) {
    return quarantined(relativePath, expectedDigest, actualDigest, "project_mismatch", {
      expected_project_id: projectId,
      found_project_id: transaction.project_id,
    });
  }
  return {
    source: Object.freeze({ path: relativePath, expected_digest: expectedDigest, actual_digest: actualDigest, status: "valid" }),
    transaction: deepFreeze({ digest: expectedDigest, relative_path: relativePath, byte_length: bytes.byteLength, transaction }),
  };
}

function quarantined(
  path: string,
  expected: ProjectTransactionDigest,
  actual: ProjectTransactionDigest | null,
  code: ProjectArtifactDiagnostic["code"],
  details: ProjectArtifactDiagnostic["details"] = {},
): { source: ProjectSourceArtifact; diagnostic: ProjectArtifactDiagnostic } {
  return {
    source: Object.freeze({ path, expected_digest: expected, actual_digest: actual, status: "quarantined" }),
    diagnostic: diagnostic(code, path, expected, details),
  };
}

function diagnostic(
  code: ProjectArtifactDiagnostic["code"],
  path: string,
  digest: ProjectTransactionDigest | null,
  details: ProjectArtifactDiagnostic["details"] = {},
): ProjectArtifactDiagnostic {
  return deepFreeze({ code, path, transaction_digest: digest, details: { ...details } });
}

async function cleanupMatchingTemps(stagingDir: string, hex: string, bytes: Uint8Array): Promise<void> {
  for (const entry of await safeReadDir(stagingDir)) {
    if (!entry.isFile() || !entry.name.startsWith(`${hex}.`) || !entry.name.endsWith(".tmp")) continue;
    const path = join(stagingDir, entry.name);
    try {
      const candidate = await readFile(path);
      if (candidate.equals(Buffer.from(bytes))) await unlink(path);
    } catch {
      // A concurrent reader/repair may have moved it. The next scan remains authoritative.
    }
  }
}

async function unexpectedSource(
  path: string,
  relativePath: string,
  kind: "file" | "other",
): Promise<ProjectSourceArtifact> {
  let actual: ProjectTransactionDigest | null = null;
  if (kind === "file") {
    try {
      actual = rawDigest(await readFile(path));
    } catch {
      // The unexpected path remains represented even when its bytes are unreadable.
    }
  }
  return Object.freeze({
    path: relativePath,
    expected_digest: null,
    actual_digest: actual,
    status: "quarantined",
  });
}

interface WalkedArtifact {
  path: string;
  kind: "file" | "other" | "read_failed";
  error_code: string;
}

async function walkArtifacts(root: string): Promise<WalkedArtifact[]> {
  const artifacts: WalkedArtifact[] = [];
  let entries;
  try {
    entries = await safeReadDir(root);
  } catch (error) {
    return [{ path: root, kind: "read_failed", error_code: errorCode(error) }];
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) artifacts.push(...await walkArtifacts(path));
    else artifacts.push({ path, kind: entry.isFile() ? "file" : "other", error_code: "" });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function rawDigest(bytes: Uint8Array): ProjectTransactionDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function toRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function compareDiagnostics(left: ProjectArtifactDiagnostic, right: ProjectArtifactDiagnostic): number {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
    || (left.transaction_digest ?? "").localeCompare(right.transaction_digest ?? "");
}

async function invoke(
  fault: ProjectPublishOptions["fault"],
  boundary: ProjectPublishBoundary,
): Promise<void> {
  await fault?.(boundary);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
