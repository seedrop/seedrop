import { createHash } from "node:crypto";
import {
  NATIVE_WORK_COMMANDS,
  canonicalJson,
  canonicalJsonBytes,
  canonicalJsonDigest,
  generateCanonicalId,
  parseCanonicalId,
} from "@seedrop/protocol";
import type { CanonicalId, JsonValue, ProjectTransactionDigest } from "@seedrop/protocol";
import { MigrationContractError } from "./contract.js";
import {
  COMPATIBILITY_DISPOSITIONS,
  COMPATIBILITY_VERSION,
  V1_TRANSLATOR_DISPOSITIONS,
} from "./types.js";
import type {
  CompatibilityDifference,
  CompatibilityProjectionResult,
  V1CommandInput,
  V1DryRunCommandDraft,
  ViewHistoryCollection,
  ViewHistoryImportResult,
} from "./types.js";
import { assertViewHistoryImportResult } from "./view-history.js";

const TRANSFORMED_FAMILIES = new Set(["task", "run", "signal", "delivery_observation"]);

export function compareV1AndV2Projection(input: {
  collection: ViewHistoryCollection;
  imported: ViewHistoryImportResult;
}): CompatibilityProjectionResult {
  assertViewHistoryImportResult(input.imported);
  if (input.collection.source_tree_digest !== input.imported.receipt.source_tree_digest) invalid("source_tree_digest", "binding_mismatch");
  const transactions = new Map(input.imported.transactions.map((transaction) => [
    object(transaction.events[0]?.payload).source_ref,
    transaction,
  ]));
  const differences: CompatibilityDifference[] = [...input.collection.records]
    .sort((left, right) => left.source_ref.localeCompare(right.source_ref))
    .map((source) => {
      const transaction = transactions.get(source.source_ref);
      const v1Digest = canonicalJsonDigest(source.source_payload) as ProjectTransactionDigest;
      if (!transaction) return difference(source, "unresolved", "v2_transaction_missing", v1Digest, null);
      const base = object(transaction.events[0]?.payload);
      const disposition = base.disposition;
      const v2Payload = base.source_payload ?? null;
      const transformed = TRANSFORMED_FAMILIES.has(source.source_family) && base.canonical_subject_id !== null;
      const v2Semantics = transformed ? {
        source_payload: v2Payload,
        canonical_subject_id: base.canonical_subject_id ?? null,
        source_principal_id: base.source_principal_id ?? null,
        explicit_links: base.explicit_links ?? {},
      } : v2Payload;
      const v2Digest = canonicalJsonDigest(v2Semantics) as ProjectTransactionDigest;
      if (disposition === "quarantined") return difference(source, "quarantined", "source_quarantined", v1Digest, v2Digest);
      if (disposition === "unresolved") return difference(source, "unresolved", "explicit_link_unresolved", v1Digest, v2Digest);
      if (transformed) {
        return difference(source, "intentionally_transformed", `v1_${source.source_family}_mapped_to_canonical_subject`, v1Digest, v2Digest);
      }
      if (canonicalJson(source.source_payload) === canonicalJson(v2Payload)) {
        return difference(source, "equal", "semantic_payload_equal", v1Digest, v2Digest);
      }
      if (TRANSFORMED_FAMILIES.has(source.source_family)) {
        return difference(source, "intentionally_transformed", `v1_${source.source_family}_mapped_at_edge`, v1Digest, v2Digest);
      }
      return difference(source, "unresolved", "undeclared_semantic_difference", v1Digest, v2Digest);
    });
  const counts = {
    source_records: differences.length,
    equal_records: countDisposition(differences, "equal"),
    intentionally_transformed_records: countDisposition(differences, "intentionally_transformed"),
    quarantined_records: countDisposition(differences, "quarantined"),
    unresolved_records: countDisposition(differences, "unresolved"),
  };
  const result = deepFreeze({
    receipt: {
      compatibility_version: COMPATIBILITY_VERSION,
      source_tree_digest: input.collection.source_tree_digest,
      transaction_chain_digest: input.imported.receipt.transaction_chain_digest,
      comparison_digest: canonicalJsonDigest(differences) as ProjectTransactionDigest,
      counts,
    },
    differences,
  });
  assertCompatibilityProjectionResult(result);
  return result;
}

export function translateV1CommandDryRun(input: V1CommandInput): V1DryRunCommandDraft {
  parseCanonicalId(input.principal_id, "principal");
  parseCanonicalId(input.project_id, "project");
  nonempty(input.source_ref, "source_ref");
  nonempty(input.command_name, "command_name");
  if (input.expected_state_version !== null) sha256(input.expected_state_version, "expected_state_version");
  canonicalJson(input.args);
  const sourceDigest = canonicalJsonDigest({ source_ref: input.source_ref, command_name: input.command_name, args: input.args }) as ProjectTransactionDigest;
  const common = {
    compatibility_version: COMPATIBILITY_VERSION,
    source_ref: input.source_ref,
    source_digest: sourceDigest,
    submit_capability: false as const,
  };
  if (input.command_name !== "task.create") {
    const disposition = ["run.start", "run.finish", "signal.claim", "task.done"].includes(input.command_name)
      ? "intentionally_unsupported" as const : "unresolved" as const;
    return deepFreeze({
      ...common,
      disposition,
      reason_code: disposition === "intentionally_unsupported"
        ? "requires_existing_v2_identity_or_combined_work_command"
        : "unknown_v1_command",
      command: null,
    });
  }
  const args = object(input.args);
  const title = text(args.title);
  if (title === null) return deepFreeze({ ...common, disposition: "unresolved", reason_code: "task_title_missing", command: null });
  const target = text(args.target) ?? `v1-task:${sourceDigest}`;
  const goal = text(args.description) ?? title;
  const expiresAt = text(args.lease_expires_at);
  if (expiresAt === null || !timestamp(expiresAt)) {
    return deepFreeze({ ...common, disposition: "unresolved", reason_code: "lease_expiry_required_for_v2_open", command: null });
  }
  const command = {
    command_id: deterministicId("command", `${input.source_ref}\u0000${sourceDigest}`),
    command_version: "1.0.0" as const,
    command_name: NATIVE_WORK_COMMANDS.open,
    principal_id: input.principal_id,
    project_id: input.project_id,
    idempotency_key: `seedrop.compat.v1:${sourceDigest}`,
    expected_state_version: input.expected_state_version,
    payload: {
      intent_id: deterministicId("intent", `${input.source_ref}\u0000intent`),
      episode_id: deterministicId("episode", `${input.source_ref}\u0000episode`),
      scope_claim_id: deterministicId("claim", `${input.source_ref}\u0000claim`),
      receipt_id: deterministicId("receipt", `${input.source_ref}\u0000receipt`),
      lease_id: deterministicId("lease", `${input.source_ref}\u0000lease`),
      title, goal, scope_statement: text(args.scope_statement) ?? goal, target, lease_expires_at: expiresAt,
    },
  };
  return deepFreeze({ ...common, disposition: "translated", reason_code: "task_create_collapsed_to_open_work", command });
}

export function compatibilityProjectionBytes(result: CompatibilityProjectionResult): Uint8Array {
  assertCompatibilityProjectionResult(result);
  return canonicalJsonBytes(result);
}

export function assertCompatibilityProjectionResult(result: CompatibilityProjectionResult): void {
  exact(result, ["receipt", "differences"], "result");
  exact(result.receipt, ["compatibility_version", "source_tree_digest", "transaction_chain_digest", "comparison_digest", "counts"], "receipt");
  exact(result.receipt.counts, ["source_records", "equal_records", "intentionally_transformed_records", "quarantined_records", "unresolved_records"], "receipt.counts");
  if (result.receipt.compatibility_version !== COMPATIBILITY_VERSION) invalid("compatibility_version", "unsupported");
  sha256(result.receipt.source_tree_digest, "source_tree_digest");
  sha256(result.receipt.transaction_chain_digest, "transaction_chain_digest");
  sha256(result.receipt.comparison_digest, "comparison_digest");
  const refs = result.differences.map((item) => item.source_ref);
  if (new Set(refs).size !== refs.length || canonicalJson(refs) !== canonicalJson([...refs].sort())) invalid("differences", "unique_canonical_order_required");
  for (const item of result.differences) {
    exact(item, ["source_ref", "source_family", "source_digest", "disposition", "reason_code", "v1_semantic_digest", "v2_semantic_digest"], "differences.item");
    if (!(COMPATIBILITY_DISPOSITIONS as readonly string[]).includes(item.disposition)) invalid("differences.disposition", "unknown");
    nonempty(item.reason_code, "differences.reason_code");
    sha256(item.source_digest, "differences.source_digest");
    sha256(item.v1_semantic_digest, "differences.v1_semantic_digest");
    if (item.v2_semantic_digest !== null) sha256(item.v2_semantic_digest, "differences.v2_semantic_digest");
  }
  if (result.receipt.comparison_digest !== canonicalJsonDigest(result.differences)) invalid("comparison_digest", "mismatch");
  const counts = result.receipt.counts;
  for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0) invalid("counts", "nonnegative_safe_integer_required");
  if (counts.source_records !== result.differences.length
    || counts.equal_records !== countDisposition(result.differences, "equal")
    || counts.intentionally_transformed_records !== countDisposition(result.differences, "intentionally_transformed")
    || counts.quarantined_records !== countDisposition(result.differences, "quarantined")
    || counts.unresolved_records !== countDisposition(result.differences, "unresolved")
    || counts.equal_records + counts.intentionally_transformed_records + counts.quarantined_records + counts.unresolved_records !== counts.source_records) invalid("counts", "summary_or_conservation_mismatch");
  canonicalJson(result);
}

export function assertV1DryRunCommandDraft(draft: V1DryRunCommandDraft): void {
  exact(draft, ["compatibility_version", "source_ref", "source_digest", "disposition", "reason_code", "submit_capability", "command"], "draft");
  if (draft.compatibility_version !== COMPATIBILITY_VERSION || draft.submit_capability !== false) invalid("draft", "dry_run_only");
  if (!(V1_TRANSLATOR_DISPOSITIONS as readonly string[]).includes(draft.disposition)) invalid("draft.disposition", "unknown");
  if ((draft.disposition === "translated") !== (draft.command !== null)) invalid("draft.command", "disposition_mismatch");
  if (draft.command) {
    parseCanonicalId(draft.command.command_id, "command");
    parseCanonicalId(draft.command.principal_id, "principal");
    parseCanonicalId(draft.command.project_id, "project");
    if (draft.command.command_name !== NATIVE_WORK_COMMANDS.open) invalid("draft.command.command_name", "edge_registry_only");
  }
  canonicalJson(draft);
}

function difference(source: ViewHistoryCollection["records"][number], disposition: CompatibilityDifference["disposition"], reason: string, v1: ProjectTransactionDigest, v2: ProjectTransactionDigest | null): CompatibilityDifference {
  return Object.freeze({ source_ref: source.source_ref, source_family: source.source_family, source_digest: source.source_digest, disposition, reason_code: reason, v1_semantic_digest: v1, v2_semantic_digest: v2 });
}

function countDisposition(items: readonly CompatibilityDifference[], disposition: CompatibilityDifference["disposition"]): number {
  return items.filter((item) => item.disposition === disposition).length;
}

function deterministicId<K extends "command" | "intent" | "episode" | "claim" | "receipt" | "lease">(kind: K, seed: string): CanonicalId<K> {
  return generateCanonicalId(kind, { now: 1_725_000_000_000, entropy: createHash("sha256").update(`seedrop.compat.v1\u0000${kind}\u0000${seed}`).digest().subarray(0, 10) });
}

function object(value: unknown): Record<string, JsonValue> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim().length > 0 ? value : null; }
function timestamp(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value; }
function sha256(value: string, field: string): void { if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(field, "sha256_required"); }
function nonempty(value: string, field: string): void { if (typeof value !== "string" || value.trim().length === 0) invalid(field, "nonempty_required"); }
function exact(value: object, allowed: readonly string[], field: string): void { const keys = Object.keys(value); const extras = keys.filter((key) => !allowed.includes(key)); const missing = allowed.filter((key) => !keys.includes(key)); if (extras.length || missing.length) invalid(field, extras.length ? `unknown_fields:${extras.sort().join(",")}` : `missing_fields:${missing.join(",")}`); }
function invalid(field: string, reason: string): never { throw new MigrationContractError("invalid_contract", { field, reason }); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested); } return value; }
