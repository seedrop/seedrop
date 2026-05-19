import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const idRoot = join(here, "..");
const seedIdShim = join(idRoot, "bin", "seed-id.mjs");

let scratch: string;
let passportPath: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "seedrop-id-shim-"));
  passportPath = join(scratch, "passport.json");
  // Use the shim's own `init` command to write a valid passport. This is
  // also a positive smoke test that the shim's stdio works at all.
  const init = spawnSync(
    process.execPath,
    [seedIdShim, "init", "--name", "test", "--purpose", "before", "--out", passportPath],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (init.status !== 0) {
    throw new Error(`fixture init failed: ${init.stderr}`);
  }
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("seed-id bin shim integration (codex's no-output regression)", () => {
  it("produces stdout when invoked via the bin shim — proves SEEDROP_SHIM_INVOKE bridges tsImport", () => {
    const result = spawnSync(
      process.execPath,
      [seedIdShim, "show", "--passport", passportPath],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/agent_id: test/);
    expect(result.stdout).toMatch(/purpose: before/);
  }, 30_000);

  it("--json invocation via the shim returns parseable JSON", () => {
    const result = spawnSync(
      process.execPath,
      [seedIdShim, "update", "--passport", passportPath, "--purpose", "after", "--json"],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.changed).toBe(true);
    expect(parsed.changes?.purpose?.from).toBe("before");
    expect(parsed.changes?.purpose?.to).toBe("after");
  }, 30_000);

  it("invoking without SEEDROP_SHIM_INVOKE (simulating import-as-library) does NOT run the CLI", () => {
    // We can't easily run cli.ts without going through the shim, but we can
    // confirm the env signal is what gates invocation: spawn the shim with
    // the env var explicitly unset and observe the same no-op behavior the
    // bug reported. (Negative control for the fix.)
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `
        // Strip SEEDROP_SHIM_INVOKE that the shim would set, then tsImport
        // cli.ts directly. The guard should refuse to run.
        delete process.env.SEEDROP_SHIM_INVOKE;
        const { tsImport } = await import("tsx/esm/api");
        await tsImport(${JSON.stringify(join(idRoot, "src", "cli.ts"))}, import.meta.url);
        console.log("loaded-without-side-effect");
      `],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    // No CLI help / error output should have run; only our literal log.
    expect(result.stdout.trim()).toBe("loaded-without-side-effect");
  }, 30_000);
});
