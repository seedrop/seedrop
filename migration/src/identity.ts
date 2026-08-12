import { createHash } from "node:crypto";
import {
  assertPrincipalRegistry,
  assertProjectRegistry,
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
  generateCanonicalId,
  reconcilePrincipalCandidates,
  reconcileProjectCandidates,
} from "@seedrop/protocol";
import type {
  CanonicalId,
  PrincipalCandidate,
  ProjectCandidate,
  ProjectTransactionDigest,
} from "@seedrop/protocol";
import { MigrationContractError, assertMigrationCorpus } from "./contract.js";
import { IDENTITY_IMPORT_VERSION } from "./types.js";
import type {
  IdentityImportResult,
  MigrationCorpus,
} from "./types.js";

const ID_EPOCH_MS = 1_725_000_000_000;

export function importIdentityRegistries(input: {
  corpus: MigrationCorpus;
  principals: readonly PrincipalCandidate[];
  projects: readonly ProjectCandidate[];
}): IdentityImportResult {
  assertMigrationCorpus(input.corpus);
  const principalRefs = sourceRefs(input.principals, "principals");
  const projectRefs = sourceRefs(input.projects, "projects");
  const expectedRecords = principalRefs.length + projectRefs.length;
  if (input.corpus.counts.records !== expectedRecords) {
    invalid("corpus.counts.records", "identity_source_count_mismatch", {
      expected_records: expectedRecords,
      observed_records: input.corpus.counts.records,
    });
  }

  const principals = reconcilePrincipalCandidates(input.principals, {
    mint_id: deterministicIdentityId("principal"),
  });
  const projects = reconcileProjectCandidates(input.projects, {
    mint_id: deterministicIdentityId("project"),
  });
  assertPrincipalRegistry(principals.registry);
  assertProjectRegistry(projects.registry);

  const mappedPrincipalRefs = Object.keys(principals.source_to_principal).sort();
  exactSources(principalRefs, mappedPrincipalRefs, "principal_sources");
  const mappedProjectRefs = Object.keys(projects.source_to_project).sort();
  const unresolvedProjectRefs = [...projects.unresolved_source_refs].sort();
  exactSources(projectRefs, [...mappedProjectRefs, ...unresolvedProjectRefs].sort(), "project_sources");
  disjoint(mappedProjectRefs, unresolvedProjectRefs, "project_sources");

  const sourceMapping = {
    principal: principals.source_to_principal,
    project: projects.source_to_project,
    unresolved_project_sources: unresolvedProjectRefs,
  };
  const receipt = deepFreeze({
    import_version: IDENTITY_IMPORT_VERSION,
    corpus_digest: input.corpus.corpus_digest,
    principal_registry_digest: canonicalJsonDigest(principals.registry) as ProjectTransactionDigest,
    project_registry_digest: canonicalJsonDigest(projects.registry) as ProjectTransactionDigest,
    source_mapping_digest: canonicalJsonDigest(sourceMapping) as ProjectTransactionDigest,
    counts: {
      principal_sources: principalRefs.length,
      project_sources: projectRefs.length,
      canonical_principals: principals.registry.principals.length,
      canonical_projects: projects.registry.projects.length,
      unique_project_placements: projects.registry.placements.length,
      unresolved_project_sources: unresolvedProjectRefs.length,
    },
    unresolved_project_sources: unresolvedProjectRefs,
    principal_diagnostics: principals.diagnostics,
    project_diagnostics: projects.diagnostics,
  });
  const result = deepFreeze({
    receipt,
    principal_registry: principals.registry,
    project_registry: projects.registry,
    source_to_principal: principals.source_to_principal,
    source_to_project: projects.source_to_project,
  });
  assertIdentityImportResult(result);
  return result;
}

export function identityImportBytes(result: IdentityImportResult): Uint8Array {
  assertIdentityImportResult(result);
  return canonicalJsonBytes(result);
}

export function identityImportDigest(result: IdentityImportResult): ProjectTransactionDigest {
  assertIdentityImportResult(result);
  return canonicalJsonDigest(result) as ProjectTransactionDigest;
}

export function assertIdentityImportResult(result: IdentityImportResult): void {
  exact(result, [
    "receipt", "principal_registry", "project_registry", "source_to_principal", "source_to_project",
  ], "result");
  exact(result.receipt, [
    "import_version", "corpus_digest", "principal_registry_digest", "project_registry_digest",
    "source_mapping_digest", "counts", "unresolved_project_sources", "principal_diagnostics", "project_diagnostics",
  ], "receipt");
  exact(result.receipt.counts, [
    "principal_sources", "project_sources", "canonical_principals", "canonical_projects",
    "unique_project_placements", "unresolved_project_sources",
  ], "receipt.counts");
  if (result.receipt.import_version !== IDENTITY_IMPORT_VERSION) invalid("import_version", "unsupported");
  sha256(result.receipt.corpus_digest, "corpus_digest");
  sha256(result.receipt.principal_registry_digest, "principal_registry_digest");
  sha256(result.receipt.project_registry_digest, "project_registry_digest");
  sha256(result.receipt.source_mapping_digest, "source_mapping_digest");
  assertPrincipalRegistry(result.principal_registry);
  assertProjectRegistry(result.project_registry);
  if (result.receipt.principal_registry_digest !== canonicalJsonDigest(result.principal_registry)) {
    invalid("principal_registry_digest", "mismatch");
  }
  if (result.receipt.project_registry_digest !== canonicalJsonDigest(result.project_registry)) {
    invalid("project_registry_digest", "mismatch");
  }
  const unresolved = [...result.receipt.unresolved_project_sources].sort();
  if (canonicalJson(unresolved) !== canonicalJson(result.receipt.unresolved_project_sources)
    || new Set(unresolved).size !== unresolved.length) {
    invalid("unresolved_project_sources", "unique_canonical_order_required");
  }
  const principalRegistrySources = result.principal_registry.principals.flatMap((record) => record.source_refs).sort();
  const projectRegistrySources = result.project_registry.projects.flatMap((record) => record.source_refs).sort();
  exactSources(principalRegistrySources, Object.keys(result.source_to_principal).sort(), "source_to_principal");
  exactSources(projectRegistrySources, Object.keys(result.source_to_project).sort(), "source_to_project");
  const principalIds = new Set(result.principal_registry.principals.map((record) => record.principal_id));
  const projectIds = new Set(result.project_registry.projects.map((record) => record.project_id));
  if (Object.values(result.source_to_principal).some((id) => !principalIds.has(id))) {
    invalid("source_to_principal", "unregistered_target");
  }
  if (Object.values(result.source_to_project).some((id) => !projectIds.has(id))) {
    invalid("source_to_project", "unregistered_target");
  }
  disjoint(Object.keys(result.source_to_project), unresolved, "project_sources");
  const mapping = {
    principal: result.source_to_principal,
    project: result.source_to_project,
    unresolved_project_sources: unresolved,
  };
  if (result.receipt.source_mapping_digest !== canonicalJsonDigest(mapping)) {
    invalid("source_mapping_digest", "mismatch");
  }
  const counts = result.receipt.counts;
  for (const [field, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`counts.${field}`, "nonnegative_safe_integer_required");
  }
  if (counts.principal_sources !== Object.keys(result.source_to_principal).length
    || counts.project_sources !== Object.keys(result.source_to_project).length + counts.unresolved_project_sources
    || counts.canonical_principals !== result.principal_registry.principals.length
    || counts.canonical_projects !== result.project_registry.projects.length
    || counts.unique_project_placements !== result.project_registry.placements.length
    || counts.unresolved_project_sources !== unresolved.length) {
    invalid("counts", "summary_mismatch");
  }
  canonicalJson(result);
}

function sha256(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required");
}

function exact(value: object, allowed: readonly string[], field: string): void {
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (extras.length > 0 || missing.length > 0) {
    invalid(field, extras.length > 0 ? `unknown_fields:${extras.sort().join(",")}` : `missing_fields:${missing.join(",")}`);
  }
}

function deterministicIdentityId<K extends "principal" | "project">(
  kind: K,
): (sourceRef: string) => CanonicalId<K> {
  return (sourceRef) => generateCanonicalId(kind, {
    now: ID_EPOCH_MS,
    entropy: createHash("sha256")
      .update(`seedrop.identity-import.v1\u0000${kind}\u0000${sourceRef}`)
      .digest()
      .subarray(0, 10),
  });
}

function sourceRefs(input: readonly { source_ref: string }[], field: string): string[] {
  const refs = input.map((candidate) => candidate.source_ref).sort();
  if (refs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) invalid(field, "empty_source_ref");
  if (new Set(refs).size !== refs.length) invalid(field, "duplicate_source_ref");
  return refs;
}

function exactSources(expected: readonly string[], observed: readonly string[], field: string): void {
  if (canonicalJson(expected) !== canonicalJson(observed)) invalid(field, "source_conservation_failed");
}

function disjoint(left: readonly string[], right: readonly string[], field: string): void {
  const overlap = left.filter((value) => right.includes(value));
  if (overlap.length > 0) invalid(field, "mapped_and_unresolved_overlap", { overlap: overlap.join(",") });
}

function invalid(
  field: string,
  reason: string,
  extra: Record<string, string | number | null> = {},
): never {
  throw new MigrationContractError("invalid_contract", { field, reason, ...extra });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
