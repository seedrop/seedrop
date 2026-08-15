import { readFile } from "node:fs/promises";
import { compileLiveBoundedSituation } from "@seedrop/migration";
import {
  adapterFeatureEnabled,
  adapterServeRequested,
  assertAdapterSituation,
  compileAdapterSituation,
  selectAdapterSituation,
} from "@seedrop/situation";
import type {
  AdapterSituationProjection,
  AdapterSituationSelection,
  BoundedSituationProjection,
  JsonValue,
} from "@seedrop/situation";

export const CLI_SITUATION_BINDING_VERSION = "1.0.0" as const;

export function cliSituationEnabled(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  return adapterServeRequested({ argv, env });
}

export interface CliSituationBinding {
  binding_version: typeof CLI_SITUATION_BINDING_VERSION;
  adapter: "cli";
  selection: AdapterSituationSelection;
  continuity_page: JsonValue | null;
}

export async function bindCliSituation(input: {
  feature: string | boolean | undefined;
  projection_file?: string;
  repo_root?: string;
  view_root?: string;
  principal_alias?: string;
  identity_root?: string;
  legacy: JsonValue;
  continuity_page?: JsonValue | null;
  expected?: Parameters<typeof selectAdapterSituation>[0]["expected"];
  compile_live?: (input: {
    repo_root: string;
    view_root?: string;
    principal_alias?: string;
    identity_root?: string;
  }) => Promise<BoundedSituationProjection>;
}): Promise<CliSituationBinding> {
  let shared: AdapterSituationProjection | null = null;
  let invalid = false;
  if (input.projection_file) {
    try {
      const parsed: unknown = JSON.parse(await readFile(input.projection_file, "utf8"));
      assertAdapterSituation(parsed);
      shared = parsed;
    } catch { invalid = true; }
  } else if (adapterFeatureEnabled(input.feature) && input.repo_root) {
    try {
      const bounded = await (input.compile_live ?? defaultCompileLive)({
        repo_root: input.repo_root,
        view_root: input.view_root,
        principal_alias: input.principal_alias,
        identity_root: input.identity_root,
      });
      shared = compileAdapterSituation(bounded);
    } catch {
      shared = null;
    }
  }
  const selection = selectAdapterSituation({
    feature_enabled: adapterFeatureEnabled(input.feature),
    shared,
    legacy: input.legacy,
    expected: input.expected,
    projection_invalid: invalid,
  });
  return deepFreeze({
    binding_version: CLI_SITUATION_BINDING_VERSION,
    adapter: "cli",
    selection,
    continuity_page: input.continuity_page ?? null,
  });
}

export function renderCliSituationBinding(binding: CliSituationBinding): string {
  if (binding.selection.mode === "v1_fallback") return `${binding.selection.warning}\n`;
  const situation = binding.selection.served.payload;
  return [
    "Seedrop Situation v2 (shadow)",
    `Situation: ${situation.situation_id}`,
    `Decision: ${situation.decision_id}`,
    `Health: ${situation.health.state} (${situation.health.substrate})`,
    `Bucket: ${situation.bucket}`,
    `Readiness: ${situation.readiness}`,
    `Next: ${situation.decision.display}`,
    ...(situation.warnings.length ? [`Warnings: ${situation.warnings.join(", ")}`] : []),
    "",
  ].join("\n");
}

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function defaultCompileLive(input: {
  repo_root: string;
  view_root?: string;
  principal_alias?: string;
  identity_root?: string;
}): Promise<BoundedSituationProjection> {
  return (await compileLiveBoundedSituation(input)).bounded;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
