#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "seedrop-v2-snapshot/1.0";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_STABLE_READ_ATTEMPTS = 8;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function modeOf(stats) {
  return typeof stats.mode === "bigint" ? Number(stats.mode & 0o777n) : stats.mode & 0o777;
}

function octal(mode) {
  return mode.toString(8).padStart(4, "0");
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

function writePrivateFile(path, bytes) {
  ensurePrivateDirectory(dirname(path));
  const fd = openSync(path, "w", FILE_MODE);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, FILE_MODE);
}

function portablePath(path, home = homedir()) {
  if (path === home) return "$HOME";
  if (path.startsWith(`${home}${sep}`)) return `$HOME/${relative(home, path).split(sep).join("/")}`;
  return path;
}

function stableRead(path) {
  for (let attempt = 1; attempt <= MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = lstatSync(path, { bigint: true });
    const bytes = readFileSync(path);
    const after = lstatSync(path, { bigint: true });
    if (
      before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && before.mtimeNs === after.mtimeNs
    ) {
      return { bytes, stats: after };
    }
  }
  throw new Error(`Could not obtain a stable read after ${MAX_STABLE_READ_ATTEMPTS} attempts: ${path}`);
}

function sqliteCommand(database, sql) {
  try {
    return execFileSync("sqlite3", [database, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    throw new Error(`SQLite operation failed for ${database}${detail ? `: ${detail}` : ""}`, { cause: error });
  }
}

function sqliteBackup(source) {
  const work = mkdtempSync(join(tmpdir(), "seedrop-v2-sqlite-"));
  const target = join(work, "snapshot.db");
  try {
    sqliteCommand(source, `.backup ${target}`);
    const integrity = sqliteCommand(target, "PRAGMA integrity_check;").trim();
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed for ${source}: ${integrity}`);
    return readFileSync(target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function isSqlite(bytes) {
  return bytes.subarray(0, 16).toString("binary") === "SQLite format 3\u0000";
}

function sqliteRecordInfo(database) {
  const names = JSON.parse(
    sqliteCommand(
      database,
      "SELECT json_group_array(name) FROM (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name);",
    ).trim() || "[]",
  );
  const tables = [];
  let total = 0;
  for (const name of names) {
    const quoted = `"${String(name).replaceAll('"', '""')}"`;
    const count = Number(sqliteCommand(database, `SELECT count(*) FROM ${quoted};`).trim());
    tables.push({ name, records: count });
    total += count;
  }
  return { records: total, tables };
}

function logicalRecordInfo(path, bytes) {
  if (isSqlite(bytes)) {
    const work = mkdtempSync(join(tmpdir(), "seedrop-v2-count-"));
    const database = join(work, "object.db");
    try {
      writeFileSync(database, bytes, { mode: FILE_MODE });
      return { format: "sqlite", ...sqliteRecordInfo(database) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  if (path.endsWith(".jsonl")) {
    return {
      format: "jsonl",
      records: bytes.toString("utf8").split("\n").filter((line) => line.trim().length > 0).length,
    };
  }
  if (path.endsWith(".json")) {
    try {
      JSON.parse(bytes.toString("utf8"));
      return { format: "json", records: 1 };
    } catch {
      return { format: "invalid-json", records: 0 };
    }
  }
  return null;
}

function putObject(snapshotRoot, bytes) {
  const digest = sha256(bytes);
  const objectPath = join(snapshotRoot, "objects", digest.slice(0, 2), digest.slice(2));
  if (!existsSync(objectPath)) writePrivateFile(objectPath, bytes);
  else if (sha256(readFileSync(objectPath)) !== digest) throw new Error(`Object collision at ${objectPath}`);
  return { digest, object: `objects/${digest.slice(0, 2)}/${digest.slice(2)}` };
}

function walkSource(source, snapshotRoot) {
  const entries = [];

  function visit(absolute, rel) {
    const stats = lstatSync(absolute, { bigint: true });
    const path = rel || ".";
    if (stats.isDirectory()) {
      entries.push({ source_id: source.id, path, type: "directory", mode: octal(modeOf(stats)) });
      for (const child of readdirSync(absolute).sort()) visit(join(absolute, child), rel ? `${rel}/${child}` : child);
      return;
    }
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      entries.push({
        source_id: source.id,
        path,
        type: "symlink",
        mode: octal(modeOf(stats)),
        target,
        sha256: sha256(`symlink\u0000${target}`),
      });
      return;
    }
    if (!stats.isFile()) throw new Error(`Unsupported filesystem entry in snapshot scope: ${absolute}`);

    let bytes;
    let capturedStats = stats;
    let capture = "stable-read";
    const initial = readFileSync(absolute, { flag: "r" });
    if (isSqlite(initial)) {
      bytes = sqliteBackup(absolute);
      capture = "sqlite-online-backup";
    } else {
      const stable = stableRead(absolute);
      bytes = stable.bytes;
      capturedStats = stable.stats;
    }
    const stored = putObject(snapshotRoot, bytes);
    const recordInfo = logicalRecordInfo(absolute, bytes);
    entries.push({
      source_id: source.id,
      path,
      type: "file",
      mode: octal(modeOf(capturedStats)),
      size_bytes: bytes.length,
      sha256: stored.digest,
      object: stored.object,
      capture,
      ...(recordInfo ? { record_info: recordInfo } : {}),
    });
  }

  visit(source.path, "");
  return entries;
}

function passportFiles(identityRoot) {
  if (!existsSync(identityRoot)) return [];
  const files = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".commit.json")) files.push(absolute);
    }
  }
  visit(identityRoot);
  return files.sort();
}

function discoverViews(identityRoot, explicitRoots = []) {
  const roots = new Set(explicitRoots.map((path) => resolve(path)));
  const unreadablePassports = [];
  for (const file of passportFiles(identityRoot)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      for (const project of parsed.active_projects ?? []) {
        if (typeof project.root === "string" && project.root.length > 0) roots.add(resolve(project.root));
      }
    } catch {
      unreadablePassports.push(file);
    }
  }

  const found = [];
  const missing = [];
  for (const root of [...roots].sort()) {
    const view = join(root, ".seedrop", "view");
    if (existsSync(view) && lstatSync(view).isDirectory()) found.push(view);
    else missing.push(view);
  }
  return { found: [...new Set(found)], missing, unreadablePassports };
}

function sourceId(kind, path) {
  return `${kind}-${sha256(resolve(path)).slice(0, 12)}`;
}

function sourceSummary(source, entries) {
  const own = entries.filter((entry) => entry.source_id === source.id);
  return {
    ...source,
    files: own.filter((entry) => entry.type === "file").length,
    directories: own.filter((entry) => entry.type === "directory").length,
    symlinks: own.filter((entry) => entry.type === "symlink").length,
    logical_records: own.reduce((sum, entry) => sum + (entry.record_info?.records ?? 0), 0),
    bytes: own.reduce((sum, entry) => sum + (entry.size_bytes ?? 0), 0),
  };
}

function corpusProjection(manifest) {
  return {
    schema_version: manifest.schema_version,
    sources: manifest.sources,
    entries: manifest.entries,
    counts: manifest.counts,
    missing_views: manifest.missing_views,
    unreadable_passports: manifest.unreadable_passports,
  };
}

function snapshotCounts(entries, sources, uniqueObjects) {
  return {
    sources: sources.length,
    views: sources.filter((source) => source.kind === "view").length,
    files: entries.filter((entry) => entry.type === "file").length,
    directories: entries.filter((entry) => entry.type === "directory").length,
    symlinks: entries.filter((entry) => entry.type === "symlink").length,
    unique_objects: uniqueObjects,
    logical_records: entries.reduce((sum, entry) => sum + (entry.record_info?.records ?? 0), 0),
    bytes: entries.reduce((sum, entry) => sum + (entry.size_bytes ?? 0), 0),
  };
}

function restoreInstructions() {
  return `# Seedrop v2 pre-migration snapshot\n\nThis directory contains private, content-addressed Seedrop state. Keep the directory and every file permission-restricted. The manifest contains source paths and record counts, but never embeds passport, message, credential-reference, or View contents.\n\n## Verify\n\nFrom the Seedrop source tree:\n\n\`\`\`bash\nnode scripts/v2-snapshot.mjs verify <snapshot-directory>\nnode scripts/v2-snapshot.mjs restore-test <snapshot-directory>\n\`\`\`\n\n## Reconstruct an isolated copy\n\nThe target must not exist. This command never writes to the recorded live source paths:\n\n\`\`\`bash\nnode scripts/v2-snapshot.mjs restore <snapshot-directory> --target <new-empty-path>\n\`\`\`\n\nThe reconstructed corpus is under \`<target>/sources/<source-id>/\`; \`<target>/restore-map.json\` maps each source id to its original location. Verify the copy before any recovery.\n\n## Disaster recovery\n\n1. Stop the Seedrop daemon so JSONL and SQLite stores cannot change during recovery.\n2. Run \`verify\` and \`restore-test\` against this snapshot.\n3. Reconstruct into a new empty path with \`restore\`; do not restore directly over live state.\n4. Compare \`restore-map.json\` with the intended recovery targets.\n5. Move the damaged live path aside, then copy the corresponding reconstructed source into place while preserving modes.\n6. Start the daemon and run \`seed daemon status\`, \`seed boot --json\`, and the relevant View audit/preflight checks.\n7. Keep the displaced state until all counts, hashes, and product-level checks pass.\n`;
}

export function createSnapshot(options = {}) {
  const seedropHome = resolve(options.seedropHome ?? join(homedir(), ".seedrop"));
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const identityRoot = join(seedropHome, "id");
  const daemonRoot = join(seedropHome, "space");
  const machineStateRoot = join(seedropHome, "state");
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const output = resolve(options.output ?? join(seedropHome, "backups", "v2-preflight", timestamp));
  if (existsSync(output)) throw new Error(`Snapshot output already exists: ${output}`);

  const parent = dirname(output);
  ensurePrivateDirectory(parent);
  const staging = join(parent, `.${basename(output)}.partial-${randomUUID()}`);
  ensurePrivateDirectory(staging);

  try {
    const discovered = discoverViews(identityRoot, [repoRoot]);
    const rawSources = [
      { kind: "identity", path: identityRoot },
      { kind: "daemon", path: daemonRoot },
      ...(existsSync(machineStateRoot) ? [{ kind: "machine-state", path: machineStateRoot }] : []),
      ...discovered.found.map((path) => ({ kind: "view", path })),
    ];
    for (const source of rawSources) {
      if (!existsSync(source.path)) throw new Error(`Required snapshot source is missing: ${source.path}`);
    }
    const sources = rawSources.map((source) => ({
      id: sourceId(source.kind, source.path),
      kind: source.kind,
      path: resolve(source.path),
      portable_path: portablePath(resolve(source.path)),
    }));
    const entries = sources.flatMap((source) => walkSource(source, staging));
    entries.sort((a, b) => a.source_id.localeCompare(b.source_id) || a.path.localeCompare(b.path));
    const objectDigests = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.sha256));
    const summarizedSources = sources.map((source) => sourceSummary(source, entries));
    const manifest = {
      schema_version: SCHEMA_VERSION,
      snapshot_id: randomUUID(),
      created_at: new Date().toISOString(),
      security: {
        snapshot_directory_mode: "0700",
        snapshot_file_mode: "0600",
        contents_embedded_in_manifest: false,
      },
      sources: summarizedSources,
      entries,
      missing_views: discovered.missing.map((path) => ({ path, portable_path: portablePath(path) })),
      unreadable_passports: discovered.unreadablePassports.map((path) => ({ path, portable_path: portablePath(path) })),
      counts: snapshotCounts(entries, summarizedSources, objectDigests.size),
    };
    manifest.corpus_sha256 = sha256(canonicalJson(corpusProjection(manifest)));

    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    writePrivateFile(join(staging, "manifest.json"), manifestBytes);
    writePrivateFile(join(staging, "RESTORE.md"), restoreInstructions());
    const receipt = {
      schema_version: SCHEMA_VERSION,
      snapshot_id: manifest.snapshot_id,
      manifest_sha256: sha256(manifestBytes),
      corpus_sha256: manifest.corpus_sha256,
      created_at: manifest.created_at,
      restore_drill: { status: "pending" },
    };
    writePrivateFile(join(staging, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    verifySnapshot(staging);
    const drill = restoreSnapshot(staging, { testOnly: true });
    receipt.restore_drill = {
      status: "passed",
      verified_at: new Date().toISOString(),
      files: drill.files,
      logical_records: drill.logical_records,
      corpus_sha256: drill.corpus_sha256,
    };
    writePrivateFile(join(staging, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(staging, output);
    return { output, ...manifest.counts, corpus_sha256: manifest.corpus_sha256, restore_drill: "passed" };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function readSnapshot(snapshotRoot) {
  const root = resolve(snapshotRoot);
  const manifestBytes = readFileSync(join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
  if (manifest.schema_version !== SCHEMA_VERSION || receipt.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported snapshot schema in ${root}`);
  }
  if (sha256(manifestBytes) !== receipt.manifest_sha256) throw new Error("Manifest hash does not match receipt");
  const corpusHash = sha256(canonicalJson(corpusProjection(manifest)));
  if (corpusHash !== manifest.corpus_sha256 || corpusHash !== receipt.corpus_sha256) {
    throw new Error("Canonical corpus hash does not match manifest and receipt");
  }
  return { root, manifest, receipt };
}

export function verifySnapshot(snapshotRoot) {
  const { root, manifest, receipt } = readSnapshot(snapshotRoot);
  if (modeOf(statSync(root)) !== DIR_MODE) throw new Error(`Snapshot root must have mode 0700: ${root}`);
  for (const control of ["manifest.json", "receipt.json", "RESTORE.md"]) {
    const path = join(root, control);
    if (modeOf(statSync(path)) !== FILE_MODE) throw new Error(`${control} must have mode 0600`);
  }
  const files = manifest.entries.filter((entry) => entry.type === "file");
  const checked = new Set();
  for (const entry of files) {
    if (checked.has(entry.object)) continue;
    const objectPath = join(root, entry.object);
    const bytes = readFileSync(objectPath);
    if (sha256(bytes) !== entry.sha256) throw new Error(`Object hash mismatch: ${entry.object}`);
    if (modeOf(statSync(objectPath)) !== FILE_MODE) throw new Error(`Object must have mode 0600: ${entry.object}`);
    checked.add(entry.object);
  }
  return {
    snapshot: root,
    files: manifest.counts.files,
    logical_records: manifest.counts.logical_records,
    unique_objects: checked.size,
    corpus_sha256: manifest.corpus_sha256,
    restore_drill: receipt.restore_drill.status,
  };
}

function targetFor(targetRoot, sourceId, rel) {
  const base = resolve(targetRoot, "sources", sourceId);
  const target = rel === "." ? base : resolve(base, ...rel.split("/"));
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`Unsafe manifest path: ${rel}`);
  return target;
}

function verifyRestoredEntry(targetRoot, snapshotRoot, entry) {
  const target = targetFor(targetRoot, entry.source_id, entry.path);
  const stats = lstatSync(target);
  if (entry.type === "directory") {
    if (!stats.isDirectory() || octal(modeOf(stats)) !== entry.mode) throw new Error(`Restored directory mismatch: ${entry.path}`);
    return 0;
  }
  if (entry.type === "symlink") {
    const targetValue = readlinkSync(target);
    if (!stats.isSymbolicLink() || sha256(`symlink\u0000${targetValue}`) !== entry.sha256) {
      throw new Error(`Restored symlink mismatch: ${entry.path}`);
    }
    return 0;
  }
  const bytes = readFileSync(target);
  if (!stats.isFile() || sha256(bytes) !== entry.sha256 || bytes.length !== entry.size_bytes) {
    throw new Error(`Restored file mismatch: ${entry.path}`);
  }
  if (octal(modeOf(stats)) !== entry.mode) throw new Error(`Restored file mode mismatch: ${entry.path}`);
  const records = logicalRecordInfo(target, bytes)?.records ?? 0;
  if (records !== (entry.record_info?.records ?? 0)) throw new Error(`Restored record count mismatch: ${entry.path}`);
  const objectBytes = readFileSync(join(snapshotRoot, entry.object));
  if (!bytes.equals(objectBytes)) throw new Error(`Restored object bytes mismatch: ${entry.path}`);
  return records;
}

export function restoreSnapshot(snapshotRoot, options = {}) {
  const verified = verifySnapshot(snapshotRoot);
  const { root, manifest } = readSnapshot(snapshotRoot);
  const testOnly = options.testOnly === true;
  const target = testOnly
    ? mkdtempSync(join(tmpdir(), "seedrop-v2-restore-"))
    : resolve(options.target ?? "");
  if (!testOnly) {
    if (!options.target) throw new Error("restore requires --target <new-empty-path>");
    if (existsSync(target)) throw new Error(`Restore target already exists: ${target}`);
    ensurePrivateDirectory(target);
  }
  ensurePrivateDirectory(join(target, "sources"));

  try {
    const directories = manifest.entries.filter((entry) => entry.type === "directory");
    const others = manifest.entries.filter((entry) => entry.type !== "directory");
    for (const entry of directories) ensurePrivateDirectory(targetFor(target, entry.source_id, entry.path));
    for (const entry of others) {
      const destination = targetFor(target, entry.source_id, entry.path);
      ensurePrivateDirectory(dirname(destination));
      if (entry.type === "symlink") symlinkSync(entry.target, destination);
      else {
        copyFileSync(join(root, entry.object), destination);
        chmodSync(destination, Number.parseInt(entry.mode, 8));
      }
    }
    for (const entry of [...directories].sort((a, b) => b.path.length - a.path.length)) {
      chmodSync(targetFor(target, entry.source_id, entry.path), Number.parseInt(entry.mode, 8));
    }
    if (!testOnly) {
      writePrivateFile(
        join(target, "restore-map.json"),
        `${JSON.stringify({ schema_version: SCHEMA_VERSION, sources: manifest.sources }, null, 2)}\n`,
      );
    }

    let records = 0;
    for (const entry of manifest.entries) records += verifyRestoredEntry(target, root, entry);
    if (records !== manifest.counts.logical_records) throw new Error("Restored corpus logical record total mismatch");
    return {
      target: testOnly ? "isolated-temporary-copy" : target,
      files: verified.files,
      logical_records: records,
      corpus_sha256: verified.corpus_sha256,
    };
  } finally {
    if (testOnly) rmSync(target, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command = "create", first, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < [first, ...rest].length; index += 1) {
    const value = [first, ...rest][index];
    if (value === undefined) continue;
    if (value.startsWith("--")) {
      const key = value.slice(2).replaceAll("-", "_");
      const next = [first, ...rest][index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      options[key] = next;
      index += 1;
    } else positional.push(value);
  }
  return { command, positional, options };
}

function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  let result;
  if (command === "create") {
    result = createSnapshot({
      output: options.output,
      repoRoot: options.repo,
      seedropHome: options.seedrop_home,
    });
  } else if (command === "verify") {
    if (!positional[0]) throw new Error("verify requires <snapshot-directory>");
    result = verifySnapshot(positional[0]);
  } else if (command === "restore-test") {
    if (!positional[0]) throw new Error("restore-test requires <snapshot-directory>");
    result = restoreSnapshot(positional[0], { testOnly: true });
  } else if (command === "restore") {
    if (!positional[0]) throw new Error("restore requires <snapshot-directory>");
    result = restoreSnapshot(positional[0], { target: options.target });
  } else {
    throw new Error("Usage: v2-snapshot.mjs create [--output PATH] [--repo PATH] [--seedrop-home PATH] | verify SNAPSHOT | restore-test SNAPSHOT | restore SNAPSHOT --target PATH");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`v2-snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
