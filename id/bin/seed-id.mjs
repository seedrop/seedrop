#!/usr/bin/env node
// Source-first launcher: run id/src/cli.ts directly via tsx.
// Sets SEEDROP_SHIM_INVOKE=1 so the source's "am I a script?" guard
// recognizes this invocation. Without it the guard fails under tsImport
// (argv[1] points at this shim, not the source) and the CLI silently
// no-ops — exactly codex's reported "no output" bug.
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.SEEDROP_SHIM_INVOKE = "1";
const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, "..", "src", "cli.ts");
await tsImport(entrypoint, import.meta.url);
