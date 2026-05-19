import type { ZodType } from "zod";
import { SchemaVersionUnsupportedError, WorkspaceViewValidationError } from "./errors.js";

/**
 * Forward-only schema migration infrastructure.
 *
 * See .seedrop/view/knowledge/schema-migrations-2026-05-19.md for the design
 * doc. Summary: each persisted schema (Task, RunJournal, ContinuityPacket)
 * declares a chain of `from -> to` transforms. On read, if the stored
 * `schema_version` is less than the chain's `current`, we walk the chain in
 * memory, then Zod-parse the result. Reads do not write the migrated form
 * back to disk; mutations always emit the current version, so files
 * naturally migrate on next mutation.
 *
 * Forward-version files (stored version > current) and unknown versions
 * throw `SchemaVersionUnsupportedError` with recovery hints pointing to
 * `npm i -g @seedrop/cli@latest`.
 */

export interface SchemaMigration {
  /** Stored version this migration upgrades from. */
  from: string;
  /** Resulting version after this migration runs. */
  to: string;
  /** Pure transform. Receives a permissive `unknown`; returns the next-version shape. */
  migrate: (data: unknown) => unknown;
}

export interface MigrationChain {
  /** Human-readable schema label used in error messages (e.g. "Task"). */
  schemaName: string;
  /** The version this codebase reads and writes today. */
  current: string;
  /** Ordered list of migrations. Each `to` should equal the next entry's `from`. */
  migrations: SchemaMigration[];
}

/**
 * Walk the migration chain to produce a current-version object, then
 * Zod-parse. Throws `SchemaVersionUnsupportedError` on forward-versions or
 * unknown versions; throws `WorkspaceViewValidationError` if the final
 * Zod parse fails (which means a migration produced malformed output, or
 * a current-version file on disk is invalid).
 */
export function parseAndMigrate<T>(
  raw: unknown,
  chain: MigrationChain,
  schema: ZodType<T>,
  filePath?: string,
): T {
  const storedVersion = readStoredVersion(raw);
  const current = chain.current;

  if (storedVersion === current) {
    return runZodParse(raw, schema, filePath);
  }

  if (compareVersions(storedVersion, current) > 0) {
    throw new SchemaVersionUnsupportedError({
      schema: chain.schemaName,
      found: storedVersion,
      supported: current,
      path: filePath,
      reason: "forward",
    });
  }

  // Walk the chain.
  let cursor = storedVersion;
  let value: unknown = raw;
  const seen = new Set<string>();
  while (cursor !== current) {
    if (seen.has(cursor)) {
      // Defensive: a malformed chain with a cycle would otherwise loop forever.
      throw new SchemaVersionUnsupportedError({
        schema: chain.schemaName,
        found: storedVersion,
        supported: current,
        path: filePath,
        reason: "no-path",
      });
    }
    seen.add(cursor);
    const step = chain.migrations.find((m) => m.from === cursor);
    if (!step) {
      throw new SchemaVersionUnsupportedError({
        schema: chain.schemaName,
        found: storedVersion,
        supported: current,
        path: filePath,
        reason: "unknown",
      });
    }
    value = step.migrate(value);
    cursor = step.to;
  }

  return runZodParse(value, schema, filePath);
}

function runZodParse<T>(value: unknown, schema: ZodType<T>, filePath: string | undefined): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WorkspaceViewValidationError(result.error.issues, filePath ?? "(migrated value)");
  }
  return result.data;
}

/**
 * Read `schema_version` from a JSON-ish blob. Missing or non-string values
 * default to "1.0" — the implicit version for files written before
 * versioning was added to a schema (e.g. ContinuityPacket pre-1b8676dc).
 */
function readStoredVersion(raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const v = (raw as Record<string, unknown>).schema_version;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "1.0";
}

/**
 * Compare two semver-ish version strings ("1.0", "1.1", "2.0", "1.0.3").
 * Returns -1, 0, 1. Missing segments are treated as 0. Non-numeric
 * segments fall back to string compare (defensive — we don't expect them).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const ap = aParts[i] ?? "0";
    const bp = bParts[i] ?? "0";
    const an = Number(ap);
    const bn = Number(bp);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an < bn) return -1;
      if (an > bn) return 1;
    } else {
      if (ap < bp) return -1;
      if (ap > bp) return 1;
    }
  }
  return 0;
}
