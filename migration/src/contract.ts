import { canonicalJson, canonicalJsonDigest } from "@seedrop/protocol";
import type { ProjectProjectionReference } from "@seedrop/project";
import type { ProjectTransactionDigest } from "@seedrop/protocol";
import {
  MIGRATION_SOURCE_KINDS,
  SHADOW_MIGRATION_CONTRACT_VERSION,
  SHADOW_MIGRATION_STATES,
} from "./types.js";
import type {
  MigrationContractErrorCode,
  MigrationCorpus,
  MigrationReconciliation,
  MigrationSourceSummary,
  ShadowMigrationNextAction,
  ShadowMigrationReceipt,
  ShadowMigrationState,
} from "./types.js";

export class MigrationContractError extends Error {
  readonly code: MigrationContractErrorCode;
  readonly details: Readonly<Record<string, string | number | null>>;

  constructor(
    code: MigrationContractErrorCode,
    details: Record<string, string | number | null> = {},
  ) {
    super(`Seedrop shadow migration contract violation: ${code}`);
    this.name = "MigrationContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function buildMigrationCorpus(sources: readonly MigrationSourceSummary[]): MigrationCorpus {
  if (!Array.isArray(sources) || sources.length === 0) invalid("sources", "nonempty_array_required");
  const ordered = [...sources].map(validateSource).sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  if (new Set(ordered.map((source) => source.source_ref)).size !== ordered.length) {
    invalid("sources.source_ref", "duplicate");
  }
  const counts = Object.freeze({
    sources: ordered.length,
    files: ordered.reduce((sum, source) => sum + source.file_count, 0),
    bytes: ordered.reduce((sum, source) => sum + source.byte_count, 0),
    records: ordered.reduce((sum, source) => sum + source.record_count, 0),
  });
  const frozenSources = Object.freeze(ordered.map((source) => Object.freeze({ ...source })));
  return deepFreeze({
    corpus_digest: canonicalJsonDigest({ sources: frozenSources, counts }) as ProjectTransactionDigest,
    sources: frozenSources,
    counts,
  });
}

export function buildPreviewMigrationReceipt(input: {
  migration_id: string;
  corpus: MigrationCorpus;
  issued_at: string;
}): ShadowMigrationReceipt {
  return buildReceipt({
    ...input,
    contract_version: SHADOW_MIGRATION_CONTRACT_VERSION,
    state: "preview",
    snapshot_receipt_digest: null,
    staged_projects: Object.freeze([]),
    reconciliation: null,
  });
}

export function advanceShadowMigrationReceipt(
  previous: ShadowMigrationReceipt,
  input:
    | { state: "source_snapshot_verified"; issued_at: string; observed_corpus: MigrationCorpus; snapshot_receipt_digest: ProjectTransactionDigest }
    | { state: "staged"; issued_at: string; observed_corpus: MigrationCorpus; staged_projects: readonly ProjectProjectionReference[] }
    | { state: "verified_not_authorized_for_cutover"; issued_at: string; observed_corpus: MigrationCorpus; reconciliation: MigrationReconciliation },
): ShadowMigrationReceipt {
  assertShadowMigrationReceipt(previous);
  assertMigrationCorpusUnchanged(previous.corpus, input.observed_corpus);
  const expected = nextState(previous.state);
  if (input.state !== expected) {
    throw new MigrationContractError("invalid_transition", { from: previous.state, to: input.state, expected });
  }

  if (input.state === "source_snapshot_verified") {
    return buildReceipt({
      contract_version: SHADOW_MIGRATION_CONTRACT_VERSION,
      migration_id: previous.migration_id,
      state: input.state,
      corpus: previous.corpus,
      issued_at: input.issued_at,
      snapshot_receipt_digest: sha256(input.snapshot_receipt_digest, "snapshot_receipt_digest"),
      staged_projects: Object.freeze([]),
      reconciliation: null,
    });
  }
  if (input.state === "staged") {
    if (previous.state !== "source_snapshot_verified") invalid("previous.state", "snapshot_verification_required");
    return buildReceipt({
      contract_version: SHADOW_MIGRATION_CONTRACT_VERSION,
      migration_id: previous.migration_id,
      state: input.state,
      corpus: previous.corpus,
      issued_at: input.issued_at,
      snapshot_receipt_digest: previous.snapshot_receipt_digest,
      staged_projects: freezeProjects(input.staged_projects),
      reconciliation: null,
    });
  }
  if (previous.state !== "staged") invalid("previous.state", "staged_import_required");
  return buildReceipt({
    contract_version: SHADOW_MIGRATION_CONTRACT_VERSION,
    migration_id: previous.migration_id,
    state: input.state,
    corpus: previous.corpus,
    issued_at: input.issued_at,
    snapshot_receipt_digest: previous.snapshot_receipt_digest,
    staged_projects: previous.staged_projects,
    reconciliation: validateReconciliation(input.reconciliation, previous.corpus.counts.records),
  });
}

export function assertMigrationCorpusUnchanged(expected: MigrationCorpus, observed: MigrationCorpus): void {
  assertMigrationCorpus(expected);
  assertMigrationCorpus(observed);
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new MigrationContractError("source_changed", {
      expected_digest: expected.corpus_digest,
      observed_digest: observed.corpus_digest,
    });
  }
}

export function shadowMigrationNextAction(receipt: ShadowMigrationReceipt): ShadowMigrationNextAction {
  assertShadowMigrationReceipt(receipt);
  switch (receipt.state) {
    case "preview": return "verify_source_snapshot";
    case "source_snapshot_verified": return "stage_shadow_import";
    case "staged": return "verify_reconciliation";
    case "verified_not_authorized_for_cutover": return "stop_no_cutover_authority";
  }
}

export function shadowMigrationReceiptDigest(receipt: ShadowMigrationReceipt): ProjectTransactionDigest {
  assertShadowMigrationReceipt(receipt);
  return canonicalJsonDigest(receipt) as ProjectTransactionDigest;
}

export function assertShadowMigrationReceipt(receipt: ShadowMigrationReceipt): void {
  buildReceipt(receipt);
}

export function assertMigrationCorpus(corpus: MigrationCorpus): void {
  const rebuilt = buildMigrationCorpus(corpus.sources);
  if (canonicalJson(rebuilt) !== canonicalJson(corpus)) invalid("corpus", "summary_or_digest_mismatch");
}

function buildReceipt(input: ShadowMigrationReceipt): ShadowMigrationReceipt {
  canonicalJson(input);
  exact(input, [
    "contract_version",
    "migration_id",
    "state",
    "corpus",
    "issued_at",
    "snapshot_receipt_digest",
    "staged_projects",
    "reconciliation",
  ], "receipt");
  if (input.contract_version !== SHADOW_MIGRATION_CONTRACT_VERSION) invalid("contract_version", "unsupported");
  nonempty(input.migration_id, "migration_id");
  timestamp(input.issued_at, "issued_at");
  assertMigrationCorpus(input.corpus);
  if (!(SHADOW_MIGRATION_STATES as readonly unknown[]).includes(input.state)) invalid("state", "unknown");

  switch (input.state) {
    case "preview":
      if (input.snapshot_receipt_digest !== null || input.staged_projects.length !== 0 || input.reconciliation !== null) {
        invalid("preview", "future_evidence_not_permitted");
      }
      break;
    case "source_snapshot_verified":
      sha256(input.snapshot_receipt_digest, "snapshot_receipt_digest");
      if (input.staged_projects.length !== 0 || input.reconciliation !== null) invalid("source_snapshot_verified", "future_evidence_not_permitted");
      break;
    case "staged":
      sha256(input.snapshot_receipt_digest, "snapshot_receipt_digest");
      canonicalProjects(input.staged_projects);
      if (input.reconciliation !== null) invalid("staged", "reconciliation_not_permitted");
      break;
    case "verified_not_authorized_for_cutover":
      sha256(input.snapshot_receipt_digest, "snapshot_receipt_digest");
      canonicalProjects(input.staged_projects);
      validateReconciliation(input.reconciliation, input.corpus.counts.records);
      break;
  }
  return deepFreeze(input);
}

function nextState(state: ShadowMigrationState): Exclude<ShadowMigrationState, "preview"> {
  switch (state) {
    case "preview": return "source_snapshot_verified";
    case "source_snapshot_verified": return "staged";
    case "staged": return "verified_not_authorized_for_cutover";
    case "verified_not_authorized_for_cutover":
      throw new MigrationContractError("invalid_transition", { from: state, to: null, expected: null });
  }
}

function validateSource(source: MigrationSourceSummary): MigrationSourceSummary {
  exact(source, [
    "source_ref", "source_kind", "source_digest", "file_count", "byte_count", "record_count",
  ], "source");
  nonempty(source.source_ref, "source_ref");
  if (!(MIGRATION_SOURCE_KINDS as readonly unknown[]).includes(source.source_kind)) invalid("source_kind", "unknown");
  sha256(source.source_digest, "source_digest");
  count(source.file_count, "file_count");
  count(source.byte_count, "byte_count");
  count(source.record_count, "record_count");
  return source;
}

function validateReconciliation(value: MigrationReconciliation, expectedRecords: number): MigrationReconciliation {
  exact(value, [
    "source_records", "imported_records", "quarantined_records", "unresolved_records",
  ], "reconciliation");
  count(value.source_records, "source_records");
  count(value.imported_records, "imported_records");
  count(value.quarantined_records, "quarantined_records");
  count(value.unresolved_records, "unresolved_records");
  if (value.source_records !== expectedRecords) invalid("source_records", "corpus_count_mismatch");
  if (value.imported_records + value.quarantined_records + value.unresolved_records !== value.source_records) {
    invalid("reconciliation", "records_not_conserved");
  }
  return Object.freeze({ ...value });
}

function freezeProjects(projects: readonly ProjectProjectionReference[]): readonly ProjectProjectionReference[] {
  if (!Array.isArray(projects)) invalid("staged_projects", "array_required");
  const seen = new Set<string>();
  const frozen = [...projects].sort((left, right) => left.project_id.localeCompare(right.project_id)).map((project) => {
    exact(project, [
      "project_id", "projection_version", "source_high_watermark", "source_digest",
    ], "staged_projects.project");
    nonempty(project.project_id, "staged_projects.project_id");
    sha256(project.source_digest, "staged_projects.source_digest");
    if (project.source_high_watermark !== null) sha256(project.source_high_watermark, "staged_projects.source_high_watermark");
    if (seen.has(project.project_id)) invalid("staged_projects.project_id", "duplicate");
    seen.add(project.project_id);
    return Object.freeze({ ...project });
  });
  return Object.freeze(frozen);
}

function canonicalProjects(projects: readonly ProjectProjectionReference[]): void {
  const canonical = freezeProjects(projects);
  if (canonicalJson(canonical) !== canonicalJson(projects)) invalid("staged_projects", "canonical_order_required");
}

function sha256(value: string, field: string): ProjectTransactionDigest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
  return value as ProjectTransactionDigest;
}

function count(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field, "nonnegative_safe_integer_required");
}

function nonempty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_string_required");
}

function timestamp(value: string, field: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid(field, "canonical_utc_timestamp_required");
  }
}

function exact(value: object, allowed: readonly string[], field: string): void {
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (extras.length > 0 || missing.length > 0) {
    invalid(field, extras.length > 0 ? `unknown_fields:${extras.sort().join(",")}` : `missing_fields:${missing.join(",")}`);
  }
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
