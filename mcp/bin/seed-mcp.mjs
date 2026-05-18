#!/usr/bin/env node
// Source-first launcher: run mcp/src/cli.ts directly via tsx.
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, "..", "src", "cli.ts");
await tsImport(entrypoint, import.meta.url);
