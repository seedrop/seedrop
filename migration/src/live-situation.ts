import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileGraveProjection, compileOutcomeProjection, compileSourceInvalidation } from "@seedrop/outcomes";
import { reduceImportedOrientation, reduceProjectTransactions, reduceWorkProjection } from "@seedrop/project";
import {
  ProtocolError,
  buildHealthEnvelope,
  canonicalJsonBytes,
  canonicalJsonDigest,
  projectTransactionDigest,
  resolvePrincipalIdentity,
  resolveProjectIdentity,
} from "@seedrop/protocol";
import type { CanonicalId, PrincipalRegistry, ProjectTransactionDigest } from "@seedrop/protocol";
import {
  boundedSituationBytes,
  compileBoundedSituation,
  compileSituation,
} from "@seedrop/situation";
import type { BoundedSituationProjection, SituationIdentityReadModel } from "@seedrop/situation";
import { importIdentityRegistries } from "./identity.js";
import { collectLiveIdentityCorpus, digestReadOnlyTree } from "./v1-passports.js";
import { collectV1ViewHistory } from "./v1-view.js";
import { importViewHistory } from "./view-history.js";

const DEFAULT_BUDGET_BYTES = 4096;

export interface CompileLiveBoundedSituationInput {
  repo_root: string;
  view_root?: string;
  principal_alias?: string;
  identity_root?: string;
  outcome_report_path?: string;
  requested_bytes?: number;
}

export interface CompileLiveBoundedSituationResult {
  bounded: BoundedSituationProjection;
  source_tree_digest: string;
  view_unchanged: true;
  bytes: number;
}

export async function compileLiveBoundedSituation(
  input: CompileLiveBoundedSituationInput,
): Promise<CompileLiveBoundedSituationResult> {
  const repoRoot = await realpath(resolve(input.repo_root));
  const viewRoot = await realpath(resolve(input.view_root ?? join(repoRoot, ".seedrop", "view")));
  const requestedBytes = input.requested_bytes ?? DEFAULT_BUDGET_BYTES;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "seedrop-live-situation-"));
  const before = await digestReadOnlyTree(viewRoot);
  try {
    const outcomePath = input.outcome_report_path ?? await writeOutcomeReport(repoRoot, temporaryRoot);
    const identities = importIdentityRegistries(await collectLiveIdentityCorpus({
      identity_root: input.identity_root,
    }));
    const projectId = resolveProjectIdentity(identities.project_registry, {
      namespace: "placement_path",
      value: repoRoot,
    });
    const identity = resolveBootIdentity(identities.principal_registry, input.principal_alias);
    const collection = await collectV1ViewHistory({
      view_root: viewRoot,
      outcome_report_path: outcomePath,
    });
    const observedAt = await observedTimestamp(outcomePath);
    const imported = importViewHistory({
      collection,
      project_id: projectId,
      migration_principal_id: identity.migration_principal_id,
      principal_registry: identities.principal_registry,
      snapshot_recorded_at: observedAt,
    });
    const transactions = imported.transactions.map((transaction) => {
      const digest = projectTransactionDigest(transaction);
      return {
        digest,
        relative_path: `transactions/${digest.slice(7)}.json`,
        byte_length: canonicalJsonBytes(transaction).byteLength,
        transaction,
      };
    });
    const scan = {
      project_id: projectId,
      transactions,
      sources: transactions.map((entry) => ({
        path: entry.relative_path,
        expected_digest: entry.digest,
        actual_digest: entry.digest,
        status: "valid" as const,
      })),
      diagnostics: [],
    };
    const projection = reduceProjectTransactions(scan);
    const work = reduceWorkProjection(scan);
    const importedOrientation = reduceImportedOrientation(scan);
    const outcomes = compileOutcomeProjection({ transactions: imported.transactions });
    const graves = compileGraveProjection({ transactions: imported.transactions, outcomes });
    const invalidation = compileSourceInvalidation({ current_sources: [], claims: [] });
    const governing = transactions.at(-1)?.transaction.events.at(-1)?.event_id ?? null;
    const health = buildHealthEnvelope({
      generated_at: observedAt,
      projection_version: projection.projection_version,
      policy: {
        policy_id: "seedrop.situation.live-shadow",
        policy_version: "1.0.0",
        required_projection_version: "1.0.0",
        required_source_ids: ["project"],
      },
      sources: [{
        source_id: "project",
        kind: "project_transactions",
        status: "available",
        high_watermark: projection.source_high_watermark,
        content_digest: projection.source_digest,
        observed_at: observedAt,
        governing_record_id: governing,
      }],
      budget: {
        requested_bytes: requestedBytes,
        actual_bytes: 0,
        complete: true,
        candidate_count: transactions.length,
        indexed_count: transactions.length,
        scanned_count: 0,
        omitted_categories: [],
      },
    });
    const situation = compileSituation({
      generated_at: observedAt,
      project: port("project", projection.source_digest, {
        projection, work, imported_orientation: importedOrientation, health,
      }, observedAt),
      outcomes: port("outcomes", outcomes.source_digest, outcomes, observedAt),
      graves: port("graves", graves.source_digest, graves, observedAt),
      identity: port("identity", identities.receipt.source_mapping_digest, identity.read_model, observedAt),
      coordination: port("coordination", canonicalJsonDigest({ status: "unavailable" }), {
        status: "unavailable", active_claims: [], inbox_unacked: 0,
      }, observedAt),
      invalidation: port("invalidation", invalidation.source_digest, invalidation, observedAt),
    });
    const eventCount = imported.transactions.reduce((sum, transaction) => sum + transaction.events.length, 0);
    const bounded = compileBoundedSituation(situation, {
      requested_bytes: requestedBytes,
      metrics: {
        candidate_count: eventCount,
        indexed_count: eventCount,
        scanned_count: 0,
        event_count: eventCount,
        file_count: await manifestFileCount(viewRoot),
      },
    });
    const after = await digestReadOnlyTree(viewRoot);
    if (before !== after) throw new Error(`View changed while compiling live Situation for ${repoRoot}.`);
    const bytes = boundedSituationBytes(bounded).byteLength;
    return { bounded, source_tree_digest: collection.source_tree_digest, view_unchanged: true, bytes };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function resolveBootIdentity(
  registry: PrincipalRegistry,
  alias: string | undefined,
): { migration_principal_id: CanonicalId<"principal">; read_model: SituationIdentityReadModel } {
  const fallback = registry.principals[0];
  if (!fallback) throw new Error("Live Situation compile requires at least one principal in the identity corpus.");
  if (!alias) {
    return {
      migration_principal_id: fallback.principal_id,
      read_model: {
        principal_id: null,
        display_name: null,
        status: "unknown",
        candidates: registry.principals.map((entry) => entry.principal_id),
      },
    };
  }
  try {
    const principalId = resolvePrincipalIdentity(registry, alias);
    return {
      migration_principal_id: principalId,
      read_model: {
        principal_id: principalId,
        display_name: alias,
        status: "resolved",
        candidates: [],
      },
    };
  } catch (error) {
    const ambiguous = error instanceof ProtocolError && error.code === "seedrop.protocol.identity_alias_ambiguous";
    return {
      migration_principal_id: fallback.principal_id,
      read_model: {
        principal_id: null,
        display_name: alias,
        status: ambiguous ? "ambiguous" : "unknown",
        candidates: registry.principals.map((entry) => entry.principal_id),
      },
    };
  }
}

async function writeOutcomeReport(repoRoot: string, temporaryRoot: string): Promise<string | undefined> {
  const script = join(repoRoot, "scripts", "outcome-layer.mjs");
  if (!existsSync(script)) return undefined;
  const reportPath = join(temporaryRoot, "outcome-layer.json");
  execFileSync(process.execPath, [script, "--root", repoRoot, "--json", reportPath], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return reportPath;
}

async function observedTimestamp(outcomePath: string | undefined): Promise<string> {
  if (!outcomePath) return new Date().toISOString();
  try {
    const report = JSON.parse(await readFile(outcomePath, "utf8")) as { generated_at?: string };
    return report.generated_at ?? new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

async function manifestFileCount(viewRoot: string): Promise<number> {
  try {
    const manifest = JSON.parse(await readFile(join(viewRoot, "manifest.json"), "utf8")) as { files?: unknown[] };
    return Array.isArray(manifest.files) ? manifest.files.length : 0;
  } catch {
    return 0;
  }
}

function port<T>(source_id: string, source_digest: ProjectTransactionDigest, value: T, observed_at: string) {
  return {
    source_id,
    source_digest,
    observed_at,
    freshness: "current" as const,
    completeness: "complete" as const,
    value,
    missing: [],
  };
}
