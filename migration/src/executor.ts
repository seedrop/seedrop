import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, canonicalJsonBytes, canonicalJsonDigest, parseCanonicalId } from "@seedrop/protocol";
import type { ProjectProjectionReference } from "@seedrop/project";
import type { ProjectTransactionDigest } from "@seedrop/protocol";
import {
  MigrationContractError,
  advanceShadowMigrationReceipt,
  assertMigrationCorpus,
  assertMigrationCorpusUnchanged,
  assertShadowMigrationReceipt,
  buildPreviewMigrationReceipt,
} from "./contract.js";
import {
  MIGRATION_EXECUTION_FAULT_BOUNDARIES,
  MIGRATION_EXECUTION_PHASES,
  MIGRATION_EXECUTOR_VERSION,
} from "./types.js";
import type {
  MigrationExecutionCheckpoint,
  MigrationExecutionFaultBoundary,
  MigrationReconciliation,
  MigrationSourceExecutionContext,
  MigrationStageSourceResult,
  MigrationSourceSummary,
  MigrationVerifySourceResult,
  MigrationStagedSourceReceipt,
  MigrationVerifiedSourceReceipt,
} from "./types.js";

export interface ShadowMigrationExecutorOptions {
  state_root: string;
  migration_id: string;
  corpus: import("./types.js").MigrationCorpus;
  observe_corpus: () => Promise<import("./types.js").MigrationCorpus>;
  stage_source: (context: MigrationSourceExecutionContext) => Promise<MigrationStageSourceResult>;
  verify_source: (
    context: MigrationSourceExecutionContext,
    staged: MigrationStagedSourceReceipt,
  ) => Promise<MigrationVerifySourceResult>;
  now?: () => Date;
  fault?: (
    boundary: MigrationExecutionFaultBoundary,
    context: Readonly<{ phase: string; source_index: number | null; source_ref: string | null }>,
  ) => void | Promise<void>;
}

export async function executeShadowMigration(
  options: ShadowMigrationExecutorOptions,
): Promise<MigrationExecutionCheckpoint> {
  validateOptions(options);
  let checkpoint = await readMigrationExecutionCheckpoint(options.state_root, options.migration_id);
  if (checkpoint === null) {
    assertMigrationCorpusUnchanged(options.corpus, await options.observe_corpus());
    await invoke(options, "before_preview_commit", "preview", null);
    checkpoint = await persistMigrationExecutionCheckpoint(options.state_root, initialCheckpoint(options));
    await invoke(options, "after_preview_commit", "preview", null);
  } else {
    assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, options.corpus);
  }

  while (checkpoint.cursor.phase !== "complete") {
    if (checkpoint.cursor.phase === "verify_source_snapshot") {
      checkpoint = await executeSnapshotStep(options, checkpoint);
    } else if (checkpoint.cursor.phase === "stage_shadow_import") {
      checkpoint = await executeStageStep(options, checkpoint);
    } else {
      checkpoint = await executeVerificationStep(options, checkpoint);
    }
  }
  return checkpoint;
}

export async function readMigrationExecutionCheckpoint(
  stateRoot: string,
  migrationId: string,
): Promise<MigrationExecutionCheckpoint | null> {
  nonempty(migrationId, "migration_id");
  const directory = executionDirectory(stateRoot, migrationId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  const checkpoints: MigrationExecutionCheckpoint[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
    if (!/^\d{12}-[0-9a-f]{64}\.json$/.test(entry.name)) {
      throw new MigrationContractError("checkpoint_corrupt", { field: "checkpoint_filename", reason: entry.name });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
    } catch {
      throw new MigrationContractError("checkpoint_corrupt", { field: "checkpoint_bytes", reason: entry.name });
    }
    assertMigrationExecutionCheckpoint(decoded as MigrationExecutionCheckpoint);
    const checkpoint = decoded as MigrationExecutionCheckpoint;
    const expectedName = checkpointFilename(checkpoint);
    if (entry.name !== expectedName) {
      throw new MigrationContractError("checkpoint_corrupt", { field: "checkpoint_filename", reason: entry.name });
    }
    checkpoints.push(deepFreeze(checkpoint));
  }
  if (checkpoints.length === 0) return null;
  checkpoints.sort((left, right) => left.revision - right.revision || left.checkpoint_digest.localeCompare(right.checkpoint_digest));
  let previous: MigrationExecutionCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    if (previous && checkpoint.revision === previous.revision) {
      throw new MigrationContractError("checkpoint_conflict", { revision: checkpoint.revision, reason: "multiple_checkpoint_digests" });
    }
    const expectedRevision = previous === null ? 1 : previous.revision + 1;
    const expectedPrevious = previous?.checkpoint_digest ?? null;
    if (checkpoint.revision !== expectedRevision || checkpoint.previous_checkpoint_digest !== expectedPrevious) {
      throw new MigrationContractError("checkpoint_corrupt", { revision: checkpoint.revision, reason: "broken_checkpoint_chain" });
    }
    if (checkpoint.migration_id !== migrationId) {
      throw new MigrationContractError("checkpoint_corrupt", { revision: checkpoint.revision, reason: "migration_id_mismatch" });
    }
    previous = checkpoint;
  }
  return previous;
}

export async function persistMigrationExecutionCheckpoint(
  stateRoot: string,
  checkpoint: MigrationExecutionCheckpoint,
): Promise<MigrationExecutionCheckpoint> {
  assertMigrationExecutionCheckpoint(checkpoint);
  const directory = executionDirectory(stateRoot, checkpoint.migration_id);
  await mkdir(directory, { recursive: true });
  const filename = checkpointFilename(checkpoint);
  const finalPath = join(directory, filename);
  const bytes = canonicalJsonBytes(checkpoint);
  const tempPath = join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(tempPath, finalPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await readFile(finalPath);
      if (!existing.equals(Buffer.from(bytes))) {
        throw new MigrationContractError("checkpoint_conflict", { revision: checkpoint.revision, reason: "revision_content_differs" });
      }
    }
    await syncDirectory(directory);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
  return checkpoint;
}

export function assertMigrationExecutionCheckpoint(checkpoint: MigrationExecutionCheckpoint): void {
  exact(checkpoint, [
    "executor_version", "migration_id", "admitted_corpus", "receipt", "cursor",
    "snapshot_sources", "staged_sources", "verified_sources", "revision",
    "previous_checkpoint_digest", "checkpoint_digest",
  ], "checkpoint");
  if (checkpoint.executor_version !== MIGRATION_EXECUTOR_VERSION) invalid("checkpoint.executor_version", "unsupported");
  nonempty(checkpoint.migration_id, "checkpoint.migration_id");
  assertMigrationCorpus(checkpoint.admitted_corpus);
  assertShadowMigrationReceipt(checkpoint.receipt);
  if (checkpoint.receipt.migration_id !== checkpoint.migration_id
    || canonicalJson(checkpoint.receipt.corpus) !== canonicalJson(checkpoint.admitted_corpus)) {
    invalid("checkpoint.receipt", "binding_mismatch");
  }
  exact(checkpoint.cursor, ["phase", "next_source_index"], "checkpoint.cursor");
  if (!(MIGRATION_EXECUTION_PHASES as readonly string[]).includes(checkpoint.cursor.phase)) invalid("checkpoint.cursor.phase", "unknown");
  count(checkpoint.cursor.next_source_index, "checkpoint.cursor.next_source_index");
  if (checkpoint.cursor.next_source_index > checkpoint.admitted_corpus.sources.length) invalid("checkpoint.cursor.next_source_index", "out_of_range");
  count(checkpoint.revision, "checkpoint.revision");
  if (checkpoint.revision === 0) invalid("checkpoint.revision", "positive_required");
  if (checkpoint.previous_checkpoint_digest !== null) sha256(checkpoint.previous_checkpoint_digest, "checkpoint.previous_checkpoint_digest");
  sha256(checkpoint.checkpoint_digest, "checkpoint.checkpoint_digest");
  const unsigned = { ...checkpoint, checkpoint_digest: undefined } as Record<string, unknown>;
  delete unsigned.checkpoint_digest;
  if (checkpoint.checkpoint_digest !== canonicalJsonDigest(unsigned as never)) invalid("checkpoint.checkpoint_digest", "mismatch");

  const sourceCount = checkpoint.admitted_corpus.sources.length;
  assertSnapshotSources(checkpoint.snapshot_sources, checkpoint.admitted_corpus.sources);
  assertStagedSources(checkpoint.migration_id, checkpoint.staged_sources, checkpoint.admitted_corpus.sources);
  assertVerifiedSources(checkpoint.migration_id, checkpoint.verified_sources, checkpoint.staged_sources, checkpoint.admitted_corpus.sources);
  const phaseLengths = {
    verify_source_snapshot: checkpoint.snapshot_sources.length,
    stage_shadow_import: checkpoint.staged_sources.length,
    verify_reconciliation: checkpoint.verified_sources.length,
    complete: sourceCount,
  };
  if (checkpoint.cursor.next_source_index !== phaseLengths[checkpoint.cursor.phase]) invalid("checkpoint.cursor", "source_prefix_mismatch");
  const expected = phaseForReceipt(checkpoint.receipt.state);
  if (checkpoint.cursor.phase !== expected) invalid("checkpoint.cursor.phase", "receipt_state_mismatch");
  if (checkpoint.cursor.phase !== "verify_source_snapshot" && checkpoint.snapshot_sources.length !== sourceCount) {
    invalid("checkpoint.snapshot_sources", "complete_prefix_required");
  }
  if (!["verify_source_snapshot", "stage_shadow_import"].includes(checkpoint.cursor.phase)
    && checkpoint.staged_sources.length !== sourceCount) invalid("checkpoint.staged_sources", "complete_prefix_required");
  if (checkpoint.cursor.phase === "complete" && checkpoint.verified_sources.length !== sourceCount) {
    invalid("checkpoint.verified_sources", "complete_prefix_required");
  }
  if (checkpoint.receipt.state !== "preview") {
    const expectedSnapshotDigest = canonicalJsonDigest({
      migration_id: checkpoint.migration_id,
      corpus_digest: checkpoint.admitted_corpus.corpus_digest,
      sources: checkpoint.snapshot_sources,
    });
    if (checkpoint.receipt.snapshot_receipt_digest !== expectedSnapshotDigest) {
      invalid("checkpoint.receipt.snapshot_receipt_digest", "source_binding_mismatch");
    }
  }
  if (checkpoint.receipt.state === "staged" || checkpoint.receipt.state === "verified_not_authorized_for_cutover") {
    if (canonicalJson(checkpoint.receipt.staged_projects) !== canonicalJson(mergeProjects(checkpoint.staged_sources))) {
      invalid("checkpoint.receipt.staged_projects", "source_binding_mismatch");
    }
  }
  if (checkpoint.receipt.state === "verified_not_authorized_for_cutover") {
    const expectedReconciliation = aggregateReconciliation(checkpoint.verified_sources.map((source) => source.reconciliation));
    if (canonicalJson(checkpoint.receipt.reconciliation) !== canonicalJson(expectedReconciliation)) {
      invalid("checkpoint.receipt.reconciliation", "source_binding_mismatch");
    }
  }
  canonicalJson(checkpoint);
}

export function migrationExecutionCheckpointBytes(checkpoint: MigrationExecutionCheckpoint): Uint8Array {
  assertMigrationExecutionCheckpoint(checkpoint);
  return canonicalJsonBytes(checkpoint);
}

export function migrationExecutionCheckpointDigest(checkpoint: MigrationExecutionCheckpoint): ProjectTransactionDigest {
  assertMigrationExecutionCheckpoint(checkpoint);
  return checkpoint.checkpoint_digest;
}

async function executeSnapshotStep(
  options: ShadowMigrationExecutorOptions,
  checkpoint: MigrationExecutionCheckpoint,
): Promise<MigrationExecutionCheckpoint> {
  const index = checkpoint.cursor.next_source_index;
  if (index < checkpoint.admitted_corpus.sources.length) {
    const source = checkpoint.admitted_corpus.sources[index]!;
    await invoke(options, "before_snapshot_source", "verify_source_snapshot", source, index);
    assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
    const sourceReceipt = Object.freeze({ source_ref: source.source_ref, source_digest: source.source_digest });
    await invoke(options, "after_snapshot_source", "verify_source_snapshot", source, index);
    checkpoint = await persistMigrationExecutionCheckpoint(options.state_root, nextCheckpoint(checkpoint, {
      cursor: { phase: "verify_source_snapshot", next_source_index: index + 1 },
      snapshot_sources: [...checkpoint.snapshot_sources, sourceReceipt],
    }));
    await invoke(options, "after_snapshot_checkpoint", "verify_source_snapshot", source, index);
    return checkpoint;
  }
  await invoke(options, "before_snapshot_commit", "verify_source_snapshot", null);
  assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
  const snapshotDigest = canonicalJsonDigest({
    migration_id: checkpoint.migration_id,
    corpus_digest: checkpoint.admitted_corpus.corpus_digest,
    sources: checkpoint.snapshot_sources,
  }) as ProjectTransactionDigest;
  const receipt = advanceShadowMigrationReceipt(checkpoint.receipt, {
    state: "source_snapshot_verified",
    issued_at: now(options),
    observed_corpus: checkpoint.admitted_corpus,
    snapshot_receipt_digest: snapshotDigest,
  });
  checkpoint = await persistMigrationExecutionCheckpoint(options.state_root, nextCheckpoint(checkpoint, {
    receipt,
    cursor: { phase: "stage_shadow_import", next_source_index: 0 },
  }));
  await invoke(options, "after_snapshot_commit", "stage_shadow_import", null);
  return checkpoint;
}

async function executeStageStep(
  options: ShadowMigrationExecutorOptions,
  checkpoint: MigrationExecutionCheckpoint,
): Promise<MigrationExecutionCheckpoint> {
  const index = checkpoint.cursor.next_source_index;
  if (index < checkpoint.admitted_corpus.sources.length) {
    const source = checkpoint.admitted_corpus.sources[index]!;
    const context = executionContext(checkpoint.migration_id, "stage_shadow_import", source, index);
    await invoke(options, "before_stage_source", "stage_shadow_import", source, index);
    assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
    const result = await guardedSourceWork(checkpoint, options, () => options.stage_source(context));
    const staged = normalizeStagedSource(source, context.idempotency_key, result);
    await invoke(options, "after_stage_source", "stage_shadow_import", source, index);
    checkpoint = await persistMigrationExecutionCheckpoint(options.state_root, nextCheckpoint(checkpoint, {
      cursor: { phase: "stage_shadow_import", next_source_index: index + 1 },
      staged_sources: [...checkpoint.staged_sources, staged],
    }));
    await invoke(options, "after_stage_checkpoint", "stage_shadow_import", source, index);
    return checkpoint;
  }
  await invoke(options, "before_stage_commit", "stage_shadow_import", null);
  assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
  const receipt = advanceShadowMigrationReceipt(checkpoint.receipt, {
    state: "staged",
    issued_at: now(options),
    observed_corpus: checkpoint.admitted_corpus,
    staged_projects: mergeProjects(checkpoint.staged_sources),
  });
  checkpoint = await persistMigrationExecutionCheckpoint(options.state_root, nextCheckpoint(checkpoint, {
    receipt,
    cursor: { phase: "verify_reconciliation", next_source_index: 0 },
  }));
  await invoke(options, "after_stage_commit", "verify_reconciliation", null);
  return checkpoint;
}

async function executeVerificationStep(
  options: ShadowMigrationExecutorOptions,
  checkpoint: MigrationExecutionCheckpoint,
): Promise<MigrationExecutionCheckpoint> {
  const index = checkpoint.cursor.next_source_index;
  if (index < checkpoint.admitted_corpus.sources.length) {
    const source = checkpoint.admitted_corpus.sources[index]!;
    const staged = checkpoint.staged_sources[index]!;
    const context = executionContext(checkpoint.migration_id, "verify_reconciliation", source, index);
    await invoke(options, "before_verify_source", "verify_reconciliation", source, index);
    assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
    const result = await guardedSourceWork(checkpoint, options, () => options.verify_source(context, staged));
    const verified = normalizeVerifiedSource(source, context.idempotency_key, result);
    if (canonicalJson(verified.reconciliation) !== canonicalJson(staged.reconciliation)) {
      invalid("verify_source.reconciliation", "staged_verification_mismatch");
    }
    await invoke(options, "after_verify_source", "verify_reconciliation", source, index);
    checkpoint = await persistMigrationExecutionCheckpoint(options.state_root, nextCheckpoint(checkpoint, {
      cursor: { phase: "verify_reconciliation", next_source_index: index + 1 },
      verified_sources: [...checkpoint.verified_sources, verified],
    }));
    await invoke(options, "after_verify_checkpoint", "verify_reconciliation", source, index);
    return checkpoint;
  }
  await invoke(options, "before_terminal_commit", "verify_reconciliation", null);
  assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
  const receipt = advanceShadowMigrationReceipt(checkpoint.receipt, {
    state: "verified_not_authorized_for_cutover",
    issued_at: now(options),
    observed_corpus: checkpoint.admitted_corpus,
    reconciliation: aggregateReconciliation(checkpoint.verified_sources.map((source) => source.reconciliation)),
  });
  checkpoint = await persistMigrationExecutionCheckpoint(options.state_root, nextCheckpoint(checkpoint, {
    receipt,
    cursor: { phase: "complete", next_source_index: checkpoint.admitted_corpus.sources.length },
  }));
  await invoke(options, "after_terminal_commit", "complete", null);
  return checkpoint;
}

async function guardedSourceWork<T>(
  checkpoint: MigrationExecutionCheckpoint,
  options: ShadowMigrationExecutorOptions,
  work: () => Promise<T>,
): Promise<T> {
  try {
    const result = await work();
    assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
    return result;
  } catch (error) {
    // Adapter errors do not waive the read-only contract. If both adapter work
    // and source observation fail, source drift is the more important result.
    assertMigrationCorpusUnchanged(checkpoint.admitted_corpus, await options.observe_corpus());
    throw error;
  }
}

function initialCheckpoint(options: ShadowMigrationExecutorOptions): MigrationExecutionCheckpoint {
  const receipt = buildPreviewMigrationReceipt({
    migration_id: options.migration_id,
    corpus: options.corpus,
    issued_at: now(options),
  });
  return signedCheckpoint({
    executor_version: MIGRATION_EXECUTOR_VERSION,
    migration_id: options.migration_id,
    admitted_corpus: options.corpus,
    receipt,
    cursor: { phase: "verify_source_snapshot", next_source_index: 0 },
    snapshot_sources: [], staged_sources: [], verified_sources: [],
    revision: 1,
    previous_checkpoint_digest: null,
  });
}

function nextCheckpoint(
  previous: MigrationExecutionCheckpoint,
  changes: Partial<Omit<MigrationExecutionCheckpoint, "checkpoint_digest" | "revision" | "previous_checkpoint_digest">>,
): MigrationExecutionCheckpoint {
  const { checkpoint_digest: _checkpointDigest, ...base } = previous;
  return signedCheckpoint({
    ...base,
    ...changes,
    revision: previous.revision + 1,
    previous_checkpoint_digest: previous.checkpoint_digest,
  });
}

function signedCheckpoint(
  value: Omit<MigrationExecutionCheckpoint, "checkpoint_digest">,
): MigrationExecutionCheckpoint {
  const checkpoint = deepFreeze({
    ...value,
    checkpoint_digest: canonicalJsonDigest(value) as ProjectTransactionDigest,
  });
  assertMigrationExecutionCheckpoint(checkpoint);
  return checkpoint;
}

function normalizeStagedSource(
  source: MigrationSourceSummary,
  idempotencyKey: ProjectTransactionDigest,
  result: MigrationStageSourceResult,
): MigrationStagedSourceReceipt {
  exact(result, ["staged_projects", "reconciliation"], "stage_source.result");
  validateReconciliation(result.reconciliation, source.record_count, "stage_source.reconciliation");
  const projects = canonicalProjects(result.staged_projects);
  return deepFreeze({
    source_ref: source.source_ref,
    source_digest: source.source_digest,
    idempotency_key: idempotencyKey,
    staged_projects: projects,
    reconciliation: { ...result.reconciliation },
  });
}

function normalizeVerifiedSource(
  source: MigrationSourceSummary,
  idempotencyKey: ProjectTransactionDigest,
  result: MigrationVerifySourceResult,
): MigrationVerifiedSourceReceipt {
  exact(result, ["reconciliation"], "verify_source.result");
  validateReconciliation(result.reconciliation, source.record_count, "verify_source.reconciliation");
  return deepFreeze({
    source_ref: source.source_ref,
    source_digest: source.source_digest,
    idempotency_key: idempotencyKey,
    reconciliation: { ...result.reconciliation },
  });
}

function assertSnapshotSources(
  receipts: readonly { source_ref: string; source_digest: string }[],
  sources: readonly MigrationSourceSummary[],
): void {
  if (!Array.isArray(receipts) || receipts.length > sources.length) invalid("checkpoint.snapshot_sources", "source_prefix_required");
  for (const [index, receipt] of receipts.entries()) {
    exact(receipt, ["source_ref", "source_digest"], "checkpoint.snapshot_sources.item");
    if (receipt.source_ref !== sources[index]!.source_ref || receipt.source_digest !== sources[index]!.source_digest) {
      invalid("checkpoint.snapshot_sources", "source_prefix_mismatch");
    }
  }
}

function assertStagedSources(
  migrationId: string,
  receipts: readonly MigrationStagedSourceReceipt[],
  sources: readonly MigrationSourceSummary[],
): void {
  if (!Array.isArray(receipts) || receipts.length > sources.length) invalid("checkpoint.staged_sources", "source_prefix_required");
  for (const [index, receipt] of receipts.entries()) {
    exact(receipt, ["source_ref", "source_digest", "idempotency_key", "staged_projects", "reconciliation"], "checkpoint.staged_sources.item");
    const source = sources[index]!;
    if (receipt.source_ref !== source.source_ref || receipt.source_digest !== source.source_digest) invalid("checkpoint.staged_sources", "source_prefix_mismatch");
    sha256(receipt.idempotency_key, "checkpoint.staged_sources.idempotency_key");
    if (receipt.idempotency_key !== idempotencyKey("stage_shadow_import", source, index, migrationId)) invalid("checkpoint.staged_sources.idempotency_key", "binding_mismatch");
    canonicalProjects(receipt.staged_projects);
    validateReconciliation(receipt.reconciliation, source.record_count, "checkpoint.staged_sources.reconciliation");
  }
}

function assertVerifiedSources(
  migrationId: string,
  receipts: readonly MigrationVerifiedSourceReceipt[],
  staged: readonly MigrationStagedSourceReceipt[],
  sources: readonly MigrationSourceSummary[],
): void {
  if (!Array.isArray(receipts) || receipts.length > staged.length) invalid("checkpoint.verified_sources", "source_prefix_required");
  for (const [index, receipt] of receipts.entries()) {
    exact(receipt, ["source_ref", "source_digest", "idempotency_key", "reconciliation"], "checkpoint.verified_sources.item");
    const source = sources[index]!;
    if (receipt.source_ref !== source.source_ref || receipt.source_digest !== source.source_digest) invalid("checkpoint.verified_sources", "source_prefix_mismatch");
    sha256(receipt.idempotency_key, "checkpoint.verified_sources.idempotency_key");
    if (receipt.idempotency_key !== idempotencyKey("verify_reconciliation", source, index, migrationId)) invalid("checkpoint.verified_sources.idempotency_key", "binding_mismatch");
    validateReconciliation(receipt.reconciliation, source.record_count, "checkpoint.verified_sources.reconciliation");
    if (canonicalJson(receipt.reconciliation) !== canonicalJson(staged[index]!.reconciliation)) {
      invalid("checkpoint.verified_sources.reconciliation", "staged_verification_mismatch");
    }
  }
}

function mergeProjects(sources: readonly MigrationStagedSourceReceipt[]): readonly ProjectProjectionReference[] {
  const projects = new Map<string, ProjectProjectionReference>();
  for (const source of sources) for (const project of source.staged_projects) {
    const existing = projects.get(project.project_id);
    if (existing && canonicalJson(existing) !== canonicalJson(project)) invalid("staged_projects", "project_reference_conflict");
    projects.set(project.project_id, project);
  }
  return canonicalProjects([...projects.values()]);
}

function canonicalProjects(input: readonly ProjectProjectionReference[]): readonly ProjectProjectionReference[] {
  if (!Array.isArray(input)) invalid("staged_projects", "array_required");
  const projects = [...input].sort((left, right) => left.project_id.localeCompare(right.project_id));
  if (new Set(projects.map((project) => project.project_id)).size !== projects.length) invalid("staged_projects", "duplicate_project");
  for (const project of projects) {
    exact(project, ["project_id", "projection_version", "source_high_watermark", "source_digest"], "staged_projects.item");
    parseCanonicalId(project.project_id, "project");
    nonempty(project.projection_version, "staged_projects.projection_version");
    if (project.source_high_watermark !== null) sha256(project.source_high_watermark, "staged_projects.source_high_watermark");
    sha256(project.source_digest, "staged_projects.source_digest");
  }
  return deepFreeze(projects.map((project) => ({ ...project })));
}

function validateReconciliation(value: MigrationReconciliation, expected: number, field: string): void {
  exact(value, ["source_records", "imported_records", "quarantined_records", "unresolved_records"], field);
  for (const [key, countValue] of Object.entries(value)) count(countValue, `${field}.${key}`);
  if (value.source_records !== expected
    || value.imported_records + value.quarantined_records + value.unresolved_records !== value.source_records) {
    invalid(field, "source_conservation_failed");
  }
}

function aggregateReconciliation(values: readonly MigrationReconciliation[]): MigrationReconciliation {
  return Object.freeze({
    source_records: values.reduce((sum, value) => sum + value.source_records, 0),
    imported_records: values.reduce((sum, value) => sum + value.imported_records, 0),
    quarantined_records: values.reduce((sum, value) => sum + value.quarantined_records, 0),
    unresolved_records: values.reduce((sum, value) => sum + value.unresolved_records, 0),
  });
}

function executionContext(
  migrationId: string,
  phase: "stage_shadow_import" | "verify_reconciliation",
  source: MigrationSourceSummary,
  sourceIndex: number,
): MigrationSourceExecutionContext {
  return deepFreeze({
    migration_id: migrationId,
    source,
    source_index: sourceIndex,
    idempotency_key: idempotencyKey(phase, source, sourceIndex, migrationId),
  });
}

function idempotencyKey(
  phase: "stage_shadow_import" | "verify_reconciliation",
  source: MigrationSourceSummary,
  sourceIndex: number,
  migrationId: string,
): ProjectTransactionDigest {
  return canonicalJsonDigest({ migration_id: migrationId, phase, source_index: sourceIndex, source_ref: source.source_ref, source_digest: source.source_digest }) as ProjectTransactionDigest;
}

function phaseForReceipt(state: import("./types.js").ShadowMigrationState): import("./types.js").MigrationExecutionPhase {
  if (state === "preview") return "verify_source_snapshot";
  if (state === "source_snapshot_verified") return "stage_shadow_import";
  if (state === "staged") return "verify_reconciliation";
  return "complete";
}

function executionDirectory(stateRoot: string, migrationId: string): string {
  const key = createHash("sha256").update(migrationId).digest("hex");
  return join(resolve(stateRoot), key, "checkpoints");
}

function checkpointFilename(checkpoint: MigrationExecutionCheckpoint): string {
  return `${String(checkpoint.revision).padStart(12, "0")}-${checkpoint.checkpoint_digest.slice("sha256:".length)}.json`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function invoke(
  options: ShadowMigrationExecutorOptions,
  boundary: MigrationExecutionFaultBoundary,
  phase: string,
  source: MigrationSourceSummary | null,
  sourceIndex: number | null = null,
): Promise<void> {
  if (!(MIGRATION_EXECUTION_FAULT_BOUNDARIES as readonly string[]).includes(boundary)) invalid("fault.boundary", "unknown");
  await options.fault?.(boundary, Object.freeze({ phase, source_index: sourceIndex, source_ref: source?.source_ref ?? null }));
}

function validateOptions(options: ShadowMigrationExecutorOptions): void {
  nonempty(options.state_root, "state_root");
  nonempty(options.migration_id, "migration_id");
  assertMigrationCorpus(options.corpus);
  if (typeof options.observe_corpus !== "function" || typeof options.stage_source !== "function" || typeof options.verify_source !== "function") {
    invalid("executor.callbacks", "functions_required");
  }
}

function now(options: ShadowMigrationExecutorOptions): string {
  const value = (options.now ?? (() => new Date()))().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid("now", "canonical_timestamp_required");
  return value;
}

function sha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function count(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field, "nonnegative_safe_integer_required");
}

function nonempty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_string_required");
}

function exact(value: object, allowed: readonly string[], field: string): void {
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (extras.length > 0 || missing.length > 0) invalid(field, extras.length > 0 ? `unknown_fields:${extras.sort().join(",")}` : `missing_fields:${missing.join(",")}`);
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function invalid(field: string, reason: string): never {
  throw new MigrationContractError("invalid_contract", { field, reason });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
