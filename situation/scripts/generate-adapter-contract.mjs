import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputs = new Map([
  ["generated/adapter-contract.json", {
    schema_version: "1.0.0",
    buckets: ["ongoing", "needs_attention", "up_next", "quiet"],
    health_states: ["healthy", "degraded", "blocked", "unknown"],
    readiness_states: ["ready", "active", "review", "blocked", "unknown"],
    fallback_reasons: ["feature_disabled", "projection_missing", "projection_mismatch"],
    mutation_capability: "read_only",
    bindings: {
      cli_flags: ["--v2-situation", "--v1", "--situation-file", "--expect-situation", "--expect-decision", "--expect-semantic"],
      mcp_fields: ["v2_situation", "situation_file", "expect_situation", "expect_decision", "expect_semantic"],
    },
  }],
  ["generated/adapter-situation.schema.json", {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://seedrop.dev/schema/adapter-situation-1.0.0.json",
    title: "Seedrop Adapter Situation",
    type: "object",
    additionalProperties: false,
    required: ["adapter_version", "situation_id", "decision_id", "semantic_digest", "bucket", "readiness", "health", "decision", "orientation", "trust", "budget", "warnings", "mutation_capability"],
    properties: {
      adapter_version: { const: "1.0.0" },
      situation_id: { $ref: "#/$defs/digest" }, decision_id: { $ref: "#/$defs/digest" }, semantic_digest: { $ref: "#/$defs/digest" },
      bucket: { enum: ["ongoing", "needs_attention", "up_next", "quiet"] },
      readiness: { enum: ["ready", "active", "review", "blocked", "unknown"] },
      health: { type: "object", additionalProperties: false,
        required: ["state", "substrate", "freshness", "completeness", "degraded_source_ids", "quarantine_count", "unresolved_disagreement_count"],
        properties: { state: { enum: ["healthy", "degraded", "blocked", "unknown"] }, substrate: { type: "string" }, freshness: { type: "string" }, completeness: { type: "string" },
          degraded_source_ids: { type: "array", items: { type: "string" }, uniqueItems: true }, quarantine_count: { type: "integer", minimum: 0 }, unresolved_disagreement_count: { type: "integer", minimum: 0 } } },
      decision: { type: "object", additionalProperties: false,
        required: ["disposition", "action", "reason", "smallest_repair", "display"],
        properties: { disposition: { enum: ["recommend", "refuse", "unknown"] }, action: { type: ["string", "null"] },
          reason: { type: ["string", "null"] }, smallest_repair: { type: ["string", "null"] }, display: { type: "string" } } },
      orientation: { type: "object" }, trust: { type: "object" },
      budget: { type: "object" }, warnings: { type: "array", items: { type: "string" }, uniqueItems: true },
      mutation_capability: { const: "read_only" },
    },
    $defs: { digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } },
  }],
]);

const check = process.argv.includes("--check");
for (const [relative, value] of outputs) {
  const target = resolve(root, relative), expected = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    let actual = "";
    try { actual = readFileSync(target, "utf8"); } catch {}
    if (actual !== expected) throw new Error(`Generated adapter contract is stale: ${relative}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, expected);
  }
}
