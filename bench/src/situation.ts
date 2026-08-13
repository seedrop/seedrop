import type { AdapterSituationSelection } from "@seedrop/observer";

export interface BenchSharedSituationView {
  situationId: string;
  decisionId: string;
  semanticDigest: string;
  bucket: string;
  readiness: string;
  health: string;
  intent: string;
  nextAction: string;
  warnings: readonly string[];
}

export function benchSharedSituationView(project: {
  adapter_situation?: AdapterSituationSelection;
}): BenchSharedSituationView | null {
  const selection = project.adapter_situation;
  if (!selection || selection.mode !== "v2") return null;
  const payload = selection.served.payload;
  return {
    situationId: payload.situation_id,
    decisionId: payload.decision_id,
    semanticDigest: payload.semantic_digest,
    bucket: payload.bucket,
    readiness: payload.readiness,
    health: payload.health.state,
    intent: displayValue(payload.orientation.intent, ["title", "goal", "state", "intent_id"]),
    nextAction: payload.decision.display,
    warnings: payload.warnings,
  };
}

function displayValue(input: unknown, keys: readonly string[]): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Not available";
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "Not available";
}
