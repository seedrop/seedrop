import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("@seedrop/outcomes package contract", () => {
  it("depends only on protocol and exposes no writer authority", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies).toEqual({ "@seedrop/protocol": "^0.1.0-alpha.1" });
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/publish|commit|execute/);
  });
});
