import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonDigest, resolvePrincipalIdentity, resolveProjectIdentity } from "@seedrop/protocol";
import {
  collectLiveIdentityCorpus, collectMachineCoordination, collectV1ViewHistory,
  compareV1AndV2Projection, compatibilityProjectionBytes, digestReadOnlyTree,
  identityImportBytes, identityImportDigest, importIdentityRegistries, importViewHistory,
  machineCoordinationBytes, machineCoordinationDigest, reconcileMachineCoordination,
  viewHistoryImportBytes, viewHistoryImportDigest,
} from "../dist/index.js";

const EXPECTED_MEANINGFUL_VIEWS = 17;
const EXPERIMENT_NAME = "seedrop_db";
const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const identityRoot = join(homedir(), ".seedrop", "id");
const spaceRoot = join(homedir(), ".seedrop", "space");
const migrationRoot = join(homedir(), ".seedrop", "migrations", "space-root");
const temporaryRoot = await mkdtemp(join(tmpdir(), "seedrop-machine-corpus-"));

try {
  const identityBefore = await digestReadOnlyTree(identityRoot);
  const identityInput = await collectLiveIdentityCorpus({ identity_root: identityRoot });
  const identityFirst = importIdentityRegistries(identityInput);
  const identitySecond = importIdentityRegistries(identityInput);
  assert.deepEqual(identityImportBytes(identitySecond), identityImportBytes(identityFirst));
  const migrationPrincipalId = resolvePrincipalIdentity(identityFirst.principal_registry, "jerry");

  const classified = [];
  for (const candidate of deduplicateViews(identityInput.projects)) {
    const viewRoot = join(candidate.root, ".seedrop", "view");
    if (!existsSync(viewRoot)) continue;
    const isProbe = basename(candidate.root).includes("probe");
    if (!await hasHistoryRecords(viewRoot)) {
      classified.push({ ...candidate, viewRoot, collection: null, isProbe, isMeaningful: false });
      continue;
    }
    const collection = await collectV1ViewHistory({ view_root: viewRoot });
    classified.push({ ...candidate, viewRoot, collection, isProbe, isMeaningful: collection.records.length > 0 && !isProbe });
  }
  const meaningful = classified.filter((entry) => entry.isMeaningful);
  assert.equal(meaningful.length, EXPECTED_MEANINGFUL_VIEWS,
    `machine corpus drift: expected ${EXPECTED_MEANINGFUL_VIEWS} meaningful Views, found ${meaningful.length}`);
  const experiments = meaningful.filter((entry) => basename(entry.root) === EXPERIMENT_NAME);
  assert.equal(experiments.length, 1, "seedrop_db must be present exactly once as excluded experiment evidence");
  const productViews = meaningful.filter((entry) => basename(entry.root) !== EXPERIMENT_NAME);

  const views = [];
  for (const [index, entry] of productViews.entries()) {
    const outcomePath = join(temporaryRoot, `outcome-${index}.json`);
    execFileSync(process.execPath, [join(repoRoot, "scripts", "outcome-layer.mjs"), "--root", entry.root, "--json", outcomePath], {
      cwd: entry.root, stdio: ["ignore", "ignore", "ignore"], maxBuffer: 64 * 1024 * 1024,
    });
    const outcomeReport = JSON.parse(await readFile(outcomePath, "utf8"));
    const before = await digestReadOnlyTree(entry.viewRoot);
    const firstCollection = await collectV1ViewHistory({ view_root: entry.viewRoot, outcome_report_path: outcomePath });
    const secondCollection = await collectV1ViewHistory({ view_root: entry.viewRoot, outcome_report_path: outcomePath });
    assert.deepEqual(secondCollection, firstCollection, `View changed between reads: ${entry.root}`);
    const projectId = resolveProjectIdentity(identityFirst.project_registry, { namespace: "placement_path", value: entry.root });
    const importInput = { project_id: projectId, migration_principal_id: migrationPrincipalId,
      principal_registry: identityFirst.principal_registry, snapshot_recorded_at: outcomeReport.generated_at };
    const first = importViewHistory({ collection: firstCollection, ...importInput });
    const second = importViewHistory({ collection: secondCollection, ...importInput });
    const compatibilityFirst = compareV1AndV2Projection({ collection: firstCollection, imported: first });
    const compatibilitySecond = compareV1AndV2Projection({ collection: secondCollection, imported: second });
    assert.deepEqual(viewHistoryImportBytes(second), viewHistoryImportBytes(first));
    assert.deepEqual(compatibilityProjectionBytes(compatibilitySecond), compatibilityProjectionBytes(compatibilityFirst));
    assert.equal(await digestReadOnlyTree(entry.viewRoot), before, `source bytes changed: ${entry.root}`);
    assertConserved(first.receipt.counts);
    views.push({
      root: entry.root, project_id: projectId, source_tree_digest: first.receipt.source_tree_digest,
      corpus_digest: first.receipt.corpus_digest, import_digest: viewHistoryImportDigest(first),
      compatibility_digest: compatibilityFirst.receipt.comparison_digest,
      physical: collectionPhysical(firstCollection), counts: first.receipt.counts,
      imported_fields: importedFields(firstCollection, first), diagnostic_codes: diagnosticCodes(first.records),
      source_tree_unchanged: true, byte_identical_rerun: true,
    });
  }

  const coordinationCollection = await stableCoordinationCollection();
  const coordinationBefore = coordinationCollection.source_tree_digest;
  const coordinationInput = { collection: coordinationCollection, principal_registry: identityFirst.principal_registry,
    snapshot_at: new Date().toISOString() };
  const coordinationFirst = reconcileMachineCoordination(coordinationInput);
  const coordinationSecond = reconcileMachineCoordination(coordinationInput);
  assert.deepEqual(machineCoordinationBytes(coordinationSecond), machineCoordinationBytes(coordinationFirst));
  assertConserved(coordinationFirst.receipt.counts);
  assert.equal(await digestReadOnlyTree(identityRoot), identityBefore, "identity source bytes changed");
  assert.equal((await collectMachineCoordination({ space_root: spaceRoot, migration_root: migrationRoot })).source_tree_digest,
    coordinationBefore, "coordination source bytes changed");

  const excluded = experiments.map((entry) => ({ root: entry.root,
    reason: "independent_experiment_requires_10x_value_proof", source_tree_digest: entry.collection.source_tree_digest,
    physical: collectionPhysical(entry.collection), source_records: entry.collection.records.length,
    imported_into_product_graph: false }));
  const receipt = {
    proof_version: "1.0.0", mode: "live-read-only-full-machine-corpus",
    meaningful_views: meaningful.length, imported_product_views: views.length, excluded_experiments: excluded.length,
    identity: { corpus_digest: identityFirst.receipt.corpus_digest, import_digest: identityImportDigest(identityFirst),
      source_mapping_digest: identityFirst.receipt.source_mapping_digest, counts: identityFirst.receipt.counts,
      principal_mappings: Object.keys(identityFirst.source_to_principal).length,
      project_mappings: Object.keys(identityFirst.source_to_project).length,
      source_tree_unchanged: true, byte_identical_rerun: true },
    views: views.sort((left, right) => left.root.localeCompare(right.root)),
    view_totals: views.reduce((sum, view) => addCounts(sum, view.counts), emptyCounts()),
    coordination: { corpus_digest: coordinationFirst.receipt.corpus_digest,
      reconciliation_digest: machineCoordinationDigest(coordinationFirst),
      physical: { files: coordinationCollection.physical_file_count, bytes: coordinationCollection.physical_byte_count },
      counts: coordinationFirst.receipt.counts, diagnostic_codes: coordinationDiagnosticCodes(coordinationFirst.records),
      source_tree_unchanged: true, byte_identical_rerun: true, project_truth_absorbed: false },
    excluded, source_bytes_unchanged: true, product_dependency_graph_contains_seedrop_db: false,
  };
  console.log(JSON.stringify({ ok: true, proof_digest: canonicalJsonDigest(receipt), receipt }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function deduplicateViews(projects) {
  const roots = new Map();
  for (const project of projects) {
    const root = resolve(project.real_path ?? project.root);
    if (!roots.has(root)) roots.set(root, { root, source_refs: [] });
    roots.get(root).source_refs.push(project.source_ref);
  }
  return [...roots.values()].map((entry) => ({ ...entry, source_refs: entry.source_refs.sort() }))
    .sort((left, right) => left.root.localeCompare(right.root));
}

async function stableCoordinationCollection() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const first = await collectMachineCoordination({ space_root: spaceRoot, migration_root: migrationRoot });
    const second = await collectMachineCoordination({ space_root: spaceRoot, migration_root: migrationRoot });
    if (JSON.stringify(first) === JSON.stringify(second)) return first;
  }
  throw new Error("machine coordination source did not stabilize across read-only collection");
}

async function hasHistoryRecords(viewRoot) {
  if (existsSync(join(viewRoot, "signals-archive.json"))) return true;
  for (const directory of ["tasks", "runs", "continuity", "signals"]) {
    try {
      if ((await readdir(join(viewRoot, directory))).some((name) => name.endsWith(".json"))) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

function collectionPhysical(collection) { return { files: collection.corpus.counts.files,
  bytes: collection.corpus.counts.bytes, records: collection.corpus.counts.records }; }
function importedFields(collection, imported) {
  const dispositions = new Map(imported.records.map((item) => [item.source_ref, item.disposition]));
  const fields = {};
  for (const record of collection.records) {
    if (dispositions.get(record.source_ref) !== "imported" || record.source_payload === null
      || Array.isArray(record.source_payload) || typeof record.source_payload !== "object") continue;
    for (const key of Object.keys(record.source_payload)) fields[`${record.source_family}.${key}`] = (fields[`${record.source_family}.${key}`] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(fields).sort());
}
function diagnosticCodes(records) { const counts = {}; for (const record of records)
  for (const code of record.diagnostic_codes) counts[code] = (counts[code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort()); }
function coordinationDiagnosticCodes(records) { const counts = {}; for (const record of records)
  for (const item of record.diagnostics) counts[item.code] = (counts[item.code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort()); }
function assertConserved(counts) { assert.equal(counts.imported_records + counts.quarantined_records + counts.unresolved_records, counts.source_records); }
function emptyCounts() { return { source_records: 0, imported_records: 0, quarantined_records: 0, unresolved_records: 0, transactions: 0, events: 0 }; }
function addCounts(left, right) { return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]])); }
