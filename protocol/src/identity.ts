import { posix } from "node:path";
import { protocolError } from "./errors.js";
import { isCanonicalId, parseCanonicalId } from "./ids.js";
import type { CanonicalId } from "./ids.js";

export const IDENTITY_REGISTRY_VERSION = "1.0.0" as const;

export const PRINCIPAL_ALIAS_NAMESPACES = Object.freeze([
  "passport_id",
  "agent_id",
  "display_name",
  "client_id",
] as const);
export type PrincipalAliasNamespace = (typeof PRINCIPAL_ALIAS_NAMESPACES)[number];

export const PROJECT_ALIAS_NAMESPACES = Object.freeze([
  "legacy_project_id",
  "git_remote",
] as const);
export type ProjectAliasNamespace = (typeof PROJECT_ALIAS_NAMESPACES)[number];

export type PrincipalKind = "human" | "agent" | "service";
export type ProjectPlacementKind = "repository" | "worktree" | "folder";
export type RepositoryIdentityKind = "git_remote" | "git_common_dir";

export interface PrincipalRecord {
  principal_id: CanonicalId<"principal">;
  kind: PrincipalKind;
  source_refs: readonly string[];
}

export interface PrincipalAliasRecord {
  principal_id: CanonicalId<"principal">;
  namespace: PrincipalAliasNamespace;
  value: string;
  normalized_value: string;
  source_ref: string;
  introduced_revision: number;
  retired_revision?: number;
}

export interface PrincipalRegistry {
  registry_version: typeof IDENTITY_REGISTRY_VERSION;
  revision: number;
  principals: readonly PrincipalRecord[];
  aliases: readonly PrincipalAliasRecord[];
}

export interface PrincipalCandidate {
  source_ref: string;
  kind: PrincipalKind;
  aliases: ReadonlyArray<{ namespace: PrincipalAliasNamespace; value: string }>;
  canonical_id?: CanonicalId<"principal">;
}

export interface ProjectRecord {
  project_id: CanonicalId<"project">;
  repository_identity: string | null;
  source_refs: readonly string[];
}

export interface ProjectAliasRecord {
  project_id: CanonicalId<"project">;
  namespace: ProjectAliasNamespace;
  value: string;
  normalized_value: string;
  source_ref: string;
  introduced_revision: number;
  retired_revision?: number;
}

export interface ProjectPlacementRecord {
  project_id: CanonicalId<"project">;
  kind: ProjectPlacementKind;
  path: string;
  normalized_path: string;
  source_refs: readonly string[];
  introduced_revision: number;
  retired_revision?: number;
}

export interface ProjectRegistry {
  registry_version: typeof IDENTITY_REGISTRY_VERSION;
  revision: number;
  projects: readonly ProjectRecord[];
  aliases: readonly ProjectAliasRecord[];
  placements: readonly ProjectPlacementRecord[];
}

export interface ProjectCandidate {
  source_ref: string;
  legacy_id?: string;
  root: string;
  real_path?: string;
  placement_kind: ProjectPlacementKind;
  repository_identities?: ReadonlyArray<{ kind: RepositoryIdentityKind; value: string }>;
  canonical_id?: CanonicalId<"project">;
}

export interface IdentityDiagnostic {
  code: "ambiguous_alias" | "conflicting_canonical_id" | "conflicting_repository_identity";
  entity: "principal" | "project";
  source_refs: readonly string[];
  details: Readonly<Record<string, string | number | readonly string[] | null>>;
}

export interface PrincipalReconciliationResult {
  registry: PrincipalRegistry;
  source_to_principal: Readonly<Record<string, CanonicalId<"principal">>>;
  diagnostics: readonly IdentityDiagnostic[];
}

export interface ProjectReconciliationResult {
  registry: ProjectRegistry;
  source_to_project: Readonly<Record<string, CanonicalId<"project">>>;
  unresolved_source_refs: readonly string[];
  diagnostics: readonly IdentityDiagnostic[];
}

export interface ReconciliationOptions<K extends "principal" | "project"> {
  revision?: number;
  mint_id: (sourceRef: string) => CanonicalId<K>;
}

export interface IdentityInput {
  namespace?: PrincipalAliasNamespace | ProjectAliasNamespace | "placement_path";
  value: string;
}

export interface ResolvedCommandIdentity {
  principal_id: CanonicalId<"principal">;
  project_id?: CanonicalId<"project">;
}

export function normalizePrincipalAlias(namespace: PrincipalAliasNamespace, value: string): string {
  if (!PRINCIPAL_ALIAS_NAMESPACES.includes(namespace)) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "principal_alias_namespace" });
  }
  assertNonEmpty(value, "principal_alias");
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (normalized.length === 0) throw protocolError("seedrop.protocol.identity_registry_invalid", { field: namespace });
  return normalized;
}

export function normalizeGitRemote(value: string): string {
  assertNonEmpty(value, "git_remote");
  const trimmed = value.trim();
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
  const canonical = /^([a-z0-9.-]+)\/(.+)$/i.exec(trimmed);
  let host: string;
  let pathname: string;
  if (canonical && !trimmed.includes("://") && !trimmed.includes("@") && !trimmed.includes(":")) {
    host = canonical[1]!;
    pathname = canonical[2]!;
  } else if (scp && !trimmed.includes("://")) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (cause) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "git_remote" }, { cause });
    }
    host = url.hostname;
    pathname = url.pathname;
  }
  host = host.toLowerCase();
  pathname = pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (host.length === 0 || pathname.length === 0) throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "git_remote" });
  if (["github.com", "gitlab.com", "bitbucket.org"].includes(host)) pathname = pathname.toLowerCase();
  return `${host}/${pathname}`;
}

export function normalizePlacementPath(value: string): string {
  assertNonEmpty(value, "placement_path");
  const slash = value.trim().replaceAll("\\", "/");
  const normalized = posix.normalize(slash);
  if (!normalized.startsWith("/")) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "placement_path", reason: "absolute_required" });
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function reconcilePrincipalCandidates(
  candidates: readonly PrincipalCandidate[],
  options: ReconciliationOptions<"principal">,
): PrincipalReconciliationResult {
  const revision = validRevision(options.revision ?? 1);
  const ordered = [...candidates].sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  assertUniqueSources(ordered);
  const principals: PrincipalRecord[] = [];
  const aliases: PrincipalAliasRecord[] = [];
  const sourceMap: Record<string, CanonicalId<"principal">> = {};

  const groups = new Map<string, PrincipalCandidate[]>();
  for (const candidate of ordered) {
    assertNonEmpty(candidate.source_ref, "source_ref");
    if (candidate.canonical_id) parseCanonicalId(candidate.canonical_id, "principal");
    const key = candidate.canonical_id ? `canonical:${candidate.canonical_id}` : `source:${candidate.source_ref}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const sourceRefs = group.map((candidate) => candidate.source_ref).sort();
    const kinds = unique(group.map((candidate) => candidate.kind));
    if (kinds.length !== 1) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "principal_kind", reason: "canonical_binding_conflict" });
    }
    const principalId = group[0]!.canonical_id ?? options.mint_id(sourceRefs[0]!);
    parseCanonicalId(principalId, "principal");
    principals.push({ principal_id: principalId, kind: kinds[0]!, source_refs: Object.freeze(sourceRefs) });
    for (const candidate of group) {
      sourceMap[candidate.source_ref] = principalId;
      for (const alias of candidate.aliases) {
        aliases.push({
          principal_id: principalId,
          namespace: alias.namespace,
          value: alias.value,
          normalized_value: normalizePrincipalAlias(alias.namespace, alias.value),
          source_ref: candidate.source_ref,
          introduced_revision: revision,
        });
      }
    }
  }

  const diagnostics = aliasDiagnostics(aliases);
  const registry = freezePrincipalRegistry({ registry_version: IDENTITY_REGISTRY_VERSION, revision, principals, aliases });
  assertPrincipalRegistry(registry);
  return {
    registry,
    source_to_principal: Object.freeze(sourceMap),
    diagnostics: Object.freeze(diagnostics),
  };
}

export function reconcileProjectCandidates(
  candidates: readonly ProjectCandidate[],
  options: ReconciliationOptions<"project">,
): ProjectReconciliationResult {
  const revision = validRevision(options.revision ?? 1);
  const ordered = [...candidates].sort((left, right) => left.source_ref.localeCompare(right.source_ref));
  assertUniqueSources(ordered);
  const parents = ordered.map((_, index) => index);
  const evidenceOwner = new Map<string, number>();

  ordered.forEach((candidate, index) => {
    for (const key of projectEvidenceKeys(candidate)) {
      const existing = evidenceOwner.get(key);
      if (existing === undefined) evidenceOwner.set(key, index);
      else union(parents, index, existing);
    }
  });

  const components = new Map<number, ProjectCandidate[]>();
  ordered.forEach((candidate, index) => {
    const root = find(parents, index);
    const list = components.get(root) ?? [];
    list.push(candidate);
    components.set(root, list);
  });

  const projects: ProjectRecord[] = [];
  const aliases: ProjectAliasRecord[] = [];
  const placements: ProjectPlacementRecord[] = [];
  const sourceMap: Record<string, CanonicalId<"project">> = {};
  const unresolved: string[] = [];
  const diagnostics: IdentityDiagnostic[] = [];

  const groups = [...components.values()].sort((a, b) => a[0]!.source_ref.localeCompare(b[0]!.source_ref));
  for (const group of groups) {
    const sourceRefs = group.map((candidate) => candidate.source_ref).sort();
    const remoteKeys = unique(group.flatMap((candidate) => repositoryKeys(candidate, "git_remote")));
    const commonKeys = unique(group.flatMap((candidate) => repositoryKeys(candidate, "git_common_dir")));
    const canonicalIds = unique(group.flatMap((candidate) => candidate.canonical_id ? [candidate.canonical_id] : []));
    if (remoteKeys.length > 1 || (remoteKeys.length === 0 && canonicalIds.length === 0 && commonKeys.length > 1)) {
      diagnostics.push({
        code: "conflicting_repository_identity",
        entity: "project",
        source_refs: Object.freeze(sourceRefs),
        details: Object.freeze({ repository_identities: Object.freeze(remoteKeys.length > 0 ? remoteKeys : commonKeys) }),
      });
      unresolved.push(...sourceRefs);
      continue;
    }
    if (canonicalIds.length > 1) {
      diagnostics.push({
        code: "conflicting_canonical_id",
        entity: "project",
        source_refs: Object.freeze(sourceRefs),
        details: Object.freeze({ canonical_ids: Object.freeze(canonicalIds) }),
      });
      unresolved.push(...sourceRefs);
      continue;
    }

    const projectId = canonicalIds[0] ?? options.mint_id(sourceRefs[0]!);
    parseCanonicalId(projectId, "project");
    projects.push({
      project_id: projectId,
      repository_identity: remoteKeys[0] ?? commonKeys[0] ?? null,
      source_refs: Object.freeze(sourceRefs),
    });
    for (const sourceRef of sourceRefs) sourceMap[sourceRef] = projectId;

    for (const candidate of group) {
      if (candidate.legacy_id) {
        aliases.push({
          project_id: projectId,
          namespace: "legacy_project_id",
          value: candidate.legacy_id,
          normalized_value: normalizeProjectAlias("legacy_project_id", candidate.legacy_id),
          source_ref: candidate.source_ref,
          introduced_revision: revision,
        });
      }
      for (const remote of (candidate.repository_identities ?? []).filter((identity) => identity.kind === "git_remote")) {
        aliases.push({
          project_id: projectId,
          namespace: "git_remote",
          value: normalizeGitRemote(remote.value),
          normalized_value: normalizeGitRemote(remote.value),
          source_ref: candidate.source_ref,
          introduced_revision: revision,
        });
      }
    }

    const placementGroups = new Map<string, ProjectCandidate[]>();
    for (const candidate of group) {
      const normalizedPath = normalizePlacementPath(candidate.real_path ?? candidate.root);
      const key = `${candidate.placement_kind}\u0000${normalizedPath}`;
      const list = placementGroups.get(key) ?? [];
      list.push(candidate);
      placementGroups.set(key, list);
    }
    for (const placementGroup of placementGroups.values()) {
      const first = placementGroup[0]!;
      placements.push({
        project_id: projectId,
        kind: first.placement_kind,
        path: first.real_path ?? first.root,
        normalized_path: normalizePlacementPath(first.real_path ?? first.root),
        source_refs: Object.freeze(placementGroup.map((candidate) => candidate.source_ref).sort()),
        introduced_revision: revision,
      });
    }
  }

  const projectAliasProblems = aliasDiagnostics(aliases);
  diagnostics.push(...projectAliasProblems);
  const registry = freezeProjectRegistry({ registry_version: IDENTITY_REGISTRY_VERSION, revision, projects, aliases, placements });
  assertProjectRegistry(registry);
  return {
    registry,
    source_to_project: Object.freeze(sourceMap),
    unresolved_source_refs: Object.freeze(unresolved.sort()),
    diagnostics: Object.freeze(diagnostics),
  };
}

export function resolvePrincipalIdentity(
  registry: PrincipalRegistry,
  input: IdentityInput | string,
): CanonicalId<"principal"> {
  assertPrincipalRegistry(registry);
  const request = typeof input === "string" ? { value: input } : input;
  if (isCanonicalId(request.value, "principal")) {
    if (registry.principals.some((entry) => entry.principal_id === request.value)) return request.value as CanonicalId<"principal">;
    throw protocolError("seedrop.protocol.identity_alias_not_found", { entity: "principal", value: request.value });
  }
  const namespaces = request.namespace === undefined
    ? PRINCIPAL_ALIAS_NAMESPACES
    : PRINCIPAL_ALIAS_NAMESPACES.includes(request.namespace as PrincipalAliasNamespace)
      ? [request.namespace as PrincipalAliasNamespace]
      : [];
  const matches = unique(registry.aliases
    .filter((alias) => active(alias, registry.revision) && namespaces.includes(alias.namespace))
    .filter((alias) => alias.normalized_value === normalizePrincipalAlias(alias.namespace, request.value))
    .map((alias) => alias.principal_id));
  return oneIdentity("principal", request.value, matches);
}

export function resolveProjectIdentity(
  registry: ProjectRegistry,
  input: IdentityInput | string,
): CanonicalId<"project"> {
  assertProjectRegistry(registry);
  const request = typeof input === "string" ? { value: input } : input;
  if (isCanonicalId(request.value, "project")) {
    if (registry.projects.some((entry) => entry.project_id === request.value)) return request.value as CanonicalId<"project">;
    throw protocolError("seedrop.protocol.identity_alias_not_found", { entity: "project", value: request.value });
  }
  let matches: CanonicalId<"project">[];
  let resolvedInput = request.value;
  if (request.namespace === "placement_path") {
    const normalized = normalizePlacementPath(request.value);
    resolvedInput = normalized;
    matches = unique(registry.placements
      .filter((placement) => active(placement, registry.revision) && placement.normalized_path === normalized)
      .map((placement) => placement.project_id));
  } else {
    const namespaces = request.namespace === undefined
      ? PROJECT_ALIAS_NAMESPACES
      : PROJECT_ALIAS_NAMESPACES.includes(request.namespace as ProjectAliasNamespace)
        ? [request.namespace as ProjectAliasNamespace]
        : [];
    const normalizedByNamespace = new Map<ProjectAliasNamespace, string>();
    for (const namespace of namespaces) {
      try {
        normalizedByNamespace.set(namespace, normalizeProjectAlias(namespace, request.value));
      } catch (error) {
        if (request.namespace !== undefined) throw error;
      }
    }
    resolvedInput = request.namespace === undefined
      ? [...normalizedByNamespace.entries()].map(([namespace, value]) => `${namespace}:${value}`).join("|")
      : normalizedByNamespace.get(request.namespace as ProjectAliasNamespace) ?? request.value;
    matches = unique(registry.aliases
      .filter((alias) => active(alias, registry.revision) && namespaces.includes(alias.namespace))
      .filter((alias) => alias.normalized_value === normalizedByNamespace.get(alias.namespace))
      .map((alias) => alias.project_id));
  }
  return oneIdentity("project", resolvedInput, matches);
}

export function resolveCommandIdentities(input: {
  principal: IdentityInput | string;
  principal_registry: PrincipalRegistry;
  project?: IdentityInput | string;
  project_registry?: ProjectRegistry;
}): ResolvedCommandIdentity {
  const principalId = resolvePrincipalIdentity(input.principal_registry, input.principal);
  if (input.project === undefined) return Object.freeze({ principal_id: principalId });
  if (!input.project_registry) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_registry", reason: "required" });
  }
  return Object.freeze({
    principal_id: principalId,
    project_id: resolveProjectIdentity(input.project_registry, input.project),
  });
}

export function assertPrincipalRegistry(registry: PrincipalRegistry): void {
  assertRegistryHeader(registry);
  const ids = registry.principals.map((entry) => entry.principal_id);
  assertUnique(ids, "principal_id");
  ids.forEach((id) => parseCanonicalId(id, "principal"));
  for (const principal of registry.principals) {
    if (!["human", "agent", "service"].includes(principal.kind) || principal.source_refs.length === 0) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "principal_record" });
    }
    principal.source_refs.forEach((sourceRef) => assertNonEmpty(sourceRef, "source_ref"));
  }
  for (const alias of registry.aliases) {
    if (!PRINCIPAL_ALIAS_NAMESPACES.includes(alias.namespace)) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "principal_alias_namespace" });
    }
    if (!ids.includes(alias.principal_id)) throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "principal_alias_target" });
    if (alias.normalized_value !== normalizePrincipalAlias(alias.namespace, alias.value)) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "principal_alias_normalization" });
    }
    assertRevisionWindow(alias, registry.revision);
  }
}

export function assertProjectRegistry(registry: ProjectRegistry): void {
  assertRegistryHeader(registry);
  const ids = registry.projects.map((entry) => entry.project_id);
  assertUnique(ids, "project_id");
  ids.forEach((id) => parseCanonicalId(id, "project"));
  for (const project of registry.projects) {
    if (project.source_refs.length === 0) throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_record" });
    project.source_refs.forEach((sourceRef) => assertNonEmpty(sourceRef, "source_ref"));
  }
  for (const alias of registry.aliases) {
    if (!PROJECT_ALIAS_NAMESPACES.includes(alias.namespace)) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_alias_namespace" });
    }
    if (!ids.includes(alias.project_id)) throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_alias_target" });
    if (alias.normalized_value !== normalizeProjectAlias(alias.namespace, alias.value)) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_alias_normalization" });
    }
    assertRevisionWindow(alias, registry.revision);
  }
  for (const placement of registry.placements) {
    if (!["repository", "worktree", "folder"].includes(placement.kind)) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_placement_kind" });
    }
    if (!ids.includes(placement.project_id)) throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_placement_target" });
    if (placement.normalized_path !== normalizePlacementPath(placement.path)) {
      throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_placement_normalization" });
    }
    assertRevisionWindow(placement, registry.revision);
  }
}

function normalizeProjectAlias(namespace: ProjectAliasNamespace, value: string): string {
  if (!PROJECT_ALIAS_NAMESPACES.includes(namespace)) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_alias_namespace" });
  }
  if (namespace === "git_remote") return normalizeGitRemote(value);
  assertNonEmpty(value, "legacy_project_id");
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function projectEvidenceKeys(candidate: ProjectCandidate): string[] {
  if (candidate.canonical_id) parseCanonicalId(candidate.canonical_id, "project");
  if (!["repository", "worktree", "folder"].includes(candidate.placement_kind)) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "project_placement_kind" });
  }
  const path = normalizePlacementPath(candidate.real_path ?? candidate.root);
  return [
    `path:${path}`,
    ...(candidate.canonical_id ? [`canonical:${candidate.canonical_id}`] : []),
    ...repositoryKeys(candidate).map((key) => `repository:${key}`),
  ];
}

function repositoryKeys(candidate: ProjectCandidate, kind?: RepositoryIdentityKind): string[] {
  return unique((candidate.repository_identities ?? [])
    .filter((identity) => kind === undefined || identity.kind === kind)
    .map((identity) => {
      if (!(["git_remote", "git_common_dir"] as const).includes(identity.kind)) {
        throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "repository_identity_kind" });
      }
      return identity.kind === "git_remote"
        ? `git_remote:${normalizeGitRemote(identity.value)}`
        : `git_common_dir:${normalizePlacementPath(identity.value)}`;
    }));
}

function aliasDiagnostics(aliases: ReadonlyArray<PrincipalAliasRecord | ProjectAliasRecord>): IdentityDiagnostic[] {
  const byAlias = new Map<string, { entity: "principal" | "project"; ids: Set<string>; sourceRefs: Set<string> }>();
  for (const alias of aliases) {
    const entity = "principal_id" in alias ? "principal" : "project";
    const id = "principal_id" in alias ? alias.principal_id : alias.project_id;
    const key = `${alias.namespace}\u0000${alias.normalized_value}`;
    const current = byAlias.get(key) ?? { entity, ids: new Set(), sourceRefs: new Set() };
    current.ids.add(id);
    current.sourceRefs.add(alias.source_ref);
    byAlias.set(key, current);
  }
  return [...byAlias.entries()]
    .filter(([, entry]) => entry.ids.size > 1)
    .map(([key, entry]) => {
      const [namespace, normalizedValue] = key.split("\u0000");
      return {
        code: "ambiguous_alias" as const,
        entity: entry.entity,
        source_refs: Object.freeze([...entry.sourceRefs].sort()),
        details: Object.freeze({ namespace: namespace!, normalized_value: normalizedValue!, candidate_count: entry.ids.size }),
      };
    });
}

function oneIdentity<K extends "principal" | "project">(
  entity: K,
  value: string,
  matches: readonly CanonicalId<K>[],
): CanonicalId<K> {
  if (matches.length === 0) throw protocolError("seedrop.protocol.identity_alias_not_found", { entity, value });
  if (matches.length > 1) {
    throw protocolError("seedrop.protocol.identity_alias_ambiguous", { entity, value, candidate_count: matches.length });
  }
  return matches[0]!;
}

function active(record: { introduced_revision: number; retired_revision?: number }, revision: number): boolean {
  return record.introduced_revision <= revision && (record.retired_revision === undefined || record.retired_revision > revision);
}

function assertRevisionWindow(record: { introduced_revision: number; retired_revision?: number }, revision: number): void {
  validRevision(record.introduced_revision);
  if (record.introduced_revision > revision || (record.retired_revision !== undefined && record.retired_revision <= record.introduced_revision)) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "revision_window" });
  }
}

function assertRegistryHeader(registry: { registry_version: string; revision: number }): void {
  if (registry.registry_version !== IDENTITY_REGISTRY_VERSION) {
    throw protocolError("seedrop.protocol.version_unknown", { axis: "identity_registry", found: registry.registry_version });
  }
  validRevision(registry.revision);
}

function validRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field: "revision" });
  }
  return value;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field });
  }
}

function assertUniqueSources(candidates: ReadonlyArray<{ source_ref: string }>): void {
  assertUnique(candidates.map((candidate) => candidate.source_ref), "source_ref");
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw protocolError("seedrop.protocol.identity_registry_invalid", { field, reason: "duplicate" });
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function find(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root]!;
  while (parents[index] !== index) {
    const next = parents[index]!;
    parents[index] = root;
    index = next;
  }
  return root;
}

function union(parents: number[], left: number, right: number): void {
  const a = find(parents, left);
  const b = find(parents, right);
  if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
}

function freezePrincipalRegistry(registry: PrincipalRegistry): PrincipalRegistry {
  registry.principals.forEach(Object.freeze);
  registry.aliases.forEach(Object.freeze);
  return Object.freeze({ ...registry, principals: Object.freeze([...registry.principals]), aliases: Object.freeze([...registry.aliases]) });
}

function freezeProjectRegistry(registry: ProjectRegistry): ProjectRegistry {
  registry.projects.forEach(Object.freeze);
  registry.aliases.forEach(Object.freeze);
  registry.placements.forEach(Object.freeze);
  return Object.freeze({
    ...registry,
    projects: Object.freeze([...registry.projects]),
    aliases: Object.freeze([...registry.aliases]),
    placements: Object.freeze([...registry.placements]),
  });
}
