import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const shimPath = join(cliRoot, "bin", "seed.mjs");
const packageJsonPath = join(cliRoot, "package.json");

describe("cli source-first shim", () => {
  it("seed.mjs launches the source CLI without requiring dist/", () => {
    const result = spawnSync(process.execPath, [shimPath, "help"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/seed bootstrap/);
    expect(result.stdout).toMatch(/seed continuity/);
  }, 30_000);

  it("publishes seedrop as an alias for the seed shim", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    expect(pkg.bin).toMatchObject({
      seed: "./bin/seed.mjs",
      seedrop: "./bin/seed.mjs",
    });
  });
});
