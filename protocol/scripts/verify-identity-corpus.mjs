import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCanonicalId,
  reconcilePrincipalCandidates,
  reconcileProjectCandidates,
} from "../dist/index.js";

const fixturePath = fileURLToPath(new URL("../fixtures/machine-identity-corpus.json", import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const live = process.argv.includes("--live");
const inputs = live ? await collectLiveInputs() : fixtureInputs();
const principals = reconcilePrincipalCandidates(inputs.principals, { mint_id: fixtureId("principal") });
const projects = reconcileProjectCandidates(inputs.projects, { mint_id: fixtureId("project") });

assert.equal(inputs.principals.length, fixture.expected.passport_count, "passport corpus changed; update the reviewed fixture");
assert.equal(inputs.projects.length, fixture.expected.project_link_count, "project-link corpus changed; update the reviewed fixture");
assert.equal(new Set(inputs.projects.map((entry) => entry.real_path ?? entry.root)).size, fixture.expected.unique_root_count);
assert.equal(principals.registry.principals.length, fixture.expected.principal_count);
assert.equal(Object.keys(principals.source_to_principal).length, inputs.principals.length);
assert.equal(projects.registry.projects.length, fixture.expected.project_count);
assert.equal(Object.keys(projects.source_to_project).length, inputs.projects.length);
assert.equal(projects.unresolved_source_refs.length, fixture.expected.unresolved_project_sources);
assert.deepEqual(principals.diagnostics, []);
assert.deepEqual(projects.diagnostics, []);

console.log(JSON.stringify({
  ok: true,
  mode: live ? "live-read-only" : "sanitized-fixture",
  passports: inputs.principals.length,
  project_links: inputs.projects.length,
  unique_roots: new Set(inputs.projects.map((entry) => entry.real_path ?? entry.root)).size,
  canonical_principals: principals.registry.principals.length,
  canonical_projects: projects.registry.projects.length,
  unresolved_project_sources: projects.unresolved_source_refs.length,
}));

function fixtureInputs() {
  return {
    principals: fixture.principals.map((entry) => ({
      source_ref: entry.source_ref,
      kind: entry.kind,
      aliases: [
        { namespace: "passport_id", value: entry.passport_id },
        { namespace: "agent_id", value: entry.agent_id },
        { namespace: "display_name", value: entry.display_name },
      ],
    })),
    projects: fixture.projects.map((entry) => ({
      source_ref: entry.source_ref,
      legacy_id: entry.legacy_id,
      root: entry.root,
      placement_kind: entry.placement_kind,
      repository_identities: entry.git_remote ? [{ kind: "git_remote", value: entry.git_remote }] : [],
    })),
  };
}

async function collectLiveInputs() {
  const idRoot = join(homedir(), ".seedrop", "id");
  const agentRoot = join(idRoot, "agents");
  const agentFiles = (await readdir(agentRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(agentRoot, entry.name));
  const passportPaths = [join(idRoot, "passport.json"), ...agentFiles].sort();
  const principals = [];
  const projects = [];

  for (const passportPath of passportPaths) {
    const passport = JSON.parse(await readFile(passportPath, "utf8"));
    assert.equal(passport.version, "1.0", `unsupported live passport ${passportPath}`);
    assert.equal(typeof passport.agent_id, "string");
    assert.equal(typeof passport.name, "string");
    const operator = passportPath === join(idRoot, "passport.json");
    principals.push({
      source_ref: operator ? "operator" : `agent:${passport.agent_id}`,
      kind: operator ? "human" : "agent",
      aliases: [
        { namespace: "passport_id", value: passport.agent_id },
        { namespace: "agent_id", value: passport.agent_id },
        { namespace: "display_name", value: passport.name },
      ],
    });
    for (const [index, project] of (passport.active_projects ?? []).entries()) {
      projects.push(await collectProject(passport.agent_id, index, project));
    }
  }
  return { principals, projects };
}

async function collectProject(agentId, index, project) {
  const root = project.root;
  const resolved = existsSync(root) ? await realpath(root) : root;
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const remote = git(root, ["remote", "get-url", "origin"]);
  let placementKind = "folder";
  if (top && resolved === top) placementKind = common === `${top}/.git` ? "repository" : "worktree";
  const repositoryIdentities = [];
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

function git(cwd, args) {
  if (!existsSync(cwd)) return null;
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function fixtureId(kind) {
  return (sourceRef) => generateCanonicalId(kind, {
    now: 1_725_000_000_000,
    entropy: createHash("sha256").update(`${kind}:${sourceRef}`).digest().subarray(0, 10),
  });
}
