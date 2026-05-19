#!/usr/bin/env node
// Source-first launcher: run cli/src/cli.ts directly via tsx.
// No build step required for development. `npm run build` is still
// available for release tarballs but not part of the dev loop.
// SEEDROP_SHIM_INVOKE=1 tells any guarded entrypoint that we ARE the
// script invocation even though argv[1] points at this shim, not the
// underlying source. Defensive: today only id's CLI guards; future
// workspaces could adopt the same pattern.
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.SEEDROP_SHIM_INVOKE = "1";
const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, "..", "src", "cli.ts");
await tsImport(entrypoint, import.meta.url);
