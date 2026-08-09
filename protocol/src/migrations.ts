import { protocolError } from "./errors.js";
import {
  compareProtocolVersions,
  parseProtocolVersion,
  type ProtocolVersion,
} from "./versions.js";

export interface MigrationStep<T = unknown> {
  id: string;
  from: ProtocolVersion;
  to: ProtocolVersion;
  description: string;
  migrate: (value: T) => T;
}

export interface MigrationPlan<T = unknown> {
  schema: string;
  current: ProtocolVersion;
  roots: readonly ProtocolVersion[];
  steps: readonly MigrationStep<T>[];
}

export interface MigrationStepMetadata {
  id: string;
  from: ProtocolVersion;
  to: ProtocolVersion;
  description: string;
  reversible: false;
}

export interface MigrationPlanMetadata {
  schema: string;
  current: ProtocolVersion;
  roots: readonly ProtocolVersion[];
  direction: "forward_only";
  downgrade: "unsupported_restore_source_snapshot_or_use_compatibility_reader";
  steps: readonly MigrationStepMetadata[];
}

export interface MigrationResult<T> {
  value: T;
  from: ProtocolVersion;
  to: ProtocolVersion;
  applied: readonly string[];
}

export function defineMigrationPlan<T>(plan: MigrationPlan<T>): Readonly<MigrationPlan<T>> {
  validateMigrationPlan(plan);
  return Object.freeze({
    ...plan,
    roots: Object.freeze([...plan.roots]),
    steps: Object.freeze(plan.steps.map((step) => Object.freeze({ ...step }))),
  });
}

export function migrationPlanMetadata<T>(plan: MigrationPlan<T>): MigrationPlanMetadata {
  validateMigrationPlan(plan);
  return Object.freeze({
    schema: plan.schema,
    current: plan.current,
    roots: Object.freeze([...plan.roots]),
    direction: "forward_only",
    downgrade: "unsupported_restore_source_snapshot_or_use_compatibility_reader",
    steps: Object.freeze(plan.steps.map((step) => Object.freeze({
      id: step.id,
      from: step.from,
      to: step.to,
      description: step.description,
      reversible: false as const,
    }))),
  });
}

export function orderedMigrationPath<T>(
  plan: MigrationPlan<T>,
  from: unknown,
): readonly MigrationStep<T>[] {
  validateMigrationPlan(plan);
  const version = parseProtocolVersion(from);
  if (compareProtocolVersions(version, plan.current) > 0) {
    throw protocolError("seedrop.protocol.version_forward", {
      axis: "schema",
      current: plan.current,
      found: version,
      schema: plan.schema,
    });
  }
  if (version === plan.current) return Object.freeze([]);
  if (!plan.roots.includes(version) && !plan.steps.some((step) => step.from === version)) {
    throw protocolError("seedrop.protocol.version_unknown", {
      axis: "schema",
      current: plan.current,
      found: version,
      schema: plan.schema,
    });
  }

  const byFrom = new Map(plan.steps.map((step) => [step.from, step]));
  const path: MigrationStep<T>[] = [];
  let cursor = version;
  while (cursor !== plan.current) {
    const step = byFrom.get(cursor);
    if (!step) {
      throw protocolError("seedrop.protocol.migration_graph_invalid", {
        schema: plan.schema,
        reason: "gap",
        version: cursor,
      });
    }
    path.push(step);
    cursor = step.to;
  }
  return Object.freeze(path);
}

export function migrateToCurrent<T>(
  plan: MigrationPlan<T>,
  foundVersion: unknown,
  value: T,
  validateCurrent: (value: T) => boolean,
): MigrationResult<T> {
  const from = parseProtocolVersion(foundVersion);
  const path = orderedMigrationPath(plan, from);
  let migrated = value;
  const applied: string[] = [];
  for (const step of path) {
    try {
      migrated = step.migrate(migrated);
      applied.push(step.id);
    } catch (cause) {
      throw protocolError("seedrop.protocol.migration_failed", {
        schema: plan.schema,
        migration_id: step.id,
        from: step.from,
        to: step.to,
      }, { cause });
    }
  }
  if (!validateCurrent(migrated)) {
    throw protocolError("seedrop.protocol.validation_failed", {
      schema: plan.schema,
      version: plan.current,
    });
  }
  return Object.freeze({ value: migrated, from, to: plan.current, applied: Object.freeze(applied) });
}

export function validateMigrationPlan<T>(plan: MigrationPlan<T>): void {
  const fail = (reason: string, details: Record<string, string | number | boolean | null> = {}): never => {
    throw protocolError("seedrop.protocol.migration_graph_invalid", {
      schema: plan.schema,
      reason,
      ...details,
    });
  };
  if (!plan.schema.trim()) fail("missing_schema");
  parseProtocolVersion(plan.current);
  if (plan.roots.length === 0) fail("missing_root");

  const roots = new Set<string>();
  for (const root of plan.roots) {
    parseProtocolVersion(root);
    if (roots.has(root)) fail("duplicate_root", { version: root });
    roots.add(root);
  }

  const ids = new Set<string>();
  const byFrom = new Map<ProtocolVersion, MigrationStep<T>>();
  for (const step of plan.steps) {
    parseProtocolVersion(step.from);
    parseProtocolVersion(step.to);
    if (!step.id.trim()) fail("missing_step_id", { from: step.from });
    if (ids.has(step.id)) fail("duplicate_step_id", { migration_id: step.id });
    if (byFrom.has(step.from)) fail("ambiguous_outgoing", { version: step.from });
    if (compareProtocolVersions(step.from, step.to) >= 0) {
      fail("not_forward", { from: step.from, to: step.to });
    }
    ids.add(step.id);
    byFrom.set(step.from, step);
  }

  const visitedSteps = new Set<string>();
  for (const root of plan.roots) {
    let cursor = root;
    const seen = new Set<string>();
    while (cursor !== plan.current) {
      if (compareProtocolVersions(cursor as ProtocolVersion, plan.current) > 0) {
        fail("root_after_current", { version: cursor });
      }
      if (seen.has(cursor)) fail("cycle", { version: cursor });
      seen.add(cursor);
      const step = byFrom.get(cursor as ProtocolVersion);
      if (!step) return fail("gap", { version: cursor });
      visitedSteps.add(step.id);
      cursor = step.to;
    }
  }
  for (const step of plan.steps) {
    if (!visitedSteps.has(step.id)) fail("orphan_step", { migration_id: step.id });
  }
}

export const PROTOCOL_ENVELOPE_MIGRATIONS = defineMigrationPlan<unknown>({
  schema: "seedrop.protocol-envelope",
  current: "2.0.0",
  roots: Object.freeze(["2.0.0"]),
  steps: Object.freeze([]),
});
