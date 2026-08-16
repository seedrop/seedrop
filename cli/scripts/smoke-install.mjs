#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const monorepoRoot = resolve(cliRoot, "..");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const icon = status === "pass" ? "✓" : "✗";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`  ${icon} ${name}${suffix}`);
}

async function run(cwd, cmd, args, env = {}) {
  return execFileAsync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function pack(pkgRoot, outDir, env) {
  const { stdout } = await run(pkgRoot, "npm", ["pack", "--pack-destination", outDir, "--silent"], env);
  const file = stdout.trim().split(/\s+/).pop();
  if (!file) throw new Error(`npm pack produced no filename for ${pkgRoot}`);
  return join(outDir, file);
}

// The consumer installs @seedrop/cli from tarballs, so every local @seedrop/*
// package in its dependency closure must be packed alongside: npm cannot fall
// back to the registry for unpublished workspace packages.
async function localDependencyClosure() {
  const rootManifest = JSON.parse(await readFile(join(monorepoRoot, "package.json"), "utf8"));
  const workspaceOrder = rootManifest.workspaces ?? [];
  const byName = new Map();
  for (const dir of workspaceOrder) {
    const manifest = JSON.parse(await readFile(join(monorepoRoot, dir, "package.json"), "utf8"));
    if (manifest.name) byName.set(manifest.name, { dir: join(monorepoRoot, dir), order: workspaceOrder.indexOf(dir) });
  }

  const queue = ["@seedrop/cli"];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const name = queue.shift();
    const entry = byName.get(name);
    if (!entry) throw new Error(`${name} is not a local workspace package; it cannot be resolved from tarballs`);
    const manifest = JSON.parse(await readFile(join(entry.dir, "package.json"), "utf8"));
    for (const depName of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (depName.startsWith("@seedrop/") && !seen.has(depName)) {
        seen.add(depName);
        queue.push(depName);
      }
    }
  }

  seen.delete("@seedrop/cli");
  return [...seen]
    .map((name) => ({ name, ...byName.get(name) }))
    .sort((a, b) => a.order - b.order)
    .map(({ name, dir }) => ({ name, dir }));
}

async function main() {
  console.log("seed cli install smoke (no PATH shims)");
  console.log("───────────────────────────────────────");

  const closure = await localDependencyClosure();
  closure.push({ name: "@seedrop/cli", dir: cliRoot });

  for (const { name, dir } of closure) {
    if (!existsSync(join(dir, "dist"))) {
      throw new Error(`Missing dist for ${name}. Run \`npm run build\` in each workspace first.`);
    }
  }

  const temp = await mkdtemp(join(os.tmpdir(), "seed-install-smoke-"));
  const tarDir = join(temp, "tarballs");
  const cacheDir = join(temp, "npm-cache");
  const projectDir = join(temp, "consumer");
  await mkdir(tarDir);
  await mkdir(cacheDir);
  await mkdir(projectDir);
  const npmEnv = { npm_config_cache: cacheDir };

  try {
    const tarballs = {};
    for (const { name, dir } of closure) {
      const tar = await pack(dir, tarDir, npmEnv);
      tarballs[name] = tar;
      record(`packed ${name}`, "pass", tar.replace(tarDir + "/", ""));
    }

    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "seed-install-smoke-consumer",
        version: "0.0.0",
        private: true,
        dependencies: Object.fromEntries(closure.map(({ name }) => [name, `file:${tarballs[name]}`])),
      }, null, 2),
    );

    await run(projectDir, "npm", ["install", "--no-audit", "--no-fund", "--silent"], npmEnv);
    record(`npm install ${closure.length} tarballs`, "pass");

    const seedBin = join(projectDir, "node_modules", ".bin", "seed");
    if (!existsSync(seedBin)) throw new Error(`expected ${seedBin} after install`);
    record("seed binary is on disk", "pass", seedBin.replace(projectDir + "/", ""));
    await access(seedBin, constants.X_OK);
    record("seed binary is executable", "pass");

    const passport = join(projectDir, ".seedrop", "id", "passport.json");

    const init = await run(projectDir, seedBin, [
      "id", "init",
      "--name", "claude",
      "--purpose", "install smoke",
      "--out", passport,
    ]);
    if (!init.stdout.includes("created passport")) throw new Error(`id init: ${init.stdout}`);
    record("seed id init writes passport", "pass");

    const validate = await run(projectDir, seedBin, ["id", "validate", passport]);
    if (!validate.stdout.includes("valid passport")) throw new Error(`id validate: ${validate.stdout}`);
    record("seed id validate passport", "pass");

    const view = await run(projectDir, seedBin, [
      "view", "init",
      "--passport", passport,
      "--role", "builder",
      "--current-focus", "install smoke",
    ]);
    if (!view.stdout.includes("linked active project")) throw new Error(`view init: ${view.stdout}`);
    record("seed view init composes id + space", "pass");

    const context = await run(projectDir, seedBin, ["view", "context", "--json"]);
    const parsed = JSON.parse(context.stdout);
    if (!parsed.manifest?.workspace_id) throw new Error(`view context shape: ${context.stdout}`);
    record("seed view context reads manifest", "pass");

    // The published bin remains source-first today, but compiled consumers
    // (including Desktop's sealed runtime) must dispatch to sibling dist CLIs
    // without being rescued by the development-only tsx package.
    await rm(join(projectDir, "node_modules", "tsx"), { recursive: true, force: true });
    await rm(join(projectDir, "node_modules", "esbuild"), { recursive: true, force: true });
    await rm(join(projectDir, "node_modules", "@esbuild"), { recursive: true, force: true });
    const compiledCli = join(projectDir, "node_modules", "@seedrop", "cli", "dist", "cli.js");
    const compiled = await run(projectDir, process.execPath, [compiledCli, "id", "show", "--passport", passport]);
    if (!compiled.stdout.includes("claude")) throw new Error(`compiled id show: ${compiled.stdout}`);
    record("compiled CLI dispatch is tsx-independent", "pass");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  console.log("───────────────────────────────────────");
  console.log(`pass:${pass}  fail:${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error("install smoke failed:", error?.stderr || error?.stdout || error?.message || String(error));
  process.exit(1);
});
