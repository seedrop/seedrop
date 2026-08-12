import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrincipalIdentity, resolveProjectIdentity } from "@seedrop/protocol";
import {
  collectLiveIdentityCorpus,
  collectV1ViewHistory,
  digestReadOnlyTree,
  identityImportBytes,
  importIdentityRegistries,
  importViewHistory,
  viewHistoryImportBytes,
  viewHistoryImportDigest,
} from "../dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const viewRoot = join(repoRoot, ".seedrop", "view");
const temporaryRoot = await mkdtemp(join(tmpdir(), "seedrop-outcome-proof-"));
const outcomePath = join(temporaryRoot, "outcome-layer.json");

try {
  execFileSync(process.execPath, [join(repoRoot, "scripts", "outcome-layer.mjs"), "--root", repoRoot, "--json", outcomePath], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const outcomeReport = JSON.parse(await readFile(outcomePath, "utf8"));
  const identityInput = await collectLiveIdentityCorpus();
  const identityFirst = importIdentityRegistries(identityInput);
  const identitySecond = importIdentityRegistries(identityInput);
  assert.deepEqual(identityImportBytes(identitySecond), identityImportBytes(identityFirst));
  const projectId = resolveProjectIdentity(identityFirst.project_registry, { namespace: "placement_path", value: repoRoot });
  const migrationPrincipalId = resolvePrincipalIdentity(identityFirst.principal_registry, "jerry");
  const before = await digestReadOnlyTree(viewRoot);
  const firstCollection = await collectV1ViewHistory({ view_root: viewRoot, outcome_report_path: outcomePath });
  const secondCollection = await collectV1ViewHistory({ view_root: viewRoot, outcome_report_path: outcomePath });
  assert.deepEqual(secondCollection, firstCollection);
  const importInput = {
    project_id: projectId,
    migration_principal_id: migrationPrincipalId,
    principal_registry: identityFirst.principal_registry,
    snapshot_recorded_at: outcomeReport.generated_at,
  };
  const first = importViewHistory({ collection: firstCollection, ...importInput });
  const second = importViewHistory({ collection: secondCollection, ...importInput });
  const after = await digestReadOnlyTree(viewRoot);
  assert.equal(after, before, "live View tree changed during read-only import");
  assert.deepEqual(viewHistoryImportBytes(second), viewHistoryImportBytes(first));
  assert.equal(viewHistoryImportDigest(second), viewHistoryImportDigest(first));
  assert.equal(
    first.receipt.counts.imported_records + first.receipt.counts.quarantined_records + first.receipt.counts.unresolved_records,
    first.receipt.counts.source_records,
  );
  assert.equal(first.receipt.counts.transactions, first.receipt.counts.source_records);

  const byFamily = Object.fromEntries([
    "task", "run", "continuity", "signal", "delivery_observation",
  ].map((family) => [family, Object.fromEntries([
    "imported", "quarantined", "unresolved",
  ].map((disposition) => [disposition, first.records.filter((record) => (
    record.source_family === family && record.disposition === disposition
  )).length]))]));
  const diagnosticCodes = {};
  for (const record of first.records) {
    for (const code of record.diagnostic_codes) diagnosticCodes[code] = (diagnosticCodes[code] ?? 0) + 1;
  }
  console.log(JSON.stringify({
    ok: true,
    mode: "live-read-only-shadow",
    corpus_digest: first.receipt.corpus_digest,
    source_tree_digest: first.receipt.source_tree_digest,
    import_digest: viewHistoryImportDigest(first),
    source_tree_unchanged: true,
    byte_identical_rerun: true,
    counts: first.receipt.counts,
    by_family: byFamily,
    diagnostic_codes: Object.fromEntries(Object.entries(diagnosticCodes).sort()),
  }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
