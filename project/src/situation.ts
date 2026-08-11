import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
  buildHealthEnvelope,
  canonicalJsonBytes,
} from "@seedrop/protocol";
import type {
  CanonicalId,
  GoverningRecordId,
  HealthSource,
  ProjectTransactionDigest,
  QuarantineRecord,
} from "@seedrop/protocol";
import { projectStoreLayout } from "./layout.js";
import { readProjectWriterLockOwner } from "./lock-owner.js";
import { projectProjectionBytes, reduceProjectTransactions } from "./projection.js";
import { scanProjectTransactions } from "./store.js";
import { queryWorkReceipts, reduceWorkProjection } from "./work.js";
import { PROJECT_PROJECTION_VERSION } from "./types.js";
import type {
  ProjectArtifactEvidence,
  ProjectArtifactFamily,
  ProjectSituation,
  ProjectSituationOptions,
  ProjectWorkReceiptQueryResult,
  WorkReceiptQuery,
} from "./types.js";

const SOURCE_IDS: Readonly<Record<ProjectArtifactFamily, string>> = Object.freeze({
  transaction: "project-transactions",
  staging: "project-staging",
  projection_index: "project-projection-index",
  writer_lock: "project-writer-lock",
});

const REPAIRS: Readonly<Record<ProjectArtifactFamily, string>> = Object.freeze({
  transaction: "project.repair.canonical_source_required",
  staging: "project.repair.inspect_staging",
  projection_index: "project.rebuild_projection",
  writer_lock: "project.repair.writer_lock_authorization_required",
});

export async function inspectProjectSituation(
  root: string,
  projectId: CanonicalId<"project">,
  options: ProjectSituationOptions,
): Promise<ProjectSituation> {
  assertOptions(options);
  const layout = projectStoreLayout(root);
  const scan = await scanProjectTransactions(root, projectId);
  const projection = reduceProjectTransactions(scan);
  const artifacts = deepFreeze([
    ...transactionEvidence(scan, projection.quarantined),
    ...await stagingEvidence(layout.root, layout.staging_dir),
    ...await projectionEvidence(layout.root, layout.index_dir, layout.projection_index, projection),
    ...await writerLockEvidence(layout.root, layout.locks_dir, layout.writer_lock),
  ].sort(compareEvidence));
  const governingRecordId = lastGoverningEvent(scan, projection.source_high_watermark);
  const health = buildProjectHealth(artifacts, projection, governingRecordId, options);
  return deepFreeze({ project_id: projectId, scan, projection, artifacts, health });
}

export async function queryProjectWorkReceipts(
  root: string,
  projectId: CanonicalId<"project">,
  query: WorkReceiptQuery,
  options: ProjectSituationOptions,
): Promise<ProjectWorkReceiptQueryResult> {
  const situation = await inspectProjectSituation(root, projectId, options);
  if (!situation.projection.lag.complete) {
    return deepFreeze({ complete: false, receipts: [], artifacts: situation.artifacts, health: situation.health });
  }
  const receipts = queryWorkReceipts(reduceWorkProjection(situation.scan), query);
  return deepFreeze({ complete: true, receipts, artifacts: situation.artifacts, health: situation.health });
}

function transactionEvidence(
  scan: ProjectSituation["scan"],
  projectionDiagnostics: ProjectSituation["projection"]["quarantined"],
): ProjectArtifactEvidence[] {
  const diagnostics = projectionDiagnostics.filter((item) => item.code !== "uncommitted_temp"
    && item.path !== "staging" && !item.path.startsWith("staging/"));
  const diagnosticsByPath = new Map<string, typeof diagnostics>();
  for (const diagnostic of diagnostics) {
    diagnosticsByPath.set(diagnostic.path, [...(diagnosticsByPath.get(diagnostic.path) ?? []), diagnostic]);
  }
  const evidence: ProjectArtifactEvidence[] = [];
  for (const source of scan.sources) {
    const sourceDiagnostics = diagnosticsByPath.get(source.path) ?? [];
    const stored = scan.transactions.find((item) => item.relative_path === source.path);
    if (sourceDiagnostics.length === 0) {
      evidence.push(freezeEvidence({
        family: "transaction", path: source.path, status: source.status,
        byte_length: stored?.byte_length ?? null, expected_digest: source.expected_digest,
        actual_digest: source.actual_digest,
      }));
      continue;
    }
    for (const diagnostic of sourceDiagnostics) {
      evidence.push(freezeEvidence({
        family: "transaction", path: source.path, status: "quarantined",
        byte_length: stored?.byte_length ?? null, expected_digest: source.expected_digest,
        actual_digest: source.actual_digest, code: diagnostic.code,
        ...(typeof diagnostic.details.error_code === "string" ? { error_code: diagnostic.details.error_code } : {}),
        repair: REPAIRS.transaction,
      }));
    }
  }
  for (const diagnostic of diagnostics) {
    if (scan.sources.some((item) => item.path === diagnostic.path)) continue;
    evidence.push(freezeEvidence({
      family: "transaction", path: diagnostic.path, status: "quarantined", byte_length: null,
      expected_digest: diagnostic.transaction_digest, actual_digest: null, code: diagnostic.code,
      ...(typeof diagnostic.details.error_code === "string" ? { error_code: diagnostic.details.error_code } : {}),
      repair: REPAIRS.transaction,
    }));
  }
  return evidence.length > 0 ? evidence : [freezeEvidence({
    family: "transaction", path: "transactions", status: "absent", byte_length: null,
    expected_digest: null, actual_digest: null,
  })];
}

async function stagingEvidence(root: string, stagingDir: string): Promise<ProjectArtifactEvidence[]> {
  let entries;
  try {
    entries = await readdir(stagingDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [absent("staging", "staging")];
    return [quarantined("staging", toRelative(root, stagingDir), "read_failed", null, null, null, errorCode(error))];
  }
  if (entries.length === 0) return [absent("staging", "staging")];
  const inspected = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const path = join(stagingDir, entry.name);
    const referent = toRelative(root, path);
    if (!entry.isFile()) return inspectUnexpectedPath(root, path, "staging");
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      return [quarantined("staging", referent, "read_failed", null, null, null, errorCode(error))];
    }
    const actual = rawDigest(bytes);
    const match = /^([0-9a-f]{64})\..+\.tmp$/.exec(entry.name);
    const expected = match === null ? null : `sha256:${match[1]}` as ProjectTransactionDigest;
    const code = match === null ? "unexpected_path" : expected === actual ? "uncommitted_temp" : "digest_mismatch";
    return [quarantined("staging", referent, code, bytes.byteLength, expected, actual)];
  }));
  return inspected.flat();
}

async function projectionEvidence(
  root: string,
  indexDir: string,
  path: string,
  projection: ProjectSituation["projection"],
): Promise<ProjectArtifactEvidence[]> {
  const referent = toRelative(root, path);
  const extras = await unexpectedDirectoryEntries(root, indexDir, "projection_index", new Set([basename(path)]));
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [absent("projection_index", referent), ...extras];
    return [quarantined("projection_index", referent, "read_failed", null, null, null, errorCode(error)), ...extras];
  }
  const actual = rawDigest(bytes);
  const expectedBytes = projectProjectionBytes(projection);
  const expected = rawDigest(expectedBytes);
  if (bytes.equals(Buffer.from(expectedBytes))) {
    return [freezeEvidence({ family: "projection_index", path: referent, status: "valid", byte_length: bytes.byteLength, expected_digest: expected, actual_digest: actual }), ...extras];
  }
  let code = "projection_mismatch";
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    code = error instanceof TypeError ? "invalid_utf8" : "invalid_json";
  }
  return [quarantined("projection_index", referent, code, bytes.byteLength, expected, actual), ...extras];
}

async function writerLockEvidence(root: string, locksDir: string, lockPath: string): Promise<ProjectArtifactEvidence[]> {
  const extras = [
    ...await unexpectedDirectoryEntries(root, locksDir, "writer_lock", new Set([basename(lockPath)])),
    ...await unexpectedDirectoryEntries(root, lockPath, "writer_lock", new Set(["owner.json"])),
  ];
  const result = await readProjectWriterLockOwner(lockPath);
  if (result.status === "absent_lock") return [absent("writer_lock", "locks/project-writer.lock/owner.json"), ...extras];
  const referent = toRelative(root, result.path);
  if (result.status === "missing_owner") return [quarantined("writer_lock", referent, "lock_owner_missing", null, null, null), ...extras];
  if (result.status === "read_failed") return [quarantined("writer_lock", referent, "read_failed", null, null, null, result.error_code), ...extras];
  if (result.status === "invalid") {
    return [quarantined("writer_lock", referent, result.code, result.byte_length, null, result.content_digest), ...extras];
  }
  return [freezeEvidence({
    family: "writer_lock", path: referent, status: "valid", byte_length: result.byte_length,
    expected_digest: result.content_digest, actual_digest: result.content_digest,
  }), ...extras];
}

async function unexpectedDirectoryEntries(
  root: string,
  directory: string,
  family: ProjectArtifactFamily,
  allowedNames: ReadonlySet<string>,
): Promise<ProjectArtifactEvidence[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    return [quarantined(family, toRelative(root, directory), "read_failed", null, null, null, errorCode(error))];
  }
  const inspected = await Promise.all(entries
    .filter((entry) => !allowedNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => inspectUnexpectedPath(root, join(directory, entry.name), family)));
  return inspected.flat();
}

async function inspectUnexpectedPath(
  root: string,
  path: string,
  family: ProjectArtifactFamily,
): Promise<ProjectArtifactEvidence[]> {
  const referent = toRelative(root, path);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    return [quarantined(family, referent, "read_failed", null, null, null, errorCode(error))];
  }
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    return [quarantined(family, referent, "unexpected_path", null, null, null)];
  }
  if (info.isDirectory()) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      return [quarantined(family, referent, "read_failed", null, null, null, errorCode(error))];
    }
    const nested = await Promise.all(entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => inspectUnexpectedPath(root, join(path, entry.name), family)));
    return [quarantined(family, referent, "unexpected_path", null, null, null), ...nested.flat()];
  }
  try {
    const bytes = await readFile(path);
    return [quarantined(family, referent, "unexpected_path", bytes.byteLength, null, rawDigest(bytes))];
  } catch (error) {
    return [quarantined(family, referent, "read_failed", null, null, null, errorCode(error))];
  }
}

function buildProjectHealth(
  artifacts: readonly ProjectArtifactEvidence[],
  projection: ProjectSituation["projection"],
  governingRecordId: GoverningRecordId | null,
  options: ProjectSituationOptions,
): ProjectSituation["health"] {
  const grouped = new Map<ProjectArtifactFamily, ProjectArtifactEvidence[]>();
  for (const artifact of artifacts) grouped.set(artifact.family, [...(grouped.get(artifact.family) ?? []), artifact]);
  const sources: HealthSource[] = [];
  for (const family of ["transaction", "staging", "projection_index", "writer_lock"] as const) {
    const members = grouped.get(family) ?? [];
    if (family !== "transaction" && members.every((item) => item.status === "absent")) continue;
    const quarantinedMembers = members.filter((item) => item.status === "quarantined");
    const digest = family === "transaction"
      ? projection.source_digest
      : digestEvidence(members);
    const canBeAvailable = quarantinedMembers.length === 0 && governingRecordId !== null && projection.source_high_watermark !== null;
    sources.push(Object.freeze({
      source_id: SOURCE_IDS[family],
      kind: `seedrop.project.${family}`,
      status: canBeAvailable ? "available" : quarantinedMembers.length > 0 ? "corrupt" : "unreachable",
      high_watermark: canBeAvailable ? projection.source_high_watermark : null,
      content_digest: canBeAvailable ? digest : null,
      observed_at: options.observed_at,
      governing_record_id: canBeAvailable ? governingRecordId : null,
      ...(!canBeAvailable ? { message: quarantinedMembers.length > 0 ? "One or more preserved artifacts require repair." : "No governing Event exists yet." } : {}),
    }));
  }
  const quarantined: QuarantineRecord[] = artifacts
    .filter((item) => item.status === "quarantined")
    .map((item) => Object.freeze({
      source_id: SOURCE_IDS[item.family],
      kind: `seedrop.project.${item.family}`,
      referent: item.path,
      code: item.code ?? "unknown_artifact_failure",
      severity: item.family === "transaction" ? "error" as const : "warning" as const,
      repair: item.repair ?? REPAIRS[item.family],
    }));
  const actualBytes = Buffer.byteLength(JSON.stringify({ artifacts, projection }));
  const requestedBytes = options.requested_bytes ?? 65_536;
  return buildHealthEnvelope({
    generated_at: options.observed_at,
    projection_version: PROJECT_PROJECTION_VERSION,
    policy: {
      policy_id: "seedrop.project.situation",
      policy_version: "1.0.0",
      required_projection_version: PROJECT_PROJECTION_VERSION,
      required_source_ids: [SOURCE_IDS.transaction],
    },
    sources,
    quarantined,
    budget: {
      requested_bytes: requestedBytes,
      actual_bytes: actualBytes,
      complete: true,
      candidate_count: artifacts.length,
      indexed_count: artifacts.filter((item) => item.family === "transaction").length,
      scanned_count: artifacts.filter((item) => item.family !== "transaction").length,
      omitted_categories: [],
    },
  });
}

function lastGoverningEvent(
  scan: ProjectSituation["scan"],
  highWatermark: ProjectTransactionDigest | null,
): GoverningRecordId | null {
  if (highWatermark === null) return null;
  return scan.transactions.find((item) => item.digest === highWatermark)?.transaction.events.at(-1)?.event_id ?? null;
}

function digestEvidence(items: readonly ProjectArtifactEvidence[]): ProjectTransactionDigest {
  return rawDigest(canonicalJsonBytes(items.map((item) => ({
    path: item.path, status: item.status, actual_digest: item.actual_digest, code: item.code ?? null,
  }))));
}

function absent(family: ProjectArtifactFamily, path: string): ProjectArtifactEvidence {
  return freezeEvidence({ family, path, status: "absent", byte_length: null, expected_digest: null, actual_digest: null });
}

function quarantined(
  family: ProjectArtifactFamily,
  path: string,
  code: string,
  byteLength: number | null,
  expectedDigest: ProjectTransactionDigest | null,
  actualDigest: ProjectTransactionDigest | null,
  error?: string,
): ProjectArtifactEvidence {
  return freezeEvidence({
    family, path, status: "quarantined", byte_length: byteLength,
    expected_digest: expectedDigest, actual_digest: actualDigest, code,
    ...(error === undefined ? {} : { error_code: error }), repair: REPAIRS[family],
  });
}

function freezeEvidence(value: ProjectArtifactEvidence): ProjectArtifactEvidence {
  return Object.freeze(value);
}

function compareEvidence(left: ProjectArtifactEvidence, right: ProjectArtifactEvidence): number {
  return left.family.localeCompare(right.family) || left.path.localeCompare(right.path);
}

function rawDigest(bytes: Uint8Array): ProjectTransactionDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ProjectTransactionDigest;
}

function toRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

function assertOptions(options: ProjectSituationOptions): void {
  if (!Number.isFinite(Date.parse(options.observed_at))) throw new TypeError("observed_at must be an ISO timestamp");
  if (options.requested_bytes !== undefined && (!Number.isSafeInteger(options.requested_bytes) || options.requested_bytes < 0)) {
    throw new TypeError("requested_bytes must be a non-negative integer");
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
