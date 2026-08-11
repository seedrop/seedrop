#!/usr/bin/env node

await import("./verify-golden.mjs");
await import("./verify-health-golden.mjs");
await import("./verify-command-recovery-golden.mjs");
await import("./verify-observability-golden.mjs");
await import("./verify-protocol-generation.mjs");
await import("./verify-state-model-proof.mjs");

process.stdout.write(`${JSON.stringify({
  ok: true,
  node: process.version,
  suite: "protocol-runtime-goldens",
  vectors: ["base", "health", "command-recovery", "observability", "protocol-generation", "state-model"],
})}\n`);
