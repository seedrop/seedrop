import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type RepositorySourceKind = "git" | "artifact" | "schema" | "policy";

export interface RepositorySourceSpec { source_id: string; kind: RepositorySourceKind; path: string }
export interface RepositoryFileStamp { path: string; size: number; mtime_ms: number; digest: string }
export interface RepositoryObservationIndex { version: 1; files: Readonly<Record<string, RepositoryFileStamp>> }
export interface RepositorySourceObservation { source_id: string; kind: RepositorySourceKind; digest: string; file_count: number }
export interface RepositoryObservation {
  mode: "incremental" | "full_fallback";
  fallback_reason: "index_missing" | "index_invalid" | null;
  scanned_files: number;
  reused_files: number;
  sources: readonly RepositorySourceObservation[];
  index: RepositoryObservationIndex;
}

export function planIncrementalObservation(
  files: readonly Omit<RepositoryFileStamp, "digest">[], previous?: RepositoryObservationIndex,
): { hash: readonly string[]; reuse: readonly RepositoryFileStamp[] } {
  const hash: string[] = [], reuse: RepositoryFileStamp[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const prior = previous?.files[file.path];
    if (prior && prior.size === file.size && prior.mtime_ms === file.mtime_ms) reuse.push(prior);
    else hash.push(file.path);
  }
  return Object.freeze({ hash: Object.freeze(hash), reuse: Object.freeze(reuse) });
}

export async function observeRepositorySources(options: {
  root: string; sources: readonly RepositorySourceSpec[]; previous?: unknown; max_files?: number;
}): Promise<RepositoryObservation> {
  const root = path.resolve(options.root), max = options.max_files ?? 50_000;
  const previous = validIndex(options.previous) ? options.previous : undefined;
  const fallbackReason = previous ? null : options.previous === undefined ? "index_missing" : "index_invalid";
  const inventory: Array<Omit<RepositoryFileStamp, "digest"> & { source: RepositorySourceSpec }> = [];
  for (const source of [...options.sources].sort((a, b) => a.source_id.localeCompare(b.source_id))) {
    const absolute = inside(root, source.path);
    for (const file of await filesUnder(absolute)) {
      const info = await stat(file);
      inventory.push({ path: path.relative(root, file).split(path.sep).join("/"), size: info.size, mtime_ms: info.mtimeMs, source });
      if (inventory.length > max) throw new Error(`Repository observation exceeded max_files=${max}.`);
    }
  }
  const plan = planIncrementalObservation(inventory, previous);
  const byPath = new Map(plan.reuse.map((item) => [item.path, item]));
  const metadataByPath = new Map(inventory.map((item) => [item.path, item]));
  for (const relative of plan.hash) {
    const meta = metadataByPath.get(relative)!;
    const bytes = await readFile(inside(root, relative));
    byPath.set(relative, { path: relative, size: meta.size, mtime_ms: meta.mtime_ms, digest: digest(bytes) });
  }
  const pathsBySource = new Map<string, string[]>();
  for (const item of inventory) (pathsBySource.get(item.source.source_id) ?? pathsBySource.set(item.source.source_id, []).get(item.source.source_id)!).push(item.path);
  const observations = options.sources.map((source) => {
    const members = (pathsBySource.get(source.source_id) ?? []).map((name) => byPath.get(name)!)
      .sort((a, b) => a.path.localeCompare(b.path));
    return Object.freeze({ source_id: source.source_id, kind: source.kind,
      digest: digest(JSON.stringify(members.map(({ path: name, digest }) => [name, digest]))), file_count: members.length });
  }).sort((a, b) => a.source_id.localeCompare(b.source_id));
  return deepFreeze({ mode: previous ? "incremental" : "full_fallback", fallback_reason: fallbackReason,
    scanned_files: plan.hash.length, reused_files: plan.reuse.length, sources: observations,
    index: { version: 1, files: Object.fromEntries([...byPath].sort(([a], [b]) => a.localeCompare(b))) } });
}

function validIndex(value: unknown): value is RepositoryObservationIndex {
  return !!value && typeof value === "object" && (value as RepositoryObservationIndex).version === 1
    && !!(value as RepositoryObservationIndex).files && typeof (value as RepositoryObservationIndex).files === "object";
}
async function filesUnder(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return [target];
  if (!info.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => filesUnder(path.join(target, entry.name))));
  return nested.flat();
}
function inside(root: string, relative: string): string {
  const result = path.resolve(root, relative);
  if (result !== root && !result.startsWith(`${root}${path.sep}`)) throw new Error(`Source escapes repository root: ${relative}`);
  return result;
}
function digest(value: string | Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
