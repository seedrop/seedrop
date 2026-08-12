import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { PassportSchema } from "@seedrop/id";
import { canonicalJsonDigest } from "@seedrop/protocol";
import type {
  PrincipalCandidate,
  ProjectCandidate,
  ProjectTransactionDigest,
  RepositoryIdentityKind,
} from "@seedrop/protocol";
import { buildMigrationCorpus } from "./contract.js";
import type { LiveIdentityCollection, MigrationSourceSummary } from "./types.js";

export async function collectLiveIdentityCorpus(options: {
  identity_root?: string;
} = {}): Promise<LiveIdentityCollection> {
  const identityRoot = resolve(options.identity_root ?? join(homedir(), ".seedrop", "id"));
  const operatorPath = join(identityRoot, "passport.json");
  const agentRoot = join(identityRoot, "agents");
  const agentFiles = await jsonFiles(agentRoot);
  const passportPaths = [operatorPath, ...agentFiles].sort();
  const principals: PrincipalCandidate[] = [];
  const projects: ProjectCandidate[] = [];
  const sources: MigrationSourceSummary[] = [];

  for (const passportPath of passportPaths) {
    const raw = await stableRead(passportPath);
    const passport = PassportSchema.parse(JSON.parse(raw.toString("utf8")));
    const operator = passportPath === operatorPath;
    const principalSourceRef = operator ? "operator" : `agent:${passport.agent_id}`;
    const principal: PrincipalCandidate = {
      source_ref: principalSourceRef,
      kind: operator ? "human" : "agent",
      aliases: [
        { namespace: "passport_id", value: passport.agent_id },
        { namespace: "agent_id", value: passport.agent_id },
        { namespace: "display_name", value: passport.name },
      ],
    };
    principals.push(principal);
    const passportProjects: ProjectCandidate[] = [];
    for (const [index, project] of (passport.active_projects ?? []).entries()) {
      const candidate = await collectProject(passport.agent_id, index, project);
      projects.push(candidate);
      passportProjects.push(candidate);
    }
    sources.push({
      source_ref: `passport:${principalSourceRef}`,
      source_kind: "identity",
      source_digest: canonicalJsonDigest({
        raw_digest: digest(raw),
        principal,
        projects: passportProjects,
      }) as ProjectTransactionDigest,
      file_count: 1,
      byte_count: raw.byteLength,
      record_count: 1 + passportProjects.length,
    });
  }

  return deepFreeze({
    corpus: buildMigrationCorpus(sources),
    principals,
    projects,
    passport_file_count: passportPaths.length,
    project_link_count: projects.length,
  });
}

export async function digestReadOnlyTree(root: string): Promise<ProjectTransactionDigest> {
  const resolvedRoot = resolve(root);
  const entries = await walkEntries(resolvedRoot);
  const hashes = [];
  for (const entry of entries) {
    if (entry.kind === "file") {
      const raw = await stableRead(entry.path);
      hashes.push({
        path: relative(resolvedRoot, entry.path).split(sep).join("/"),
        kind: entry.kind,
        bytes: raw.byteLength,
        digest: digest(raw),
      });
    } else {
      hashes.push({
        path: relative(resolvedRoot, entry.path).split(sep).join("/"),
        kind: entry.kind,
        target: entry.target,
        digest: digest(Buffer.from(`symlink\u0000${entry.target}`)),
      });
    }
  }
  return canonicalJsonDigest(hashes) as ProjectTransactionDigest;
}

async function collectProject(
  agentId: string,
  index: number,
  project: { id: string; root: string },
): Promise<ProjectCandidate> {
  const root = project.root;
  const resolved = await pathOrOriginal(root);
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const remote = git(root, ["remote", "get-url", "origin"]);
  let placementKind: ProjectCandidate["placement_kind"] = "folder";
  if (top && resolved === top) placementKind = common === `${top}/.git` ? "repository" : "worktree";
  const repositoryIdentities: Array<{ kind: RepositoryIdentityKind; value: string }> = [];
  if (common) repositoryIdentities.push({ kind: "git_common_dir", value: common });
  if (remote) repositoryIdentities.push({ kind: "git_remote", value: remote });
  return {
    source_ref: `${agentId}:${index}`,
    legacy_id: project.id,
    root,
    real_path: resolved,
    placement_kind: placementKind,
    repository_identities: repositoryIdentities,
  };
}

async function stableRead(path: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await lstat(path, { bigint: true });
    const bytes = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs) {
      return bytes;
    }
  }
  throw new Error(`Could not obtain a stable read: ${path}`);
}

async function jsonFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".commit.json"))
      .map((entry) => join(root, entry.name))
      .sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

type TreeEntry =
  | { kind: "file"; path: string }
  | { kind: "symlink"; path: string; target: string };

async function walkEntries(root: string): Promise<TreeEntry[]> {
  const files: TreeEntry[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkEntries(path));
    else if (entry.isFile()) files.push({ kind: "file", path });
    else if (entry.isSymbolicLink()) files.push({ kind: "symlink", path, target: await readlink(path) });
    else throw new Error(`Unsupported identity-tree entry: ${path}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function pathOrOriginal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return path;
    throw error;
  }
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function digest(bytes: Uint8Array): ProjectTransactionDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
