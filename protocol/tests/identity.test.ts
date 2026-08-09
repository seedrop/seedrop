import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  assertPrincipalRegistry,
  assertProjectRegistry,
  generateCanonicalId,
  normalizeGitRemote,
  reconcilePrincipalCandidates,
  reconcileProjectCandidates,
  resolveCommandIdentities,
  resolvePrincipalIdentity,
  resolveProjectIdentity,
} from "../src/index.js";
import type {
  CanonicalId,
  PrincipalCandidate,
  ProjectCandidate,
} from "../src/index.js";

interface CorpusFixture {
  expected: {
    passport_count: number;
    project_link_count: number;
    unique_root_count: number;
    principal_count: number;
    project_count: number;
    unresolved_project_sources: number;
  };
  principals: Array<{
    source_ref: string;
    kind: "human" | "agent";
    passport_id: string;
    agent_id: string;
    display_name: string;
  }>;
  projects: Array<{
    source_ref: string;
    legacy_id: string;
    root: string;
    placement_kind: "repository" | "folder";
    git_remote?: string;
  }>;
}

const fixturePath = fileURLToPath(new URL("../fixtures/machine-identity-corpus.json", import.meta.url));
const corpus = JSON.parse(readFileSync(fixturePath, "utf8")) as CorpusFixture;

describe("Principal identity registry", () => {
  it("maps every alias permutation for one passport to one canonical Principal", () => {
    const result = reconcilePrincipalCandidates([principal("passport-a", "codex", "Codex")], {
      mint_id: fixtureId("principal"),
    });
    assertPrincipalRegistry(result.registry);
    const expected = result.registry.principals[0]!.principal_id;
    expect(resolvePrincipalIdentity(result.registry, { namespace: "passport_id", value: "CODEX" })).toBe(expected);
    expect(resolvePrincipalIdentity(result.registry, { namespace: "agent_id", value: " codex " })).toBe(expected);
    expect(resolvePrincipalIdentity(result.registry, { namespace: "display_name", value: "Codex" })).toBe(expected);
    expect(resolvePrincipalIdentity(result.registry, "codex")).toBe(expected);
  });

  it("preserves collisions as diagnostics and default-denies ambiguous aliases", () => {
    const result = reconcilePrincipalCandidates([
      principal("passport-a", "alpha", "Shared"),
      principal("passport-b", "beta", "shared"),
    ], { mint_id: fixtureId("principal") });
    expect(result.registry.principals).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "ambiguous_alias", entity: "principal" }));
    expectCode(() => resolvePrincipalIdentity(result.registry, "shared"), "seedrop.protocol.identity_alias_ambiguous");
    expect(resolvePrincipalIdentity(result.registry, "alpha")).toBe(result.source_to_principal["passport-a"]);
  });

  it("merges sources only when an existing canonical binding explicitly says they are one Principal", () => {
    const canonicalId = fixtureId("principal")("bound");
    const first = principal("passport-a", "alpha", "Alpha");
    const second = principal("passport-copy", "alpha-copy", "Alpha");
    const result = reconcilePrincipalCandidates([
      { ...first, canonical_id: canonicalId },
      { ...second, canonical_id: canonicalId },
    ], { mint_id: fixtureId("principal") });
    expect(result.registry.principals).toEqual([
      expect.objectContaining({ principal_id: canonicalId, source_refs: ["passport-a", "passport-copy"] }),
    ]);
    expect(resolvePrincipalIdentity(result.registry, "alpha-copy")).toBe(canonicalId);
  });

  it("honors revision-windowed alias retirement without erasing history", () => {
    const result = reconcilePrincipalCandidates([principal("passport-a", "alpha", "Alpha Display")], {
      revision: 1,
      mint_id: fixtureId("principal"),
    });
    const registry = {
      ...result.registry,
      revision: 2,
      aliases: result.registry.aliases.map((alias) => alias.namespace === "display_name"
        ? { ...alias, retired_revision: 2 }
        : alias),
    };
    assertPrincipalRegistry(registry);
    expectCode(() => resolvePrincipalIdentity(registry, "Alpha Display"), "seedrop.protocol.identity_alias_not_found");
    expect(resolvePrincipalIdentity(registry, "alpha")).toBe(result.source_to_principal["passport-a"]);
    expect(registry.aliases.find((alias) => alias.namespace === "display_name")?.retired_revision).toBe(2);
  });

  it("resolves command identities completely before a caller can authorize or persist", () => {
    const principals = reconcilePrincipalCandidates([principal("passport-a", "alpha", "Alpha")], {
      mint_id: fixtureId("principal"),
    });
    const projects = reconcileProjectCandidates([project("link-a", "seedrop", "/repos/seedrop")], {
      mint_id: fixtureId("project"),
    });
    expect(resolveCommandIdentities({
      principal: "alpha",
      principal_registry: principals.registry,
      project: { namespace: "placement_path", value: "/repos/seedrop" },
      project_registry: projects.registry,
    })).toEqual({
      principal_id: principals.source_to_principal["passport-a"],
      project_id: projects.source_to_project["link-a"],
    });
  });
});

describe("Project identity registry", () => {
  it("lets repository identity join clones while retaining explicit placements", () => {
    const result = reconcileProjectCandidates([
      project("link-a", "outer", "/repos/outer", "git@github.com:Org/Outer.git"),
      project("link-b", "outer-v2", "/worktrees/outer-v2", "https://github.com/org/outer.git", "worktree"),
    ], { mint_id: fixtureId("project") });
    assertProjectRegistry(result.registry);
    expect(result.registry.projects).toHaveLength(1);
    expect(result.registry.placements).toEqual([
      expect.objectContaining({ kind: "repository", normalized_path: "/repos/outer" }),
      expect.objectContaining({ kind: "worktree", normalized_path: "/worktrees/outer-v2" }),
    ]);
    expect(resolveProjectIdentity(result.registry, { namespace: "git_remote", value: "ssh://git@github.com/org/outer.git" }))
      .toBe(result.registry.projects[0]!.project_id);
  });

  it("lets an explicit canonical Project binding join placements while still checking repository conflict", () => {
    const canonicalId = fixtureId("project")("bound-project");
    const result = reconcileProjectCandidates([
      { ...project("link-a", "alpha", "/repos/alpha"), canonical_id: canonicalId },
      { ...project("link-b", "alpha-copy", "/repos/alpha-copy"), canonical_id: canonicalId },
    ], { mint_id: fixtureId("project") });
    expect(result.registry.projects).toEqual([
      expect.objectContaining({ project_id: canonicalId, source_refs: ["link-a", "link-b"] }),
    ]);
    expect(result.registry.placements).toHaveLength(2);
  });

  it("does not merge by legacy project name alone", () => {
    const result = reconcileProjectCandidates([
      project("link-a", "shared", "/repos/a"),
      project("link-b", "SHARED", "/repos/b"),
    ], { mint_id: fixtureId("project") });
    expect(result.registry.projects).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "ambiguous_alias", entity: "project" }));
    expectCode(() => resolveProjectIdentity(result.registry, "shared"), "seedrop.protocol.identity_alias_ambiguous");
  });

  it("quarantines a shared placement with conflicting repo identities instead of silently merging", () => {
    const result = reconcileProjectCandidates([
      project("link-a", "project-a", "/repos/shared", "git@github.com:org/a.git"),
      project("link-b", "project-b", "/repos/shared", "git@github.com:org/b.git"),
    ], { mint_id: fixtureId("project") });
    expect(result.registry.projects).toHaveLength(0);
    expect(result.unresolved_source_refs).toEqual(["link-a", "link-b"]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "conflicting_repository_identity" }));
  });

  it("normalizes common Git transport spellings without leaking credentials", () => {
    expect(normalizeGitRemote("git@github.com:Seedrop/Seedrop.git")).toBe("github.com/seedrop/seedrop");
    expect(normalizeGitRemote("https://token@github.com/seedrop/seedrop.git")).toBe("github.com/seedrop/seedrop");
    const result = reconcileProjectCandidates([
      project("link-a", "seedrop", "/repos/seedrop", "https://token@github.com/seedrop/seedrop.git"),
    ], { mint_id: fixtureId("project") });
    expect(result.registry.aliases.find((alias) => alias.namespace === "git_remote")?.value)
      .toBe("github.com/seedrop/seedrop");
    expect(JSON.stringify(result.registry)).not.toContain("token");
  });

  it("resolves an unnamespaced legacy alias even when the registry also contains Git remotes", () => {
    const result = reconcileProjectCandidates([
      project("link-a", "seedrop", "/repos/seedrop", "git@github.com:seedrop/seedrop.git"),
    ], { mint_id: fixtureId("project") });
    expect(resolveProjectIdentity(result.registry, "seedrop")).toBe(result.source_to_project["link-a"]);
  });

  it("honors revision-windowed placement retirement", () => {
    const result = reconcileProjectCandidates([project("link-a", "seedrop", "/repos/seedrop")], {
      revision: 1,
      mint_id: fixtureId("project"),
    });
    const registry = {
      ...result.registry,
      revision: 2,
      placements: result.registry.placements.map((placement) => ({ ...placement, retired_revision: 2 })),
    };
    assertProjectRegistry(registry);
    expectCode(
      () => resolveProjectIdentity(registry, { namespace: "placement_path", value: "/repos/seedrop" }),
      "seedrop.protocol.identity_alias_not_found",
    );
    expect(registry.placements[0]?.retired_revision).toBe(2);
  });
});

describe("sanitized nine-passport machine corpus", () => {
  it("reconciles every passport and project link with the frozen counts and no silent merge", () => {
    const principalCandidates: PrincipalCandidate[] = corpus.principals.map((entry) => ({
      source_ref: entry.source_ref,
      kind: entry.kind,
      aliases: [
        { namespace: "passport_id", value: entry.passport_id },
        { namespace: "agent_id", value: entry.agent_id },
        { namespace: "display_name", value: entry.display_name },
      ],
    }));
    const projectCandidates: ProjectCandidate[] = corpus.projects.map((entry) => ({
      source_ref: entry.source_ref,
      legacy_id: entry.legacy_id,
      root: entry.root,
      placement_kind: entry.placement_kind,
      repository_identities: entry.git_remote ? [{ kind: "git_remote", value: entry.git_remote }] : [],
    }));
    const principals = reconcilePrincipalCandidates(principalCandidates, { mint_id: fixtureId("principal") });
    const projects = reconcileProjectCandidates(projectCandidates, { mint_id: fixtureId("project") });

    expect(corpus.principals).toHaveLength(corpus.expected.passport_count);
    expect(corpus.projects).toHaveLength(corpus.expected.project_link_count);
    expect(new Set(corpus.projects.map((entry) => entry.root))).toHaveLength(corpus.expected.unique_root_count);
    expect(principals.registry.principals).toHaveLength(corpus.expected.principal_count);
    expect(Object.keys(principals.source_to_principal)).toHaveLength(corpus.principals.length);
    expect(projects.registry.projects).toHaveLength(corpus.expected.project_count);
    expect(Object.keys(projects.source_to_project)).toHaveLength(corpus.projects.length);
    expect(projects.unresolved_source_refs).toHaveLength(corpus.expected.unresolved_project_sources);
    expect(projects.diagnostics).toHaveLength(0);

    const outer = resolveProjectIdentity(projects.registry, { namespace: "placement_path", value: "/corpus/home/Projects/outer" });
    const outerV2 = resolveProjectIdentity(projects.registry, { namespace: "placement_path", value: "/corpus/home/Projects/outer_v2" });
    expect(outer).toBe(outerV2);
    expect(resolveProjectIdentity(projects.registry, { namespace: "legacy_project_id", value: "ROOST" }))
      .toBe(resolveProjectIdentity(projects.registry, { namespace: "placement_path", value: "/corpus/home/Projects/Roost" }));
  });
});

function principal(sourceRef: string, agentId: string, displayName: string): PrincipalCandidate {
  return {
    source_ref: sourceRef,
    kind: "agent",
    aliases: [
      { namespace: "passport_id", value: agentId },
      { namespace: "agent_id", value: agentId },
      { namespace: "display_name", value: displayName },
    ],
  };
}

function project(
  sourceRef: string,
  legacyId: string,
  root: string,
  remote?: string,
  placementKind: "repository" | "worktree" | "folder" = "repository",
): ProjectCandidate {
  return {
    source_ref: sourceRef,
    legacy_id: legacyId,
    root,
    placement_kind: placementKind,
    repository_identities: remote ? [{ kind: "git_remote", value: remote }] : [],
  };
}

function fixtureId<K extends "principal" | "project">(kind: K): (sourceRef: string) => CanonicalId<K> {
  return (sourceRef) => generateCanonicalId(kind, {
    now: 1_725_000_000_000,
    entropy: createHash("sha256").update(`${kind}:${sourceRef}`).digest().subarray(0, 10),
  });
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected ProtocolError");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}
