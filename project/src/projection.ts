import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  canonicalJsonBytes,
  canonicalJsonDigest,
  protocolError,
} from "@seedrop/protocol";
import type { CanonicalId, ProjectTransactionDigest } from "@seedrop/protocol";
import { projectStoreLayout } from "./layout.js";
import { scanProjectTransactions } from "./store.js";
import { PROJECT_PROJECTION_VERSION } from "./types.js";
import type {
  ProjectArtifactDiagnostic,
  ProjectLogScan,
  ProjectProjection,
  ProjectProjectionEntry,
  ProjectStoredTransaction,
} from "./types.js";

export function reduceProjectTransactions(scan: ProjectLogScan): ProjectProjection {
  const transactions = [...scan.transactions].sort((left, right) => left.digest.localeCompare(right.digest));
  // Staging files are crash evidence, not canonical project truth. Discovery keeps
  // reporting every orphan, while reduction quarantines only artifacts that could
  // alter or obscure the authoritative transaction chain.
  const diagnostics = scan.diagnostics.filter((item) => item.code !== "uncommitted_temp");
  const byDigest = new Map(transactions.map((entry) => [entry.digest, entry]));
  const byPrevious = new Map<ProjectTransactionDigest | null, ProjectStoredTransaction[]>();
  const commandIds = new Map<string, ProjectStoredTransaction[]>();
  const eventIds = new Map<string, ProjectStoredTransaction[]>();

  for (const entry of transactions) {
    const previous = entry.transaction.previous_transaction_digest;
    byPrevious.set(previous, [...(byPrevious.get(previous) ?? []), entry]);
    commandIds.set(entry.transaction.command_id, [...(commandIds.get(entry.transaction.command_id) ?? []), entry]);
    for (const event of entry.transaction.events) {
      eventIds.set(event.event_id, [...(eventIds.get(event.event_id) ?? []), entry]);
    }
    if (previous !== null && !byDigest.has(previous)) {
      diagnostics.push(diag("missing_predecessor", entry, { previous_transaction_digest: previous }));
    }
  }
  for (const entries of commandIds.values()) {
    if (entries.length > 1) for (const entry of entries) diagnostics.push(diag("duplicate_command", entry));
  }
  for (const entries of eventIds.values()) {
    if (entries.length > 1) for (const entry of entries) diagnostics.push(diag("duplicate_event", entry));
  }

  const roots = byPrevious.get(null) ?? [];
  const applied: ProjectProjectionEntry[] = [];
  const appliedDigests = new Set<ProjectTransactionDigest>();
  if (transactions.length > 0 && roots.length === 0) {
    for (const entry of transactions) diagnostics.push(diag("cycle_or_no_root", entry));
  } else if (roots.length > 1) {
    for (const entry of roots) diagnostics.push(diag("multiple_roots", entry));
  } else if (roots.length === 1) {
    let current: ProjectStoredTransaction | undefined = roots[0];
    while (current) {
      if (appliedDigests.has(current.digest)) {
        diagnostics.push(diag("cycle_or_no_root", current));
        break;
      }
      if (hasIdentityConflict(current, commandIds, eventIds)) break;
      appliedDigests.add(current.digest);
      applied.push(Object.freeze({
        transaction_digest: current.digest,
        command_id: current.transaction.command_id,
        recorded_at: current.transaction.recorded_at,
        event_ids: Object.freeze(current.transaction.events.map((event) => event.event_id)),
      }));
      const children = [...(byPrevious.get(current.digest) ?? [])].sort((left, right) => left.digest.localeCompare(right.digest));
      if (children.length > 1) {
        for (const child of children) diagnostics.push(diag("fork", child, { parent_digest: current.digest }));
        break;
      }
      current = children[0];
    }
  }

  for (const entry of transactions) {
    if (!appliedDigests.has(entry.digest) && !diagnostics.some((item) => item.transaction_digest === entry.digest)) {
      diagnostics.push(diag("unreachable_transaction", entry));
    }
  }

  const quarantined = dedupeDiagnostics(diagnostics);
  const sourceDigest = canonicalJsonDigest([...scan.sources]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => ({
      path: source.path,
      expected_digest: source.expected_digest,
      actual_digest: source.actual_digest,
      status: source.status,
    }))) as ProjectTransactionDigest;
  const appliedEventCount = applied.reduce((sum, entry) => sum + entry.event_ids.length, 0);
  const unapplied = transactions.length - applied.length;
  return deepFreeze({
    projection_version: PROJECT_PROJECTION_VERSION,
    project_id: scan.project_id,
    source_digest: sourceDigest,
    source_high_watermark: applied.at(-1)?.transaction_digest ?? null,
    transaction_count: applied.length,
    event_count: appliedEventCount,
    applied,
    lag: {
      committed_transactions: transactions.length,
      applied_transactions: applied.length,
      unapplied_transactions: unapplied,
      quarantined_artifacts: quarantined.length,
      complete: unapplied === 0 && quarantined.length === 0,
    },
    quarantined,
  });
}

export async function rebuildProjectProjection(
  root: string,
  projectId: CanonicalId<"project">,
): Promise<ProjectProjection> {
  const projection = reduceProjectTransactions(await scanProjectTransactions(root, projectId));
  await writeProjectionIndex(root, projection);
  return projection;
}

export function projectProjectionBytes(projection: ProjectProjection): Uint8Array {
  assertProjection(projection);
  return canonicalJsonBytes(projection);
}

export function projectProjectionDigest(projection: ProjectProjection): ProjectTransactionDigest {
  assertProjection(projection);
  return canonicalJsonDigest(projection) as ProjectTransactionDigest;
}

export async function deleteProjectProjectionIndex(root: string): Promise<void> {
  await rm(projectStoreLayout(root).index_dir, { recursive: true, force: true });
}

async function writeProjectionIndex(root: string, projection: ProjectProjection): Promise<void> {
  const layout = projectStoreLayout(root);
  const bytes = projectProjectionBytes(projection);
  await mkdir(layout.index_dir, { recursive: true });
  const temp = join(layout.index_dir, `.project-projection.${process.pid}.tmp`);
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, layout.projection_index);
  const directory = await open(dirname(layout.projection_index), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const persisted = await readFile(layout.projection_index);
  if (!persisted.equals(Buffer.from(bytes))) {
    throw protocolError("seedrop.protocol.project_projection_inconsistent", { reason: "persisted_bytes_mismatch" });
  }
}

function hasIdentityConflict(
  entry: ProjectStoredTransaction,
  commandIds: Map<string, ProjectStoredTransaction[]>,
  eventIds: Map<string, ProjectStoredTransaction[]>,
): boolean {
  if ((commandIds.get(entry.transaction.command_id)?.length ?? 0) > 1) return true;
  return entry.transaction.events.some((event) => (eventIds.get(event.event_id)?.length ?? 0) > 1);
}

function diag(
  code: ProjectArtifactDiagnostic["code"],
  entry: ProjectStoredTransaction,
  details: ProjectArtifactDiagnostic["details"] = {},
): ProjectArtifactDiagnostic {
  return deepFreeze({ code, path: entry.relative_path, transaction_digest: entry.digest, details: { ...details } });
}

function dedupeDiagnostics(input: readonly ProjectArtifactDiagnostic[]): readonly ProjectArtifactDiagnostic[] {
  const byKey = new Map<string, ProjectArtifactDiagnostic>();
  for (const item of input) {
    const key = `${item.path}\u0000${item.code}\u0000${item.transaction_digest ?? ""}`;
    byKey.set(key, item);
  }
  return Object.freeze([...byKey.values()].sort((left, right) => (
    left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
      || (left.transaction_digest ?? "").localeCompare(right.transaction_digest ?? "")
  )));
}

function assertProjection(projection: ProjectProjection): void {
  if (projection.projection_version !== PROJECT_PROJECTION_VERSION) {
    throw protocolError("seedrop.protocol.project_projection_inconsistent", { reason: "version_mismatch" });
  }
  if (projection.transaction_count !== projection.applied.length
    || projection.event_count !== projection.applied.reduce((sum, entry) => sum + entry.event_ids.length, 0)
    || projection.lag.applied_transactions !== projection.applied.length
    || projection.lag.unapplied_transactions !== projection.lag.committed_transactions - projection.lag.applied_transactions
    || projection.lag.quarantined_artifacts !== projection.quarantined.length
    || projection.lag.complete !== (projection.lag.unapplied_transactions === 0 && projection.quarantined.length === 0)
    || projection.source_high_watermark !== (projection.applied.at(-1)?.transaction_digest ?? null)) {
    throw protocolError("seedrop.protocol.project_projection_inconsistent", { reason: "summary_mismatch" });
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
