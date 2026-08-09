#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const observe = path.join(here, "..", "..", "observer", "bin", "observe.mjs");
const passport = process.env.SEEDROP_PASSPORT
  ?? path.join(homedir(), ".seedrop", "id", "passport.json");

const result = spawnSync(process.execPath, [observe, "--passport", passport], {
  encoding: "utf8",
  env: { ...process.env },
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "observe failed\n");
  process.exit(result.status ?? 1);
}

const state = JSON.parse(result.stdout);
if (!state.projects || !Array.isArray(state.projects)) {
  process.stderr.write("observe smoke: missing projects array\n");
  process.exit(1);
}

process.stdout.write(
  `smoke ok: ${state.projects.length} project(s), daemon=${state.daemon?.reachable ?? false}\n`,
);
