import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  ContinuityPacketSchema,
  RunJournalSchema,
  SignalSchema,
  TaskSchema,
} from "@seedrop/space/view";
import { canonicalJson, canonicalJsonDigest } from "@seedrop/protocol";
import type { JsonValue, ProjectTransactionDigest } from "@seedrop/protocol";
import { MigrationContractError, buildMigrationCorpus } from "./contract.js";
import { digestReadOnlyTree } from "./v1-passports.js";
import type {
  MigrationSourceSummary,
  ViewHistoryCollection,
  ViewSourceDiagnostic,
  ViewSourceFamily,
  ViewSourceRecord,
} from "./types.js";

type ParseResult =
  | { payload: JsonValue; diagnostics: readonly [] }
  | { payload: JsonValue | null; diagnostics: readonly ViewSourceDiagnostic[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DELIVERY_OUTCOMES = new Set(["survived", "superseded", "absent", "uncommitted"]);

/**
 * Admit v1 View history without mutating or repairing it. Each logical record
 * remains visible even when its JSON or schema is invalid.
 */
export async function collectV1ViewHistory(options: {
  view_root: string;
  outcome_report_path?: string;
}): Promise<ViewHistoryCollection> {
  const viewRoot = resolve(options.view_root);
  const before = await digestReadOnlyTree(viewRoot);
  const sources: MigrationSourceSummary[] = [];
  const records: ViewSourceRecord[] = [];

  await collectDirectory(viewRoot, "tasks", "task", TaskSchema, sources, records);
  await collectDirectory(viewRoot, "runs", "run", RunJournalSchema, sources, records);
  await collectDirectory(viewRoot, "continuity", "continuity", ContinuityPacketSchema, sources, records);
  await collectDirectory(viewRoot, "signals", "signal", SignalSchema, sources, records);
  await collectSignalArchive(viewRoot, sources, records);
  if (options.outcome_report_path) {
    await collectOutcomeReport(resolve(options.outcome_report_path), sources, records);
  }

  const after = await digestReadOnlyTree(viewRoot);
  if (before !== after) {
    throw new MigrationContractError("source_changed", {
      expected_digest: before,
      observed_digest: after,
    });
  }
  const orderedRecords = records.sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  const corpus = buildMigrationCorpus(sources);
  if (corpus.counts.records !== orderedRecords.length) {
    throw new MigrationContractError("invalid_contract", {
      field: "view.records",
      reason: "source_conservation_failed",
      expected_records: corpus.counts.records,
      observed_records: orderedRecords.length,
    });
  }
  return deepFreeze({ corpus, source_tree_digest: before, records: orderedRecords });
}

async function collectDirectory(
  viewRoot: string,
  directory: string,
  family: ViewSourceFamily,
  schema: { safeParse(value: unknown): { success: boolean; error?: { issues: readonly { path: PropertyKey[]; code: string; message: string }[] } } },
  sources: MigrationSourceSummary[],
  records: ViewSourceRecord[],
): Promise<void> {
  const root = join(viewRoot, directory);
  for (const filePath of await jsonFiles(root)) {
    const raw = await stableRead(filePath);
    const sourceRef = `view:${portable(relative(viewRoot, filePath))}`;
    const parsed = parseSingle(raw, schema);
    sources.push(sourceSummary(sourceRef, raw, 1));
    records.push(record(sourceRef, family, digest(raw), parsed));
  }
}

async function collectSignalArchive(
  viewRoot: string,
  sources: MigrationSourceSummary[],
  records: ViewSourceRecord[],
): Promise<void> {
  const filePath = join(viewRoot, "signals-archive.json");
  let raw: Buffer;
  try {
    raw = await stableRead(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const sourceRef = "view:signals-archive.json";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    sources.push(sourceSummary(sourceRef, raw, 1));
    records.push(record(sourceRef, "signal", digest(raw), {
      payload: null,
      diagnostics: [diagnostic("invalid_json", errorMessage(error))],
    }));
    return;
  }
  if (!Array.isArray(parsed)) {
    sources.push(sourceSummary(sourceRef, raw, 1));
    records.push(record(sourceRef, "signal", digest(raw), {
      payload: asJson(parsed),
      diagnostics: [diagnostic("source_container_invalid", "Signal archive must be an array.")],
    }));
    return;
  }
  sources.push(sourceSummary(sourceRef, raw, parsed.length));
  for (const [index, value] of parsed.entries()) {
    const itemRef = `${sourceRef}#${String(index).padStart(6, "0")}`;
    const validation = validateArchivedSignal(value);
    records.push(record(itemRef, "signal", canonicalJsonDigest(asJson(value)) as ProjectTransactionDigest, validation));
  }
}

async function collectOutcomeReport(
  filePath: string,
  sources: MigrationSourceSummary[],
  records: ViewSourceRecord[],
): Promise<void> {
  const raw = await stableRead(filePath);
  const sourceRef = `delivery:${basename(filePath)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    sources.push(sourceSummary(sourceRef, raw, 1));
    records.push(record(sourceRef, "delivery_observation", digest(raw), {
      payload: null,
      diagnostics: [diagnostic("invalid_json", errorMessage(error))],
    }));
    return;
  }
  if (!isObject(parsed) || !Array.isArray(parsed.repos)) {
    sources.push(sourceSummary(sourceRef, raw, 1));
    records.push(record(sourceRef, "delivery_observation", digest(raw), {
      payload: asJson(parsed),
      diagnostics: [diagnostic("source_container_invalid", "Outcome report must contain a repos array.")],
    }));
    return;
  }
  const logical: Array<{ ref: string; value: JsonValue; valid: boolean; reason?: string }> = [];
  for (const [repoIndex, repo] of parsed.repos.entries()) {
    if (!isObject(repo) || !Array.isArray(repo.runs)) {
      logical.push({
        ref: `${sourceRef}#repo-${String(repoIndex).padStart(4, "0")}`,
        value: asJson(repo),
        valid: false,
        reason: "Outcome repository entry must contain a runs array.",
      });
      continue;
    }
    for (const [runIndex, observation] of repo.runs.entries()) {
      const value = asJson({
        observer: "seedrop.outcome-layer.v1",
        observed_at: parsed.generated_at ?? null,
        repo_root: repo.root ?? null,
        build_identity: repo.head ?? null,
        observation,
      });
      const runId = isObject(observation) && typeof observation.run_id === "string" ? observation.run_id : `index-${runIndex}`;
      logical.push({
        ref: `${sourceRef}#${String(repoIndex).padStart(4, "0")}:${String(runIndex).padStart(6, "0")}:${runId}`,
        value,
        valid: validOutcomeObservation(value),
        reason: "Outcome observation is missing run, outcome, observer time, repository, or build identity evidence.",
      });
    }
  }
  sources.push(sourceSummary(sourceRef, raw, logical.length));
  for (const item of logical) {
    records.push(record(item.ref, "delivery_observation", canonicalJsonDigest(item.value) as ProjectTransactionDigest, {
      payload: item.value,
      diagnostics: item.valid ? [] : [diagnostic("schema_validation", item.reason!)],
    }));
  }
}

function parseSingle(
  raw: Buffer,
  schema: { safeParse(value: unknown): { success: boolean; error?: { issues: readonly { path: PropertyKey[]; code: string; message: string }[] } } },
): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return { payload: null, diagnostics: [diagnostic("invalid_json", errorMessage(error))] };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { payload: asJson(parsed), diagnostics: [] };
  const reason = result.error?.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}:${issue.message}`)
    .join("; ") ?? "Schema validation failed.";
  return { payload: asJson(parsed), diagnostics: [diagnostic("schema_validation", reason)] };
}

function validateArchivedSignal(value: unknown): ParseResult {
  if (!isObject(value)) {
    return { payload: asJson(value), diagnostics: [diagnostic("schema_validation", "Archived signal must be an object.")] };
  }
  const { archived_at: archivedAt, ...signal } = value;
  const parsed = SignalSchema.safeParse(signal);
  if (!parsed.success || typeof archivedAt !== "string" || !canonicalTimestamp(archivedAt)) {
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue: { path: PropertyKey[]; code: string; message: string }) => `${issue.path.join(".") || "<root>"}:${issue.code}:${issue.message}`);
    if (typeof archivedAt !== "string" || !canonicalTimestamp(archivedAt)) issues.push("archived_at:invalid_datetime");
    return { payload: asJson(value), diagnostics: [diagnostic("schema_validation", issues.join("; "))] };
  }
  return { payload: asJson(value), diagnostics: [] };
}

function validOutcomeObservation(value: JsonValue): boolean {
  if (!isObject(value)) return false;
  const object = value as Record<string, JsonValue>;
  const observation = object.observation;
  const observationObject = isObject(observation) ? observation as Record<string, JsonValue> : null;
  return typeof object.observer === "string"
    && typeof object.observed_at === "string" && canonicalTimestamp(object.observed_at)
    && typeof object.repo_root === "string" && object.repo_root.length > 0
    && typeof object.build_identity === "string" && /^[0-9a-f]{40,64}$/i.test(object.build_identity)
    && observationObject !== null
    && typeof observationObject.run_id === "string" && UUID.test(observationObject.run_id)
    && typeof observationObject.outcome === "string" && DELIVERY_OUTCOMES.has(observationObject.outcome);
}

function sourceSummary(sourceRef: string, raw: Uint8Array, recordCount: number): MigrationSourceSummary {
  return {
    source_ref: sourceRef,
    source_kind: "view",
    source_digest: digest(raw),
    file_count: 1,
    byte_count: raw.byteLength,
    record_count: recordCount,
  };
}

function record(sourceRef: string, family: ViewSourceFamily, sourceDigest: ProjectTransactionDigest, parsed: ParseResult): ViewSourceRecord {
  return deepFreeze({
    source_ref: sourceRef,
    source_family: family,
    source_digest: sourceDigest,
    source_payload: parsed.payload,
    diagnostics: [...parsed.diagnostics],
  });
}

async function stableRead(path: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await lstat(path, { bigint: true });
    const bytes = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs) return bytes;
  }
  throw new Error(`Could not obtain a stable read: ${path}`);
}

async function jsonFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function digest(bytes: Uint8Array): ProjectTransactionDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function diagnostic(code: ViewSourceDiagnostic["code"], reason: string): ViewSourceDiagnostic {
  return Object.freeze({ code, reason });
}

function canonicalTimestamp(value: string): boolean {
  return ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function portable(value: string): string {
  return value.split(sep).join("/");
}

function asJson(value: unknown): JsonValue {
  canonicalJson(value as JsonValue);
  return value as JsonValue;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return isObject(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
