import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collectLiveIdentityCorpus,
  collectMachineCoordination,
  identityImportBytes,
  importIdentityRegistries,
  machineCoordinationBytes,
  machineCoordinationDigest,
  reconcileMachineCoordination,
} from "../dist/index.js";

const spaceRoot = join(homedir(), ".seedrop", "space");
const migrationRoot = join(homedir(), ".seedrop", "migrations", "space-root");
const snapshotAt = new Date().toISOString();
const identityInput = await collectLiveIdentityCorpus();
const identityFirst = importIdentityRegistries(identityInput);
const identitySecond = importIdentityRegistries(identityInput);
assert.deepEqual(identityImportBytes(identitySecond), identityImportBytes(identityFirst));

const firstCollection = await collectMachineCoordination({ space_root: spaceRoot, migration_root: migrationRoot });
const secondCollection = await collectMachineCoordination({ space_root: spaceRoot, migration_root: migrationRoot });
assert.deepEqual(secondCollection, firstCollection, "machine coordination source changed between shadow reads");
const input = {
  principal_registry: identityFirst.principal_registry,
  snapshot_at: snapshotAt,
};
const first = reconcileMachineCoordination({ collection: firstCollection, ...input });
const second = reconcileMachineCoordination({ collection: secondCollection, ...input });
assert.deepEqual(machineCoordinationBytes(second), machineCoordinationBytes(first));
assert.equal(machineCoordinationDigest(second), machineCoordinationDigest(first));
assert.equal(
  first.receipt.counts.imported_records
    + first.receipt.counts.quarantined_records
    + first.receipt.counts.unresolved_records,
  first.receipt.counts.source_records,
);
assert.equal(firstCollection.physical_file_count, firstCollection.corpus.counts.files);
assert.equal(firstCollection.physical_byte_count, firstCollection.corpus.counts.bytes);
assert.equal(JSON.stringify(first).includes("project_id"), false);
assert.equal(JSON.stringify(first).includes("transaction"), false);

const diagnosticCodes = {};
for (const record of first.records) {
  for (const diagnostic of record.diagnostics) {
    diagnosticCodes[diagnostic.code] = (diagnosticCodes[diagnostic.code] ?? 0) + 1;
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: "live-read-only-machine-coordination",
  corpus_digest: first.receipt.corpus_digest,
  source_tree_digest: first.receipt.source_tree_digest,
  reconciliation_digest: machineCoordinationDigest(first),
  source_tree_unchanged: true,
  byte_identical_rerun: true,
  project_truth_absorbed: false,
  physical: {
    files: firstCollection.physical_file_count,
    bytes: firstCollection.physical_byte_count,
  },
  counts: first.receipt.counts,
  by_family: Object.fromEntries(first.receipt.family_counts.map((group) => [group.source_family, {
    source_records: group.source_records,
    imported_records: group.imported_records,
    quarantined_records: group.quarantined_records,
    unresolved_records: group.unresolved_records,
  }])),
  by_authority: Object.fromEntries(first.receipt.authority_counts.map((group) => [group.authority_class, {
    source_records: group.source_records,
    imported_records: group.imported_records,
    quarantined_records: group.quarantined_records,
    unresolved_records: group.unresolved_records,
  }])),
  presence: first.receipt.presence,
  root_migrations: first.receipt.root_migrations,
  diagnostic_codes: Object.fromEntries(Object.entries(diagnosticCodes).sort()),
}));
