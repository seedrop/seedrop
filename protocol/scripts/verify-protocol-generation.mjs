#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(packageRoot, "scripts/generate-protocol-artifacts.mjs"), "--check"], {
  cwd: packageRoot,
  stdio: "inherit",
});

const protocol = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);
const fixture = JSON.parse(await readFile(join(packageRoot, "fixtures/protocol-generation-v1.json"), "utf8"));
const catalog = JSON.parse(await readFile(join(packageRoot, "generated/protocol-catalog.json"), "utf8"));

for (const [path, expectedDigest] of Object.entries(fixture.sha256)) {
  const bytes = await readFile(join(packageRoot, path));
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) throw new Error(`${path} digest mismatch`);
}
if (protocol.canonicalJson(catalog.core) !== protocol.canonicalJson(protocol.PROTOCOL_INVENTORY_CORE)) {
  throw new Error("generated catalog does not match the runtime inventory");
}
if (catalog.coverage.noun_count !== 9 || catalog.coverage.gap_count === 0) {
  throw new Error("catalog does not account for the frozen ontology and its open gaps");
}

const typeExports = new Set(catalog.public_exports.types.map((entry) => entry.name));
const valueExports = new Set(catalog.public_exports.values.map((entry) => entry.name));
for (const surface of protocol.PROTOCOL_SURFACES) {
  if (!typeExports.has(surface.name)) throw new Error(`surface type is not exported: ${surface.name}`);
  for (const symbol of [surface.version_constant, surface.builder, surface.validator]) {
    if (symbol && !valueExports.has(symbol)) throw new Error(`surface symbol is not exported: ${symbol}`);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  node: process.version,
  suite: "protocol-generation-v1",
  counts: catalog.coverage,
  artifacts: Object.keys(fixture.sha256).length,
})}\n`);
