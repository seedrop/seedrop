#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectBenchState, defaultSpaceUrl } from "./state.js";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const long = `--${name}`;
  const idx = argv.indexOf(long);
  if (idx >= 0) return argv[idx + 1];
  const prefix = `${long}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function defaultPassportPath(): string {
  return process.env.SEEDROP_PASSPORT
    ?? path.join(homedir(), ".seedrop", "id", "passport.json");
}

export async function runObserveCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`Usage: seedrop-observe [--passport <path>] [--space-url <url>] [--json]

Collect read-only Seedrop machine/project state as JSON.
`);
    return 0;
  }

  const passportPath = flagValue(argv, "passport") ?? defaultPassportPath();
  const spaceUrlFlag = flagValue(argv, "space-url");
  const spaceUrl = spaceUrlFlag === "null" || spaceUrlFlag === "none"
    ? null
    : spaceUrlFlag === undefined
      ? defaultSpaceUrl()
      : spaceUrlFlag;

  try {
    const state = await collectBenchState({ passportPath, spaceUrl });
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`seedrop-observe: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    return 1;
  }
}

if (isInvokedAsScript(import.meta.url)) {
  process.exitCode = await runObserveCli(process.argv.slice(2));
}

function isInvokedAsScript(metaUrl: string): boolean {
  if (process.env.SEEDROP_SHIM_INVOKE === "1") return true;
  const entry = process.argv[1];
  if (!entry) return false;
  const target = fileURLToPath(metaUrl);
  if (entry === target) return true;
  try {
    return realpathSync(entry) === target;
  } catch {
    return false;
  }
}
