import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { observeRepositorySources, planIncrementalObservation } from "../src/index.js";

describe("repository content observation", () => {
  it("plans a 38k-file index by hashing only the changed file", () => {
    const previous = { version: 1 as const, files: Object.fromEntries(Array.from({ length: 38_000 }, (_, index) => {
      const name = `src/${index.toString().padStart(5, "0")}.ts`;
      return [name, { path: name, size: 10, mtime_ms: 1, digest: `sha256:${"a".repeat(64)}` }];
    })) };
    const inventory = Object.values(previous.files).map(({ path, size, mtime_ms }) => ({ path, size, mtime_ms }));
    inventory[20_000] = { ...inventory[20_000]!, mtime_ms: 2 };
    const plan = planIncrementalObservation(inventory, previous);
    expect(plan.hash).toEqual(["src/20000.ts"]);
    expect(plan.reuse).toHaveLength(37_999);
  });

  it("makes bounded fallback and incremental reuse explicit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seedrop-observer-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "one");
    const sources = [{ source_id: "git:worktree", kind: "git" as const, path: "src" }];
    const first = await observeRepositorySources({ root, sources, max_files: 1 });
    expect(first).toMatchObject({ mode: "full_fallback", fallback_reason: "index_missing", scanned_files: 1, reused_files: 0 });
    const second = await observeRepositorySources({ root, sources, previous: first.index, max_files: 1 });
    expect(second).toMatchObject({ mode: "incremental", fallback_reason: null, scanned_files: 0, reused_files: 1 });
    await writeFile(path.join(root, "src", "b.ts"), "two");
    await expect(observeRepositorySources({ root, sources, previous: second.index, max_files: 1 })).rejects.toThrow("max_files=1");
  });
});
