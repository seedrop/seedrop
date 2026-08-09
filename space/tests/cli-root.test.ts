import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

let child: ChildProcess | undefined;
let fixture: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
  }
  child = undefined;
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

describe("seed-space serve data root", () => {
  it("treats legacy --root as the resolved daemon data directory", async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-cli-root-"));
    const canonicalRoot = path.join(fixture, "space");
    const passportPath = path.join(fixture, "passport.json");
    await writeFile(passportPath, JSON.stringify({ agent_id: "operator", name: "Operator" }));

    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/seed-space.mjs", import.meta.url)),
        "serve",
        "--passport",
        passportPath,
        "--root",
        canonicalRoot,
        "--port",
        "0",
        "--json",
      ],
      { cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] },
    );

    const listening = await readListeningEvent(child);
    const response = await fetch(`${listening.url}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": "operator", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const health = await fetch(`${listening.url}/health`).then((result) => result.json()) as { data_root: string };
    expect(health.data_root).toBe(canonicalRoot);
    await expect(access(path.join(canonicalRoot, "live.db"))).resolves.toBeUndefined();
    await expect(access(path.join(canonicalRoot, ".seedrop", "space", "live.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function readListeningEvent(process: ChildProcess): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for seed-space: ${stderr}`)), 5_000);
    process.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as { url: string });
      } catch (error) {
        reject(error);
      }
    });
    process.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`seed-space exited before listening (${code}): ${stderr}`));
    });
  });
}
