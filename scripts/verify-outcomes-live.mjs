import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePrincipalIdentity, resolveProjectIdentity } from "@seedrop/protocol";
import { compileGraveProjection, compileOutcomeProjection, graveProjectionBytes, outcomeProjectionBytes, outcomeProjectionDigest } from "@seedrop/outcomes";
import { collectLiveIdentityCorpus, collectV1ViewHistory, digestReadOnlyTree,
  importIdentityRegistries, importViewHistory } from "@seedrop/migration";

const repoRoot = resolve(process.cwd());
const viewRoot = join(repoRoot, ".seedrop", "view");
const temporaryRoot = await mkdtemp(join(tmpdir(), "seedrop-outcomes-live-"));
const reportPath = join(temporaryRoot, "outcome-layer.json");
try {
  execFileSync(process.execPath, [join(repoRoot, "scripts", "outcome-layer.mjs"), "--root", repoRoot, "--json", reportPath],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const identities = importIdentityRegistries(await collectLiveIdentityCorpus());
  const before = await digestReadOnlyTree(viewRoot);
  const collection = await collectV1ViewHistory({ view_root: viewRoot, outcome_report_path: reportPath });
  const imported = importViewHistory({ collection,
    project_id: resolveProjectIdentity(identities.project_registry, { namespace: "placement_path", value: repoRoot }),
    migration_principal_id: resolvePrincipalIdentity(identities.principal_registry, "jerry"),
    principal_registry: identities.principal_registry, snapshot_recorded_at: report.generated_at });
  const first = compileOutcomeProjection({ transactions: imported.transactions });
  const second = compileOutcomeProjection({ transactions: [...imported.transactions].reverse() });
  const gravesFirst = compileGraveProjection({ transactions: imported.transactions, outcomes: first });
  const gravesSecond = compileGraveProjection({ transactions: [...imported.transactions].reverse(), outcomes: second });
  assert.deepEqual(outcomeProjectionBytes(second), outcomeProjectionBytes(first));
  assert.equal(await digestReadOnlyTree(viewRoot), before, "live View changed during outcome projection");
  const observationEvents = imported.transactions.flatMap((transaction) => transaction.events)
    .filter((event) => event.event_type === "seedrop.outcome.validation_observed"
      || event.event_type === "seedrop.outcome.delivery_observed");
  assert.equal(first.observation_count, observationEvents.length);
  assert.deepEqual(graveProjectionBytes(gravesSecond), graveProjectionBytes(gravesFirst));
  const counts = first.subjects.reduce((result, subject) => {
    result.evidence[subject.evidence] = (result.evidence[subject.evidence] ?? 0) + 1;
    result.delivery[subject.delivery] = (result.delivery[subject.delivery] ?? 0) + 1;
    result.contradictions += subject.contradictions.length;
    return result;
  }, { evidence: {}, delivery: {}, contradictions: 0 });
  console.log(JSON.stringify({ ok: true, mode: "live-read-only-outcomes-shadow",
    projection_digest: outcomeProjectionDigest(first), source_tree_unchanged: true,
    byte_identical_rerun: true, transactions: imported.transactions.length,
    observations: first.observation_count, subjects: first.subjects.length, counts,
    graves: { total: gravesFirst.graves.length,
      by_kind: gravesFirst.graves.reduce((result, grave) => ({ ...result, [grave.kind]: (result[grave.kind] ?? 0) + 1 }), {}),
      complete: gravesFirst.graves.filter((grave) => grave.completeness.status === "complete").length,
      partial: gravesFirst.graves.filter((grave) => grave.completeness.status === "partial").length } }));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
