import { readFile } from "node:fs/promises";
import { adapterFeatureEnabled, assertAdapterSituation, selectAdapterSituation } from "@seedrop/situation";
import type { AdapterSituationProjection, AdapterSituationSelection, JsonValue, ProjectTransactionDigest } from "@seedrop/situation";

export function bindObserverSituation(input: {
  feature: string | boolean | undefined;
  projection: AdapterSituationProjection | null;
  projectionInvalid?: boolean;
  legacy: JsonValue;
  expected?: { situation_id?: ProjectTransactionDigest; decision_id?: ProjectTransactionDigest; semantic_digest?: ProjectTransactionDigest };
}): AdapterSituationSelection {
  return selectAdapterSituation({
    feature_enabled: adapterFeatureEnabled(input.feature),
    shared: input.projection,
    projection_invalid: input.projectionInvalid,
    legacy: input.legacy,
    expected: input.expected,
  });
}

export async function readObserverSituationFile(path: string | undefined): Promise<{
  projection: AdapterSituationProjection | null; invalid: boolean;
}> {
  if (!path) return { projection: null, invalid: false };
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    assertAdapterSituation(parsed);
    return { projection: parsed, invalid: false };
  } catch {
    return { projection: null, invalid: true };
  }
}
