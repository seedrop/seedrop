#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const targetArch = process.argv.find((argument) => argument.startsWith("--arch="))?.slice("--arch=".length)
  ?? process.env.SEEDROP_DESKTOP_ARCH
  ?? (process.arch === "arm64" ? "arm64" : "x64");
const release = path.resolve(
  process.env.SEEDROP_DESKTOP_RELEASE
    ?? path.join(here, "..", "src-tauri", "resources", "release"),
);
const manifest = JSON.parse(await readFile(path.join(release, "runtime-manifest.json"), "utf8"));

function runtimePaths(root) {
  const modules = path.join(root, "payload", "node_modules");
  return {
    root,
    node: path.join(root, "node", "bin", "node"),
    cli: path.join(modules, "@seedrop", "cli", "dist", "cli.js"),
    cliIndex: path.join(modules, "@seedrop", "cli", "dist", "index.js"),
    cliRouter: path.join(modules, "@seedrop", "cli", "dist", "router.js"),
    observer: path.join(modules, "@seedrop", "observer", "dist", "cli.js"),
    bin: path.join(modules, ".bin"),
  };
}

function run(args, options = {}) {
  const runtime = options.runtime ?? runtimePaths(release);
  const result = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      HOME: options.home,
      PATH: `${runtime.bin}:${path.dirname(runtime.node)}:/usr/bin:/bin`,
      SEEDROP_SPACE_URL: "http://127.0.0.1:1",
    },
    timeout: 30_000,
  });
  return result;
}

async function startSealedDaemon({ runtime, home, passport, dataRoot, buildHash }) {
  const child = spawn(runtime.node, [
    runtime.cli,
    "space",
    "serve",
    "--passport",
    passport,
    "--data-dir",
    dataRoot,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--json",
    "--runtime-profile",
    "sealed",
    "--runtime-root",
    runtime.root,
    "--runtime-version",
    manifest.version,
    "--build-hash",
    buildHash,
    "--runtime-source-hash",
    manifest.sourceHash,
  ], {
    cwd: dataRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      SEEDROP_PASSPORT: passport,
      SEEDROP_SPACE_ROOT: dataRoot,
    },
  });
  let stdout = "";
  let stderr = "";
  const listening = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`sealed daemon did not start: ${stderr}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`sealed daemon exited before listening (${code}): ${stderr}`));
    });
  });
  return { child, listening };
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("sealed daemon did not stop")), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

test("release payload is host-specific and npm-free", async () => {
  assert.equal(manifest.platform, "darwin");
  assert.equal(manifest.arch, targetArch);
  assert.equal(await readFile(path.join(release, "node", ".seedrop-node.json"), "utf8").then(JSON.parse).then((value) => value.arch), manifest.arch);
  assert.equal(manifest.entries.some((entry) => entry.path.includes("node/lib/node_modules/npm")), false);
  assert.equal(manifest.entries.some((entry) => entry.path.includes(`node-darwin-${manifest.arch === "arm64" ? "x64" : "arm64"}`)), false);
  assert.equal(manifest.entries.some((entry) => entry.kind === "symlink"), false);
  assert.equal(manifest.entries.some((entry) => entry.path.includes("payload/node_modules/tsx")), false);
  assert.equal(manifest.entries.some((entry) => entry.path.includes("payload/node_modules/@esbuild")), false);
  const provenance = JSON.parse(await readFile(path.join(release, "runtime-provenance.json"), "utf8"));
  assert.equal(provenance.node.version, manifest.nodeVersion);
  assert.equal(provenance.packages.some((entry) => String(entry.location).includes("node_modules/better-sqlite3")), true);
  assert.equal(JSON.stringify(provenance).includes(os.tmpdir()), false);
});

test("sealed runtime initializes and links a first project with no system Node", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "seedrop-desktop-clean-home-"));
  const home = path.join(scratch, "home");
  const project = path.join(scratch, "project");
  try {
    const isolatedRelease = path.join(scratch, "runtime");
    await cp(release, isolatedRelease, { recursive: true });
    const runtime = runtimePaths(isolatedRelease);
    const mkdir = spawnSync("/bin/mkdir", ["-p", home, project], { encoding: "utf8" });
    assert.equal(mkdir.status, 0, mkdir.stderr);
    const git = spawnSync("/usr/bin/git", ["init", "-q", project], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);

    const init = run([runtime.node, runtime.cli, "init", "--name", "desktop-test", "--purpose", "Artifact verification", "--yes", "--no-install", "--no-daemon"], { home, runtime });
    assert.equal(init.status, 0, `${init.stdout}\n${init.stderr}`);

    const setupPath = path.join(home, ".seedrop", "state", "setup.json");
    const interrupted = JSON.parse(await readFile(setupPath, "utf8"));
    const setupId = interrupted.setup_id;
    interrupted.status = "failed";
    const finalStep = interrupted.steps.find((step) => step.id === "boot_protocol");
    finalStep.status = "failed";
    finalStep.error = "simulated interruption after earlier steps completed";
    await writeFile(setupPath, `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    const resumed = run([runtime.node, runtime.cli, "init", "--resume", "--name", "desktop-test", "--purpose", "Artifact verification", "--yes", "--no-install", "--no-daemon"], { home, runtime });
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.match(resumed.stdout, new RegExp(`resuming setup: ${setupId}`));
    const completed = JSON.parse(await readFile(setupPath, "utf8"));
    assert.equal(completed.setup_id, setupId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps.find((step) => step.id === "boot_protocol").status, "completed");

    const bootstrap = run([runtime.node, runtime.cli, "bootstrap"], { home, cwd: project, runtime });
    assert.equal(bootstrap.status, 0, `${bootstrap.stdout}\n${bootstrap.stderr}`);

    const observed = run([runtime.node, runtime.observer, "--passport", path.join(home, ".seedrop", "id", "passport.json"), "--space-url", "none"], { home, runtime });
    assert.equal(observed.status, 0, `${observed.stdout}\n${observed.stderr}`);
    const state = JSON.parse(observed.stdout);
    assert.equal(state.projects.length, 1);
    assert.equal(state.projects[0].root, await realpath(project));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("sealed runtime adopts an npm-era setup without rewriting shared state", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "seedrop-desktop-adopt-home-"));
  const home = path.join(scratch, "home");
  try {
    await mkdir(path.join(home, ".seedrop", "id"), { recursive: true });
    await mkdir(path.join(home, ".seedrop", "space"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const passportPath = path.join(home, ".seedrop", "id", "passport.json");
    const spacePath = path.join(home, ".seedrop", "space", "legacy.db");
    const configPath = path.join(home, ".codex", "config.toml");
    await writeFile(passportPath, '{"schema_version":"1.0","agent_id":"legacy","name":"Legacy"}\n');
    await writeFile(spacePath, "durable-existing-space-data\n");
    await writeFile(configPath, '[mcp_servers.seedrop]\ncommand = "/npm/node"\nargs = ["/npm/seed-mcp"]\n');
    const before = await Promise.all([passportPath, spacePath, configPath].map((file) => readFile(file)));

    const runtime = runtimePaths(release);
    const adoption = run([runtime.node, runtime.cli, "init", "--adopt-existing", "--yes"], { home, runtime });
    assert.equal(adoption.status, 0, `${adoption.stdout}\n${adoption.stderr}`);
    const after = await Promise.all([passportPath, spacePath, configPath].map((file) => readFile(file)));
    assert.deepEqual(after, before);
    const journal = JSON.parse(await readFile(path.join(home, ".seedrop", "state", "setup.json"), "utf8"));
    assert.equal(journal.status, "completed");
    assert.equal(journal.mode, "adopted_existing");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("sealed daemon restarts from its copied runtime with source and toolchain unavailable", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "seedrop-desktop-daemon-restart-"));
  const home = path.join(scratch, "home");
  const dataRoot = path.join(home, ".seedrop", "space");
  const passport = path.join(home, ".seedrop", "id", "passport.json");
  const isolatedRelease = path.join(scratch, "sealed-runtime");
  let running;
  try {
    await cp(release, isolatedRelease, { recursive: true });
    await mkdir(path.dirname(passport), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(passport, '{"schema_version":"1.0","agent_id":"sealed-daemon","name":"Sealed Daemon"}\n');
    const runtime = runtimePaths(isolatedRelease);
    const manifestBytes = await readFile(path.join(isolatedRelease, "runtime-manifest.json"));
    const buildHash = createHash("sha256").update(manifestBytes).digest("hex");

    const identityProbe = run([
      runtime.node,
      "--input-type=module",
      "-e",
      `import { resolveDaemonRuntimeIdentity } from ${JSON.stringify(pathToFileURL(runtime.cliIndex).href)}; console.log(JSON.stringify(await resolveDaemonRuntimeIdentity(${JSON.stringify({ routerPath: runtime.cliRouter, nodePath: runtime.node })})))`,
    ], { home, runtime, cwd: dataRoot });
    assert.equal(identityProbe.status, 0, `${identityProbe.stdout}\n${identityProbe.stderr}`);
    assert.deepEqual(JSON.parse(identityProbe.stdout), {
      profile: "sealed",
      node: runtime.node,
      seedBin: runtime.cli,
      runtimeRoot: isolatedRelease,
      version: manifest.version,
      buildHash,
      sourceHash: manifest.sourceHash,
      manifestPath: path.join(isolatedRelease, "runtime-manifest.json"),
    });

    const systemNode = spawnSync("/usr/bin/env", ["node", "--version"], {
      encoding: "utf8",
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    assert.notEqual(systemNode.status, 0, "the proof environment unexpectedly exposes a system Node");

    const sourceNeedle = Buffer.from(`${repoRoot}${path.sep}`);
    const executableGraph = manifest.entries.filter((entry) =>
      entry.path === "node/bin/node"
      || entry.path.includes("payload/node_modules/.bin/")
      || (/^payload\/node_modules\/@seedrop\/[^/]+\/dist\//).test(entry.path)
      || entry.path.endsWith("better-sqlite3/build/Release/better_sqlite3.node")
    );
    assert.ok(executableGraph.length > 10, "sealed executable graph is unexpectedly small");
    for (const entry of executableGraph) {
      const bytes = await readFile(path.join(isolatedRelease, entry.path));
      assert.equal(bytes.includes(sourceNeedle), false, `payload embeds source workspace path: ${entry.path}`);
    }

    running = await startSealedDaemon({ runtime, home, passport, dataRoot, buildHash });
    const firstHealth = await fetch(`${running.listening.url}/health`).then((response) => response.json());
    assert.deepEqual({
      version: firstHealth.version,
      buildHash: firstHealth.build_hash,
      profile: firstHealth.runtime_profile,
      runtimeRoot: firstHealth.runtime_root,
      sourceHash: firstHealth.runtime_source_hash,
      dataRoot: firstHealth.data_root,
    }, {
      version: manifest.version,
      buildHash,
      profile: "sealed",
      runtimeRoot: isolatedRelease,
      sourceHash: manifest.sourceHash,
      dataRoot,
    });
    await stopDaemon(running.child);
    running = undefined;

    running = await startSealedDaemon({ runtime, home, passport, dataRoot, buildHash });
    const restartedHealth = await fetch(`${running.listening.url}/health`).then((response) => response.json());
    assert.equal(restartedHealth.ok, true);
    assert.equal(restartedHealth.build_hash, buildHash);
    assert.equal(restartedHealth.runtime_profile, "sealed");
  } finally {
    if (running) await stopDaemon(running.child);
    await rm(scratch, { recursive: true, force: true });
  }
});
