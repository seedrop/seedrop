import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJsonBytes, generateCanonicalId, projectTransactionBytes, reconcilePrincipalCandidates,
} from "@seedrop/protocol";
import {
  projectProjectionBytes, projectProjectionDigest, projectStoreLayout, publishProjectTransaction,
  rebuildProjectProjection, scanProjectTransactions,
} from "@seedrop/project";
import { collectV1ViewHistory, importViewHistory } from "../dist/index.js";

const root = await mkdtemp(join(tmpdir(), "seedrop-clean-clone-proof-"));
const sourceRepo = join(root, "source");
const cleanHome = join(root, "clean-home");
const cloneRepo = join(cleanHome, "clone");
const sourceView = join(sourceRepo, ".seedrop", "view");
const sourceStore = join(sourceView, "v2", "project");
const cloneStore = join(cloneRepo, ".seedrop", "view", "v2", "project");
const AT = "2026-08-12T00:00:00.000Z";

try {
  await mkdir(cleanHome, { recursive: true });
  await createCommittedV1Fixture(sourceView);
  const v1Before = await legacyBytes(sourceView);
  const collection = await collectV1ViewHistory({ view_root: sourceView });
  const principalRegistry = reconcilePrincipalCandidates([
    { source_ref: "agent:fixture", kind: "agent", aliases: [{ namespace: "agent_id", value: "fixture-agent" }] },
    { source_ref: "agent:migration", kind: "agent", aliases: [{ namespace: "agent_id", value: "migration" }] },
  ], { mint_id: (source) => id("principal", source) }).registry;
  const projectId = id("project", "clean-clone-fixture");
  const migrationPrincipalId = principalRegistry.principals
    .find((principal) => principal.source_refs.includes("agent:migration")).principal_id;
  const imported = importViewHistory({ collection, project_id: projectId,
    migration_principal_id: migrationPrincipalId, principal_registry: principalRegistry, snapshot_recorded_at: AT });
  for (const transaction of imported.transactions) await publishProjectTransaction({ root: sourceStore, transaction });
  assert.deepEqual(await legacyBytes(sourceView), v1Before,
    "migration must not mutate v1 bytes before the committed v2 tree is added");

  const sourceProjection = await rebuildProjectProjection(sourceStore, projectId);
  const sourceScan = await scanProjectTransactions(sourceStore, projectId);
  const sourceCanonical = canonicalEvidence(sourceScan);
  const sourceDispositions = migrationDispositions(sourceScan);

  git(["init", "--quiet", sourceRepo]);
  git(["-C", sourceRepo, "config", "user.name", "Seedrop Portability Proof"]);
  git(["-C", sourceRepo, "config", "user.email", "proof@seedrop.local"]);
  git(["-C", sourceRepo, "add", ".seedrop/view/v2/project/transactions"]);
  git(["-C", sourceRepo, "commit", "--quiet", "-m", "commit migrated canonical View"]);
  const committedTree = git(["-C", sourceRepo, "rev-parse", "HEAD^{tree}"]);

  assert.equal(await pathAbsent(join(cleanHome, ".seedrop", "id")), true);
  assert.equal(await pathAbsent(join(cleanHome, ".seedrop", "space")), true);
  assert.equal(await pathAbsent(join(cleanHome, ".seedrop", "cache")), true);
  git(["clone", "--quiet", "--no-local", sourceRepo, cloneRepo], cleanHome, {
    ...process.env, HOME: cleanHome, XDG_CONFIG_HOME: join(cleanHome, ".config"),
  });
  assert.equal(await pathAbsent(projectStoreLayout(cloneStore).index_dir), true,
    "a clean clone must not contain a prebuilt projection index");

  const cloneProjection = await rebuildProjectProjection(cloneStore, projectId);
  const cloneScan = await scanProjectTransactions(cloneStore, projectId);
  const cloneCanonical = canonicalEvidence(cloneScan);
  const cloneDispositions = migrationDispositions(cloneScan);
  assert.deepEqual(cloneCanonical, sourceCanonical);
  assert.deepEqual(projectProjectionBytes(cloneProjection), projectProjectionBytes(sourceProjection));
  assert.equal(projectProjectionDigest(cloneProjection), projectProjectionDigest(sourceProjection));
  assert.equal(cloneProjection.source_digest, sourceProjection.source_digest);
  assert.equal(cloneProjection.source_high_watermark, sourceProjection.source_high_watermark);
  assert.deepEqual(cloneProjection.quarantined, sourceProjection.quarantined);
  assert.deepEqual(cloneDispositions, sourceDispositions);
  assert.equal(git(["-C", cloneRepo, "status", "--short", ".seedrop/view/v2/project/transactions"]), "");

  const machineContext = {
    status: "degraded",
    complete: false,
    identity: { status: "unavailable", reason: "passport_absent", reconstructed_from_project_history: false },
    coordination: { status: "unavailable", reason: "daemon_and_space_absent", reconstructed_from_project_history: false },
    caches: { status: "absent_at_clone", projection_index_rebuilt_from_canonical_transactions: true },
  };
  assert.equal(machineContext.status, "degraded");
  assert.equal(machineContext.identity.reconstructed_from_project_history, false);
  assert.equal(machineContext.coordination.reconstructed_from_project_history, false);

  console.log(JSON.stringify({ ok: true, mode: "git-portable-clean-account-shadow",
    committed_tree: committedTree, canonical_transaction_count: cloneCanonical.length,
    canonical_event_count: cloneScan.transactions.reduce((sum, item) => sum + item.transaction.events.length, 0),
    canonical_event_bytes_equal: true, canonical_transaction_digests_equal: true,
    projection_digest: projectProjectionDigest(cloneProjection),
    source_digest: cloneProjection.source_digest, high_watermark: cloneProjection.source_high_watermark,
    quarantine: { project_artifacts: cloneProjection.quarantined, migration_dispositions: cloneDispositions },
    machine_context: machineContext, clean_account: { passport_absent: true, daemon_space_absent: true,
      cache_absent_before_rebuild: true }, source_v1_unchanged: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createCommittedV1Fixture(viewRoot) {
  await Promise.all(["tasks", "runs", "continuity"].map((name) => mkdir(join(viewRoot, name), { recursive: true })));
  await writeJson(join(viewRoot, "tasks", "22222222-2222-4222-8222-222222222222.json"), {
    schema_version: "1.0", task_id: "22222222-2222-4222-8222-222222222222", title: "Portable task",
    status: "done", owner: "fixture-agent", created_at: AT, updated_at: AT,
    related_runs: ["11111111-1111-4111-8111-111111111111"],
  });
  await writeJson(join(viewRoot, "runs", "11111111-1111-4111-8111-111111111111.json"), {
    schema_version: "1.0", run_id: "11111111-1111-4111-8111-111111111111", agent_id: "fixture-agent",
    goal: "Prove portability", status: "completed", started_at: AT, updated_at: AT, finished_at: AT,
    steps: [], decisions: [], assumptions: [], open_threads: [], changed_paths: [], validation: [], next_actions: [],
  });
  await writeJson(join(viewRoot, "continuity", "33333333-3333-4333-8333-333333333333.json"), {
    schema_version: "1.0", id: "33333333-3333-4333-8333-333333333333", created_at: AT,
    agent: "fixture-agent", mission: "Portable reasoning", summary: "No explicit v1 run link.",
    decisions: [], assumptions: [], open_threads: [], changed_paths: [], validation: { status: "unknown", commands: [] },
  });
  await writeFile(join(viewRoot, "tasks", "broken.json"), "{broken", "utf8");
}

function canonicalEvidence(scan) {
  return scan.transactions.map((item) => ({ digest: item.digest, relative_path: item.relative_path,
    bytes: Buffer.from(projectTransactionBytes(item.transaction)).toString("base64"),
    event_bytes: item.transaction.events.map((event) => Buffer.from(canonicalJsonBytes(event)).toString("base64")) }));
}

function migrationDispositions(scan) {
  const counts = { imported: 0, quarantined: 0, unresolved: 0 };
  for (const item of scan.transactions) {
    const type = item.transaction.events[0]?.event_type;
    if (type === "seedrop.migration.record_imported") counts.imported += 1;
    if (type === "seedrop.migration.record_quarantined") counts.quarantined += 1;
    if (type === "seedrop.migration.record_unresolved") counts.unresolved += 1;
  }
  return counts;
}

function id(kind, source) {
  return generateCanonicalId(kind, { now: 1_725_000_000_000,
    entropy: new TextEncoder().encode(source.padEnd(10, "0")).slice(0, 10) });
}
function git(args, cwd, env = process.env) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function pathAbsent(path) { try { await readdir(path); return false; } catch (error) { if (error?.code === "ENOENT") return true; throw error; } }
async function legacyBytes(viewRoot) {
  const result = {};
  for (const directory of ["tasks", "runs", "continuity", "signals"]) {
    let names;
    try { names = await readdir(join(viewRoot, directory)); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
      result[`${directory}/${name}`] = (await readFile(join(viewRoot, directory, name))).toString("base64");
    }
  }
  return result;
}
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
