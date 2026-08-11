#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "--check";
if (mode !== "--check" && mode !== "--write") {
  throw new Error("usage: generate-protocol-artifacts.mjs [--check|--write]");
}

const protocol = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
const sourceIndex = await readFile(join(packageRoot, "src/index.ts"), "utf8");
const publicExports = parsePublicExports(sourceIndex);
const surfaceShapes = [];
for (const surface of protocol.PROTOCOL_INVENTORY_CORE.surfaces) {
  const source = await readFile(join(packageRoot, surface.source_file), "utf8");
  surfaceShapes.push({
    name: surface.name,
    source_file: surface.source_file,
    fields: parseInterfaceFields(source, surface.name),
  });
}

const catalog = {
  artifact: "seedrop-v2-protocol-catalog",
  generated_from: ["src/index.ts", "src/inventory.ts", "registered public interface declarations"],
  prototype_scope: "Top-level public shape inventory; runtime builders remain the semantic validators.",
  core: protocol.PROTOCOL_INVENTORY_CORE,
  public_exports: publicExports,
  surface_shapes: surfaceShapes,
  coverage: {
    noun_count: protocol.PROTOCOL_INVENTORY_CORE.ontology.length,
    surface_count: surfaceShapes.length,
    gap_count: protocol.PROTOCOL_INVENTORY_CORE.gaps.length,
    public_value_export_count: publicExports.values.length,
    public_type_export_count: publicExports.types.length,
  },
};

const schema = buildSchema(catalog, protocol);
const outputs = new Map([
  ["generated/protocol-catalog.json", stableJson(catalog)],
  ["generated/protocol-surface-shapes.schema.json", stableJson(schema)],
  ["generated/protocol-bindings.ts", buildBindings(catalog)],
  ["generated/PROTOCOL-CATALOG.md", buildMarkdown(catalog)],
]);

const fixture = {
  fixture_version: "1.0.0",
  artifact: "seedrop-v2-protocol-generation",
  inventory_version: catalog.core.inventory_version,
  counts: catalog.coverage,
  sha256: Object.fromEntries([...outputs].map(([path, contents]) => [path, sha256(contents)])),
};
outputs.set("fixtures/protocol-generation-v1.json", stableJson(fixture));

if (mode === "--write") {
  for (const [path, contents] of outputs) {
    await mkdir(dirname(join(packageRoot, path)), { recursive: true });
    await writeFile(join(packageRoot, path), contents);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "write", files: [...outputs.keys()] })}\n`);
} else {
  const drift = [];
  for (const [path, expected] of outputs) {
    let actual;
    try {
      actual = await readFile(join(packageRoot, path), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      drift.push({ path, reason: "missing" });
      continue;
    }
    if (actual !== expected) drift.push({ path, reason: "content_mismatch" });
  }
  if (drift.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, mode: "check", drift })}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "check", files: [...outputs.keys()] })}\n`);
  }
}

function parsePublicExports(source) {
  const values = [];
  const types = [];
  const pattern = /export\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+"([^"]+)";/g;
  for (const match of source.matchAll(pattern)) {
    const destination = match[1] ? types : values;
    const sourceModule = match[3];
    for (const token of match[2].split(",")) {
      const name = token.trim().split(/\s+as\s+/).at(-1);
      if (name) destination.push({ name, source: sourceModule });
    }
  }
  const compare = (left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source);
  values.sort(compare);
  types.sort(compare);
  assertUnique(values.map((entry) => entry.name), "public value export");
  assertUnique(types.map((entry) => entry.name), "public type export");
  return { values, types };
}

function parseInterfaceFields(source, interfaceName) {
  const marker = new RegExp(`export\\s+interface\\s+${escapeRegExp(interfaceName)}(?:\\s+extends[^\\{]+)?\\s*\\{`, "m");
  const match = marker.exec(source);
  if (!match) throw new Error(`public surface ${interfaceName} is not an exported interface`);
  const open = source.indexOf("{", match.index);
  const close = matchingBrace(source, open);
  const body = source.slice(open + 1, close);
  const fields = splitProperties(body).map((property) => {
    const field = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/.exec(property.trim());
    if (!field) throw new Error(`cannot parse ${interfaceName} property: ${property.trim()}`);
    return {
      name: field[1],
      optional: Boolean(field[2]),
      typescript_type: normalizeWhitespace(field[3]),
    };
  });
  if (fields.length === 0) throw new Error(`public surface ${interfaceName} has no fields`);
  assertUnique(fields.map((field) => field.name), `${interfaceName} field`);
  return fields;
}

function matchingBrace(source, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error("unbalanced interface declaration");
}

function splitProperties(body) {
  const properties = [];
  let start = 0;
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") brace += 1;
    else if (character === "}") brace -= 1;
    else if (character === "[") bracket += 1;
    else if (character === "]") bracket -= 1;
    else if (character === "(") paren += 1;
    else if (character === ")") paren -= 1;
    else if (character === ";" && brace === 0 && bracket === 0 && paren === 0) {
      const property = body.slice(start, index).trim();
      if (property) properties.push(property);
      start = index + 1;
    }
  }
  const remainder = body.slice(start).trim();
  if (remainder) properties.push(remainder);
  return properties;
}

function buildSchema(catalogInput, runtime) {
  const definitions = {};
  for (const shape of catalogInput.surface_shapes) {
    const surface = catalogInput.core.surfaces.find((candidate) => candidate.name === shape.name);
    const properties = {};
    for (const field of shape.fields) {
      properties[field.name] = schemaForType(field.typescript_type);
      if (field.name === surface.version_field && surface.version_constant) {
        properties[field.name] = {
          ...properties[field.name],
          const: runtime[surface.version_constant],
        };
      }
    }
    definitions[shape.name] = {
      type: "object",
      additionalProperties: false,
      required: shape.fields.filter((field) => !field.optional).map((field) => field.name),
      properties,
      "x-seedrop-source": shape.source_file,
      "x-seedrop-role": surface.role,
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://seedrop.dev/schema/v2/protocol-surface-shapes.schema.json",
    title: "Seedrop v2 public protocol surface shapes",
    description: catalogInput.prototype_scope,
    oneOf: catalogInput.surface_shapes.map((shape) => ({ $ref: `#/$defs/${shape.name}` })),
    $defs: definitions,
    "x-seedrop-inventory-version": catalogInput.core.inventory_version,
    "x-seedrop-prototype-scope": "top-level-shapes",
  };
}

function schemaForType(type) {
  const description = `TypeScript contract: ${type}`;
  const withoutNull = type.replace(/\s*\|\s*null/g, "");
  const nullable = withoutNull !== type;
  let schema = { description };
  if (/^(readonly\s+.+\[\]|ReadonlyArray<)/.test(withoutNull)) schema.type = "array";
  else if (withoutNull === "number") schema.type = "number";
  else if (withoutNull === "boolean") schema.type = "boolean";
  else if (/^(string|CanonicalId<|ProtocolVersion|typeof\s+|`|"|')/.test(withoutNull)) schema.type = "string";
  else if (withoutNull.startsWith("{")) schema.type = "object";
  if (nullable && schema.type) schema.type = [schema.type, "null"];
  return schema;
}

function buildBindings(catalogInput) {
  const nounNames = catalogInput.core.ontology.map((nounEntry) => nounEntry.name);
  const surfaceFields = Object.fromEntries(catalogInput.surface_shapes.map((shape) => [
    shape.name,
    shape.fields.map((field) => ({ name: field.name, optional: field.optional })),
  ]));
  const bindings = `// Generated by scripts/generate-protocol-artifacts.mjs. Do not edit.\n\n`
    + `export const PROTOCOL_INVENTORY_VERSION = ${JSON.stringify(catalogInput.core.inventory_version)} as const;\n`
    + `export const PROTOCOL_NOUN_NAMES = ${JSON.stringify(nounNames, null, 2)} as const;\n`
    + `export const PROTOCOL_LIFECYCLES = ${JSON.stringify(catalogInput.core.lifecycles, null, 2)} as const;\n`
    + `export const PROTOCOL_TRUST_AXES = ${JSON.stringify(catalogInput.core.trust_axes, null, 2)} as const;\n`
    + `export const PROTOCOL_EVENT_TYPES = ${JSON.stringify(catalogInput.core.events, null, 2)} as const;\n`
    + `export const PROTOCOL_ERROR_CODES = ${JSON.stringify(Object.keys(catalogInput.core.errors), null, 2)} as const;\n`
    + `export const PROTOCOL_VERSION_AXES = ${JSON.stringify(catalogInput.core.version_axes, null, 2)} as const;\n`
    + `export const PROTOCOL_SURFACE_FIELDS = ${JSON.stringify(surfaceFields, null, 2)} as const;\n\n`
    + `export type ProtocolNounName = (typeof PROTOCOL_NOUN_NAMES)[number];\n`
    + `export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];\n`
    + `export type ProtocolSurfaceName = keyof typeof PROTOCOL_SURFACE_FIELDS;\n`;
  return bindings;
}

function buildMarkdown(catalogInput) {
  const lines = [
    "# Generated Seedrop v2 protocol catalog",
    "",
    "> Generated by `protocol/scripts/generate-protocol-artifacts.mjs`. Do not edit by hand.",
    "",
    `Inventory version: \`${catalogInput.core.inventory_version}\``,
    "",
    "## Completeness",
    "",
    "| Noun | Authority | Status | Implemented surfaces | Explicit gaps |",
    "|---|---|---|---|---|",
    ...catalogInput.core.ontology.map((nounEntry) => `| ${nounEntry.name} | ${nounEntry.authority} | ${nounEntry.contract_status} | ${nounEntry.implemented_surfaces.join(", ") || "—"} | ${nounEntry.gap_ids.join(", ") || "—"} |`),
    "",
    "## Public top-level shapes",
    "",
    "| Shape | Role | Source | Required fields | Optional fields |",
    "|---|---|---|---|---|",
    ...catalogInput.surface_shapes.map((shape) => {
      const surface = catalogInput.core.surfaces.find((candidate) => candidate.name === shape.name);
      const required = shape.fields.filter((field) => !field.optional).map((field) => field.name).join(", ") || "—";
      const optional = shape.fields.filter((field) => field.optional).map((field) => field.name).join(", ") || "—";
      return `| ${shape.name} | ${surface.role} | \`${shape.source_file}\` | ${required} | ${optional} |`;
    }),
    "",
    "## Lifecycle transitions",
    "",
  ];
  for (const [name, lifecycle] of Object.entries(catalogInput.core.lifecycles)) {
    lines.push(`### ${titleCase(name)}`, "", "| From | To |", "|---|---|");
    for (const [from, to] of Object.entries(lifecycle.transitions)) lines.push(`| ${from} | ${to.join(", ") || "terminal"} |`);
    lines.push("");
  }
  lines.push(
    "## Open registries and explicit gaps",
    "",
    `- Event registry closure: **${catalogInput.core.events.closure}** (${catalogInput.core.events.registered.length} registered proposal type).`,
    `- Command registry closure: **${catalogInput.core.commands.closure}** (${catalogInput.core.commands.registered.length} native commands frozen).`,
    "",
    ...catalogInput.core.gaps.map((gapEntry) => `- \`${gapEntry.id}\` (${gapEntry.boundary}): ${gapEntry.reason}`),
    "",
    "## Export boundary",
    "",
    `- ${catalogInput.coverage.public_value_export_count} public value exports.`,
    `- ${catalogInput.coverage.public_type_export_count} public type exports.`,
    "- Every export is enumerated in `protocol-catalog.json`; the generated schema intentionally covers registered top-level data surfaces, not helper inputs or semantic validation.",
    "",
  );
  return lines.join("\n");
}

function stableJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function titleCase(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
