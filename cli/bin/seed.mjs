#!/usr/bin/env node
// Source-first launcher: run cli/src/cli.ts directly via tsx.
// No build step required for development. `npm run build` is still
// available for release tarballs but not part of the dev loop.
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, "..", "src", "cli.ts");
await tsImport(entrypoint, import.meta.url);
