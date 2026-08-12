import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHealthEnvelope, canonicalJsonBytes, canonicalJsonDigest, projectTransactionDigest,
  resolvePrincipalIdentity, resolveProjectIdentity } from "@seedrop/protocol";
import { reduceImportedOrientation, reduceProjectTransactions, reduceWorkProjection } from "@seedrop/project";
import { compileGraveProjection, compileOutcomeProjection, compileSourceInvalidation } from "@seedrop/outcomes";
import { boundedSituationBytes, compileBoundedSituation, compileSituation } from "@seedrop/situation";
import { collectLiveIdentityCorpus, collectV1ViewHistory, digestReadOnlyTree,
  importIdentityRegistries, importViewHistory } from "@seedrop/migration";

const repoRoot = resolve(process.cwd()), viewRoot = join(repoRoot, ".seedrop", "view");
const temporaryRoot = await mkdtemp(join(tmpdir(), "seedrop-situation-live-"));
const reportPath = join(temporaryRoot, "outcome-layer.json");
try {
  execFileSync(process.execPath, [join(repoRoot, "scripts", "outcome-layer.mjs"), "--root", repoRoot, "--json", reportPath],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const manifest = JSON.parse(await readFile(join(viewRoot, "manifest.json"), "utf8"));
  const identities = importIdentityRegistries(await collectLiveIdentityCorpus());
  const projectId = resolveProjectIdentity(identities.project_registry, { namespace: "placement_path", value: repoRoot });
  const principalId = resolvePrincipalIdentity(identities.principal_registry, "jerry");
  const before = await digestReadOnlyTree(viewRoot);
  const collection = await collectV1ViewHistory({ view_root: viewRoot, outcome_report_path: reportPath });
  const imported = importViewHistory({ collection, project_id: projectId, migration_principal_id: principalId,
    principal_registry: identities.principal_registry, snapshot_recorded_at: report.generated_at });
  const transactions = imported.transactions.map((transaction) => {
    const digest = projectTransactionDigest(transaction);
    return { digest, relative_path: `transactions/${digest.slice(7)}.json`, byte_length: canonicalJsonBytes(transaction).byteLength, transaction };
  });
  const scan = { project_id: projectId, transactions, sources: transactions.map((entry) => ({ path: entry.relative_path,
    expected_digest: entry.digest, actual_digest: entry.digest, status: "valid" })), diagnostics: [] };
  const projection = reduceProjectTransactions(scan);
  const work = reduceWorkProjection(scan);
  const importedOrientation = reduceImportedOrientation(scan);
  const outcomes = compileOutcomeProjection({ transactions: imported.transactions });
  const graves = compileGraveProjection({ transactions: imported.transactions, outcomes });
  const invalidation = compileSourceInvalidation({ current_sources: [], claims: [] });
  const observedAt = report.generated_at;
  const governing = transactions.at(-1)?.transaction.events.at(-1)?.event_id ?? null;
  const health = buildHealthEnvelope({ generated_at: observedAt, projection_version: projection.projection_version,
    policy: { policy_id: "seedrop.situation.wave5-shadow", policy_version: "1.0.0", required_projection_version: "1.0.0", required_source_ids: ["project"] },
    sources: [{ source_id: "project", kind: "project_transactions", status: "available", high_watermark: projection.source_high_watermark,
      content_digest: projection.source_digest, observed_at: observedAt, governing_record_id: governing }],
    budget: { requested_bytes: 4096, actual_bytes: 0, complete: true, candidate_count: transactions.length,
      indexed_count: transactions.length, scanned_count: 0, omitted_categories: [] } });
  const situation = compileSituation({ generated_at: observedAt,
    project: port("project", projection.source_digest, { projection, work, imported_orientation: importedOrientation, health }, observedAt),
    outcomes: port("outcomes", outcomes.source_digest, outcomes, observedAt), graves: port("graves", graves.source_digest, graves, observedAt),
    identity: port("identity", identities.receipt.source_mapping_digest, { principal_id: principalId, display_name: "jerry", status: "resolved", candidates: [] }, observedAt),
    coordination: port("coordination", canonicalJsonDigest({ status: "unavailable" }), { status: "unavailable", active_claims: [], inbox_unacked: 0 }, observedAt),
    invalidation: port("invalidation", invalidation.source_digest, invalidation, observedAt) });
  const eventCount = imported.transactions.reduce((sum, transaction) => sum + transaction.events.length, 0);
  const bounded = compileBoundedSituation(situation, { requested_bytes: 4096,
    metrics: { candidate_count: eventCount, indexed_count: eventCount, scanned_count: 0,
      event_count: eventCount, file_count: manifest.files.length } });
  const bytes = boundedSituationBytes(bounded);
  assert.equal(bytes.byteLength, bounded.budget.actual_bytes);
  assert.ok(bytes.byteLength <= 4096);
  assert.ok(bounded.orientation.intent, "real corpus must expose current intent");
  assert.ok(bounded.orientation.delivery, "real corpus must expose delivery state");
  assert.ok(bounded.orientation.grave, "real corpus must expose a relevant Grave");
  assert.ok(bounded.orientation.source_health, "real corpus must expose source health");
  assert.ok(bounded.orientation.next_action, "real corpus must expose a decision");
  assert.ok(bounded.trust, "4 KiB output must retain field trust metadata");
  assert.equal(bounded.budget.scanned_count, 0);
  assert.equal(await digestReadOnlyTree(viewRoot), before, "live View changed during Situation projection");
  console.log(JSON.stringify({ ok: true, mode: "live-read-only-situation-shadow", bytes: bytes.byteLength,
    budget: bounded.budget, situation_id: bounded.situation_id, decision_id: bounded.decision_id,
    intent: bounded.orientation.intent, risk: bounded.orientation.risk, delivery: bounded.orientation.delivery,
    grave: bounded.orientation.grave, source_health: bounded.orientation.source_health,
    next_action: bounded.orientation.next_action, source_tree_unchanged: true }));
} finally { await rm(temporaryRoot, { recursive: true, force: true }); }

function port(source_id, source_digest, value, observed_at) {
  return { source_id, source_digest, observed_at, freshness: "current", completeness: "complete", value, missing: [] };
}
