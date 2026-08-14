import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "./v2-snapshot.mjs";

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("creates, verifies, and restore-tests a private content-addressed corpus", () => {
  const fixture = mkdtempSync(join(tmpdir(), "seedrop-v2-fixture-"));
  try {
    const seedropHome = join(fixture, ".seedrop");
    const repo = join(fixture, "repo");
    const view = join(repo, ".seedrop", "view");
    mkdirSync(join(seedropHome, "id", "agents"), { recursive: true });
    mkdirSync(join(seedropHome, "space", ".seedrop", "space"), { recursive: true });
    mkdirSync(join(seedropHome, "state"), { recursive: true });
    mkdirSync(join(view, "runs"), { recursive: true });
    json(join(seedropHome, "id", "passport.json"), {
      agent_id: "fixture",
      active_projects: [{ root: repo }],
      credential_refs: [{ name: "private", ref: "must-not-appear-in-manifest" }],
    });
    writeFileSync(join(seedropHome, "id", "passport.json.audit.jsonl"), '{"event":"created"}\n');
    json(join(seedropHome, "state", "active-passport.json"), { passport_path: "fixture" });
    json(join(view, "manifest.json"), { schema_version: "1.0", files: [] });
    json(join(view, "runs", "run.json"), { run_id: "fixture" });
    const database = join(seedropHome, "space", ".seedrop", "space", "live.db");
    execFileSync("sqlite3", [database, "CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('one');"]);
    const snapshot = join(fixture, "snapshot");
    const created = createSnapshot({ seedropHome, repoRoot: repo, output: snapshot });
    assert.equal(created.restore_drill, "passed");
    assert.equal(created.views, 1);
    assert.ok(created.logical_records >= 5);

    const manifestText = readFileSync(join(snapshot, "manifest.json"), "utf8");
    assert.equal(manifestText.includes("must-not-appear-in-manifest"), false);
    assert.equal(fileMode(snapshot), "700");
    assert.equal(fileMode(join(snapshot, "manifest.json")), "600");

    const verified = verifySnapshot(snapshot);
    assert.equal(verified.corpus_sha256, created.corpus_sha256);
    const drill = restoreSnapshot(snapshot, { testOnly: true });
    assert.equal(drill.files, created.files);
    assert.equal(drill.logical_records, created.logical_records);

    const restored = join(fixture, "restored");
    const result = restoreSnapshot(snapshot, { target: restored });
    assert.equal(result.corpus_sha256, created.corpus_sha256);
    assert.throws(() => restoreSnapshot(snapshot, { target: restored }), /already exists/);

    const manifest = JSON.parse(manifestText);
    const firstObject = manifest.entries.find((entry) => entry.type === "file").object;
    writeFileSync(join(snapshot, firstObject), "tampered");
    assert.throws(() => verifySnapshot(snapshot), /Object hash mismatch/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function fileMode(path) {
  return (statSync(path).mode & 0o777).toString(8);
}
