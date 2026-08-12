import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMigrationCorpus,
  collectLiveIdentityCorpus,
  digestReadOnlyTree,
  identityImportBytes,
  identityImportDigest,
  importIdentityRegistries,
} from "../dist/index.js";

const protocolEntry = import.meta.resolve("@seedrop/protocol");
const fixturePath = fileURLToPath(new URL("../fixtures/machine-identity-corpus.json", protocolEntry));
const fixtureRaw = await readFile(fixturePath);
const fixture = JSON.parse(fixtureRaw.toString("utf8"));
const frozen = frozenInputs(fixture, fixtureRaw);
const first = importIdentityRegistries(frozen);
const second = importIdentityRegistries(frozen);

assert.deepEqual(identityImportBytes(first), identityImportBytes(second));
assert.equal(identityImportDigest(first), identityImportDigest(second));
assert.equal(first.receipt.counts.principal_sources, fixture.expected.passport_count);
assert.equal(first.receipt.counts.project_sources, fixture.expected.project_link_count);
assert.equal(first.receipt.counts.canonical_principals, fixture.expected.principal_count);
assert.equal(first.receipt.counts.unique_project_placements, fixture.expected.unique_root_count);
assert.equal(first.receipt.counts.canonical_projects, fixture.expected.project_count);
assert.equal(first.receipt.counts.unresolved_project_sources, fixture.expected.unresolved_project_sources);

const output = {
  ok: true,
  frozen: {
    passports: first.receipt.counts.principal_sources,
    project_links: first.receipt.counts.project_sources,
    unique_placements: first.receipt.counts.unique_project_placements,
    canonical_principals: first.receipt.counts.canonical_principals,
    canonical_projects: first.receipt.counts.canonical_projects,
    unresolved_project_sources: first.receipt.counts.unresolved_project_sources,
    import_digest: identityImportDigest(first),
    byte_identical_rerun: true,
  },
};

if (process.argv.includes("--live")) {
  const identityRoot = join(homedir(), ".seedrop", "id");
  const before = await digestReadOnlyTree(identityRoot);
  const liveFirstInput = await collectLiveIdentityCorpus({ identity_root: identityRoot });
  const liveFirst = importIdentityRegistries(liveFirstInput);
  const liveSecondInput = await collectLiveIdentityCorpus({ identity_root: identityRoot });
  const liveSecond = importIdentityRegistries(liveSecondInput);
  const after = await digestReadOnlyTree(identityRoot);
  assert.equal(before, after, "live identity tree changed during read-only import");
  assert.deepEqual(identityImportBytes(liveFirst), identityImportBytes(liveSecond));
  output.live = {
    passports: liveFirst.receipt.counts.principal_sources,
    project_links: liveFirst.receipt.counts.project_sources,
    unique_placements: liveFirst.receipt.counts.unique_project_placements,
    canonical_principals: liveFirst.receipt.counts.canonical_principals,
    canonical_projects: liveFirst.receipt.counts.canonical_projects,
    unresolved_project_sources: liveFirst.receipt.counts.unresolved_project_sources,
    source_tree_unchanged: true,
    byte_identical_rerun: true,
    matches_frozen_corpus: liveFirstInput.corpus.corpus_digest === frozen.corpus.corpus_digest,
  };
}

console.log(JSON.stringify(output));

function frozenInputs(corpus, raw) {
  const principals = corpus.principals.map((entry) => ({
    source_ref: entry.source_ref,
    kind: entry.kind,
    aliases: [
      { namespace: "passport_id", value: entry.passport_id },
      { namespace: "agent_id", value: entry.agent_id },
      { namespace: "display_name", value: entry.display_name },
    ],
  }));
  const projects = corpus.projects.map((entry) => ({
    source_ref: entry.source_ref,
    legacy_id: entry.legacy_id,
    root: entry.root,
    placement_kind: entry.placement_kind,
    repository_identities: entry.git_remote ? [{ kind: "git_remote", value: entry.git_remote }] : [],
  }));
  return {
    corpus: buildMigrationCorpus([{
      source_ref: "frozen:machine-identity-corpus-v1",
      source_kind: "identity",
      source_digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      file_count: 1,
      byte_count: raw.byteLength,
      record_count: principals.length + projects.length,
    }]),
    principals,
    projects,
  };
}
