import { canonicalJsonBytes, canonicalJsonDigest } from "@seedrop/protocol";
import type { ProjectTransactionDigest } from "@seedrop/protocol";

export interface SourceDigest { source_id: string; digest: ProjectTransactionDigest }
export interface ClaimSourceDependency { source_id: string; observed_digest: ProjectTransactionDigest }
export interface SourceDependentClaim { claim_id: string; dependencies: readonly ClaimSourceDependency[] }
export interface ClaimInvalidation { claim_id: string; state: "current" | "invalidated"; changed_source_ids: readonly string[] }
export interface SourceInvalidationProjection { source_digest: ProjectTransactionDigest; claims: readonly ClaimInvalidation[] }

export function compileSourceInvalidation(input: {
  current_sources: readonly SourceDigest[]; claims: readonly SourceDependentClaim[];
}): SourceInvalidationProjection {
  const sources = unique(input.current_sources, "source", (item) => item.source_id);
  const current = new Map(sources.map((item) => [item.source_id, item.digest]));
  const claims = unique(input.claims, "claim", (item) => item.claim_id).map((claim) => {
    const dependencies = unique(claim.dependencies, `dependency for ${claim.claim_id}`, (item) => item.source_id);
    const changed = dependencies.filter((dependency) => current.get(dependency.source_id) !== dependency.observed_digest)
      .map((dependency) => dependency.source_id).sort();
    return Object.freeze({ claim_id: claim.claim_id, state: changed.length ? "invalidated" as const : "current" as const,
      changed_source_ids: Object.freeze(changed) });
  }).sort((a, b) => a.claim_id.localeCompare(b.claim_id));
  return deepFreeze({ source_digest: canonicalJsonDigest(sources.sort((a, b) => a.source_id.localeCompare(b.source_id))) as ProjectTransactionDigest, claims });
}
export function sourceInvalidationBytes(value: SourceInvalidationProjection): Uint8Array { return canonicalJsonBytes(value); }
function unique<T>(items: readonly T[], label: string, key: (item: T) => string): T[] {
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)));
  if (new Set(sorted.map(key)).size !== sorted.length) throw new Error(`Duplicate ${label}.`);
  return sorted;
}
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
