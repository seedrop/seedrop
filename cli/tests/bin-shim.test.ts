import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const shimPath = join(cliRoot, "bin", "seed.mjs");

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
});
