#!/usr/bin/env node
// Production launcher. Development remains source-first through `tsx src/cli.ts`.
process.env.SEEDROP_SHIM_INVOKE = "1";
await import("../dist/cli.js");
