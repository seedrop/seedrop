#!/usr/bin/env node
// Source-first launcher: run mcp/src/cli.ts directly via tsx.
// See cli/bin/seed.mjs for the SEEDROP_SHIM_INVOKE rationale.
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.SEEDROP_SHIM_INVOKE = "1";
const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, "..", "src", "cli.ts");
await tsImport(entrypoint, import.meta.url);
