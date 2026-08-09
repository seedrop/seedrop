import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface RootMigrationEntry {
  relative_path: string;
  bytes: number;
  sha256: string;
  mode: number;
  canonical_preexisting: boolean;
}

export interface RootMigrationDirectory {
  relative_path: string;
  mode: number;
}

export interface RootMigrationReconciliation {
  file_count: number;
  byte_count: number;
  digest: string;
}

export interface RootMigrationManifest {
  schema_version: "1.0";
  migration_id: string;
  status: "preview" | "prepared" | "applied" | "rolled_back";
  canonical_root: string;
  legacy_root: string;
  backup_root: string;
  manifest_path: string;
  created_at: string;
  updated_at: string;
  entries: RootMigrationEntry[];
  directories: RootMigrationDirectory[];
  source: RootMigrationReconciliation;
  canonical: RootMigrationReconciliation | null;
  backup: RootMigrationReconciliation | null;
}

export interface RootMigrationOptions {
  canonicalRoot: string;
  legacyRoot?: string;
  backupBase?: string;
  migrationId?: string;
}

export async function previewRootMigration(options: RootMigrationOptions): Promise<RootMigrationManifest> {
  const paths = resolveMigrationPaths(options);
  const source = await inventory(paths.legacyRoot);
  if (source.entries.length === 0) {
    throw new Error(`Legacy Space root contains no durable files: ${paths.legacyRoot}`);
  }

  const entries: RootMigrationEntry[] = [];
  for (const entry of source.entries) {
    const destination = safeJoin(paths.canonicalRoot, entry.relative_path);
    const existing = await fileRecord(destination, entry.relative_path);
    if (existing && (existing.bytes !== entry.bytes || existing.sha256 !== entry.sha256)) {
      throw new Error(`Canonical Space root conflicts at ${entry.relative_path}; migration refused.`);
    }
    entries.push({ ...entry, canonical_preexisting: existing !== null });
  }

  const now = new Date().toISOString();
  return {
    schema_version: "1.0",
    migration_id: paths.migrationId,
    status: "preview",
    canonical_root: paths.canonicalRoot,
    legacy_root: paths.legacyRoot,
    backup_root: paths.backupRoot,
    manifest_path: path.join(paths.backupRoot, "manifest.json"),
    created_at: now,
    updated_at: now,
    entries,
    directories: source.directories,
    source: reconcile(entries),
    canonical: null,
    backup: null,
  };
}

export async function applyRootMigration(options: RootMigrationOptions): Promise<RootMigrationManifest> {
  const manifest = await previewRootMigration(options);
  await assertMissing(manifest.backup_root, "Migration backup already exists");
  await mkdir(manifest.backup_root, { recursive: true, mode: 0o700 });

  try {
    for (const directory of manifest.directories) {
      await mkdir(safeJoin(manifest.backup_root, directory.relative_path), { recursive: true, mode: directory.mode });
      await mkdir(safeJoin(manifest.canonical_root, directory.relative_path), { recursive: true, mode: directory.mode });
    }
    for (const entry of manifest.entries) {
      const source = safeJoin(manifest.legacy_root, entry.relative_path);
      const backup = safeJoin(manifest.backup_root, entry.relative_path);
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(source, backup, constants.COPYFILE_EXCL);
      await chmod(backup, entry.mode);

      if (!entry.canonical_preexisting) {
        const destination = safeJoin(manifest.canonical_root, entry.relative_path);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        await chmod(destination, entry.mode);
      }
    }

    manifest.status = "prepared";
    manifest.canonical = await reconcileExpected(manifest.canonical_root, manifest.entries);
    manifest.backup = await reconcileExpected(manifest.backup_root, manifest.entries);
    assertReconciled(manifest.source, manifest.canonical, "canonical root");
    assertReconciled(manifest.source, manifest.backup, "backup");
    await writeManifest(manifest);

    await makeLegacyReadOnly(manifest);
    const legacy = await reconcileExpected(manifest.legacy_root, manifest.entries);
    assertReconciled(manifest.source, legacy, "read-only legacy root");
    manifest.status = "applied";
    manifest.updated_at = new Date().toISOString();
    await writeManifest(manifest);
    return manifest;
  } catch (error) {
    await restoreLegacyModes(manifest).catch(() => undefined);
    await removeCreatedCanonicalFiles(manifest).catch(() => undefined);
    await rm(manifest.backup_root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function rollbackRootMigration(manifestPath: string): Promise<RootMigrationManifest> {
  const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8")) as RootMigrationManifest;
  validateManifest(manifest);
  if (manifest.status === "rolled_back") return manifest;

  const backup = await reconcileExpected(manifest.backup_root, manifest.entries);
  assertReconciled(manifest.source, backup, "backup");
  const canonical = await reconcileExpected(manifest.canonical_root, manifest.entries);
  assertReconciled(
    manifest.source,
    canonical,
    "canonical root; it changed after migration, so automatic rollback would lose data",
  );
  await restoreLegacyModes(manifest);
  const legacy = await reconcileExpected(manifest.legacy_root, manifest.entries);
  assertReconciled(manifest.source, legacy, "legacy root");
  await removeCreatedCanonicalFiles(manifest);

  manifest.status = "rolled_back";
  manifest.updated_at = new Date().toISOString();
  manifest.backup = backup;
  manifest.canonical = null;
  await writeManifest(manifest);
  return manifest;
}

function resolveMigrationPaths(options: RootMigrationOptions): {
  canonicalRoot: string;
  legacyRoot: string;
  backupRoot: string;
  migrationId: string;
} {
  const canonicalRoot = path.resolve(options.canonicalRoot);
  const legacyRoot = path.resolve(options.legacyRoot ?? path.join(canonicalRoot, ".seedrop", "space"));
  const relativeLegacy = path.relative(canonicalRoot, legacyRoot);
  if (!relativeLegacy || relativeLegacy.startsWith("..") || path.isAbsolute(relativeLegacy)) {
    throw new Error("Legacy Space root must be a nested directory inside the canonical root.");
  }
  const migrationId = options.migrationId ?? `${compactTimestamp()}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(migrationId)) throw new Error("Invalid migration id.");
  const backupBase = path.resolve(options.backupBase ?? path.join(path.dirname(canonicalRoot), "migrations", "space-root"));
  const backupRoot = path.join(backupBase, migrationId);
  const relativeBackup = path.relative(canonicalRoot, backupRoot);
  if (!relativeBackup.startsWith("..") && !path.isAbsolute(relativeBackup)) {
    throw new Error("Migration backup must be outside the canonical Space root.");
  }
  return { canonicalRoot, legacyRoot, backupRoot, migrationId };
}

async function inventory(root: string): Promise<{ entries: Omit<RootMigrationEntry, "canonical_preexisting">[]; directories: RootMigrationDirectory[] }> {
  const rootStats = await stat(root).catch(() => null);
  if (!rootStats?.isDirectory()) throw new Error(`Space root is not a directory: ${root}`);
  const entries: Omit<RootMigrationEntry, "canonical_preexisting">[] = [];
  const directories: RootMigrationDirectory[] = [{ relative_path: ".", mode: rootStats.mode & 0o777 }];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name;
      const absolutePath = safeJoin(root, relativePath);
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) throw new Error(`Symlinks are not allowed in a Space migration: ${relativePath}`);
      if (details.isDirectory()) {
        directories.push({ relative_path: relativePath, mode: details.mode & 0o777 });
        await walk(absolutePath, relativePath);
      } else if (details.isFile()) {
        entries.push({
          relative_path: relativePath,
          bytes: details.size,
          sha256: await sha256File(absolutePath),
          mode: details.mode & 0o777,
        });
      } else {
        throw new Error(`Unsupported filesystem entry in Space migration: ${relativePath}`);
      }
    }
  }

  await walk(root, "");
  return { entries, directories };
}

async function reconcileExpected(root: string, entries: readonly RootMigrationEntry[]): Promise<RootMigrationReconciliation> {
  const records: RootMigrationEntry[] = [];
  for (const expected of entries) {
    const actual = await fileRecord(safeJoin(root, expected.relative_path), expected.relative_path);
    if (!actual) throw new Error(`Reconciliation failed: missing ${expected.relative_path} under ${root}`);
    records.push({ ...actual, canonical_preexisting: expected.canonical_preexisting });
  }
  return reconcile(records);
}

function reconcile(entries: readonly Pick<RootMigrationEntry, "relative_path" | "bytes" | "sha256">[]): RootMigrationReconciliation {
  const ordered = [...entries].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const digest = createHash("sha256");
  let byteCount = 0;
  for (const entry of ordered) {
    byteCount += entry.bytes;
    digest.update(`${entry.relative_path}\0${entry.bytes}\0${entry.sha256}\n`);
  }
  return { file_count: ordered.length, byte_count: byteCount, digest: digest.digest("hex") };
}

async function fileRecord(filePath: string, relativePath: string): Promise<Omit<RootMigrationEntry, "canonical_preexisting"> | null> {
  const details = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!details) return null;
  if (!details.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
  return {
    relative_path: relativePath,
    bytes: details.size,
    sha256: await sha256File(filePath),
    mode: details.mode & 0o777,
  };
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function assertReconciled(expected: RootMigrationReconciliation, actual: RootMigrationReconciliation, label: string): void {
  if (
    expected.file_count !== actual.file_count ||
    expected.byte_count !== actual.byte_count ||
    expected.digest !== actual.digest
  ) {
    throw new Error(`Migration reconciliation failed for ${label}.`);
  }
}

async function makeLegacyReadOnly(manifest: RootMigrationManifest): Promise<void> {
  for (const entry of manifest.entries) {
    await chmod(safeJoin(manifest.legacy_root, entry.relative_path), entry.mode & ~0o222);
  }
  for (const directory of [...manifest.directories].sort((a, b) => b.relative_path.length - a.relative_path.length)) {
    await chmod(safeJoin(manifest.legacy_root, directory.relative_path), directory.mode & ~0o222);
  }
}

async function restoreLegacyModes(manifest: RootMigrationManifest): Promise<void> {
  for (const directory of [...manifest.directories].sort((a, b) => a.relative_path.length - b.relative_path.length)) {
    await chmod(safeJoin(manifest.legacy_root, directory.relative_path), directory.mode);
  }
  for (const entry of manifest.entries) {
    await chmod(safeJoin(manifest.legacy_root, entry.relative_path), entry.mode);
  }
}

async function removeCreatedCanonicalFiles(manifest: RootMigrationManifest): Promise<void> {
  for (const entry of manifest.entries) {
    if (!entry.canonical_preexisting) {
      await rm(safeJoin(manifest.canonical_root, entry.relative_path), { force: true });
    }
  }
  for (const directory of [...manifest.directories].sort((a, b) => b.relative_path.length - a.relative_path.length)) {
    if (directory.relative_path === ".") continue;
    await rmdir(safeJoin(manifest.canonical_root, directory.relative_path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    });
  }
}

async function writeManifest(manifest: RootMigrationManifest): Promise<void> {
  await mkdir(manifest.backup_root, { recursive: true, mode: 0o700 });
  await writeFile(manifest.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function validateManifest(manifest: RootMigrationManifest): void {
  if (manifest.schema_version !== "1.0" || !Array.isArray(manifest.entries) || !Array.isArray(manifest.directories)) {
    throw new Error("Invalid Space root migration manifest.");
  }
  if (!path.isAbsolute(manifest.canonical_root) || !path.isAbsolute(manifest.legacy_root) || !path.isAbsolute(manifest.backup_root)) {
    throw new Error("Migration manifest paths must be absolute.");
  }
}

async function assertMissing(target: string, message: string): Promise<void> {
  try {
    await access(target);
    throw new Error(`${message}: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function safeJoin(root: string, relativePath: string): string {
  const result = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), result);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe migration path: ${relativePath}`);
  return result;
}

function compactTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
