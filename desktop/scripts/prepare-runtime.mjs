#!/usr/bin/env node
/**
 * Build the sealed, architecture-specific Desktop runtime.
 *
 * This is a release-build operation. First launch never runs npm or reaches the
 * network: it copies and verifies this payload into Application Support.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const runtimeDependenciesRoot = path.join(desktopRoot, "runtime");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const releaseRoot = path.join(resourcesRoot, "release");
const hostArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
const arch = flagValue("arch") ?? process.env.SEEDROP_DESKTOP_ARCH ?? hostArch;
const platform = process.platform;
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const runtimeVersion = packageJson.version;

if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) {
  throw new Error(`Desktop runtime preparation requires macOS arm64/x64; got ${platform}/${arch ?? process.arch}`);
}

function flagValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const nodeSource = path.join(resourcesRoot, "runtime", `node-darwin-${arch}`);
const nodeMetadataPath = path.join(nodeSource, ".seedrop-node.json");
const manifestPath = path.join(releaseRoot, "runtime-manifest.json");
const packageWorkspaces = ["@seedrop/id", "@seedrop/space", "@seedrop/cli", "@seedrop/mcp", "@seedrop/observer"];
const sourceInputs = [
  "cli/src", "cli/templates", "cli/clients.json", "cli/package.json",
  "id/src", "id/package.json",
  "space/src", "space/package.json",
  "mcp/src", "mcp/package.json",
  "observer/src", "observer/package.json",
  "package-lock.json",
  "desktop/runtime/package.json", "desktop/runtime/package-lock.json",
  "desktop/scripts/prepare-runtime.mjs",
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listTree(root, prefix = "") {
  const absolute = path.join(root, prefix);
  const entries = await readdir(absolute, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    result.push(relative);
    if (entry.isDirectory()) result.push(...await listTree(root, relative));
  }
  return result;
}

async function hashSourceInputs() {
  const hash = createHash("sha256");
  for (const input of sourceInputs) {
    const absolute = path.join(repoRoot, input);
    const stat = await lstat(absolute);
    const files = stat.isDirectory() ? await listTree(absolute) : [""];
    for (const relative of files) {
      const filePath = relative ? path.join(absolute, relative) : absolute;
      const fileStat = await lstat(filePath);
      if (!fileStat.isFile()) continue;
      hash.update(`${input}/${relative}\0`);
      hash.update(await readFile(filePath));
    }
  }
  return hash.digest("hex");
}

async function manifestEntries(root) {
  const paths = (await listTree(root)).filter((relative) => relative !== "runtime-manifest.json");
  const entries = [];
  for (const relative of paths) {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`release payload must not contain symlinks: ${relative}`);
    } else if (stat.isFile()) {
      entries.push({
        path: relative,
        kind: "file",
        sha256: sha256(await readFile(absolute)),
        executable: Boolean(stat.mode & 0o111),
      });
    }
  }
  return entries;
}

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function verifyRelease(expectedSourceHash) {
  const manifest = await readManifest();
  const nodeMetadata = JSON.parse(await readFile(nodeMetadataPath, "utf8"));
  if (manifest.schemaVersion !== "1.0") throw new Error(`unsupported runtime manifest ${manifest.schemaVersion}`);
  if (manifest.version !== runtimeVersion || manifest.arch !== arch || manifest.platform !== platform) {
    throw new Error(`runtime identity mismatch: ${manifest.version}/${manifest.platform}/${manifest.arch}`);
  }
  if (manifest.nodeVersion !== nodeMetadata.version || manifest.nodeArchiveSha256 !== nodeMetadata.archiveSha256) {
    throw new Error("runtime Node provenance does not match the verified download");
  }
  if (expectedSourceHash && manifest.sourceHash !== expectedSourceHash) {
    throw new Error("runtime payload is stale relative to Seedrop sources");
  }
  for (const entry of manifest.entries) {
    const absolute = path.join(releaseRoot, entry.path);
    const stat = await lstat(absolute);
    const actual = stat.isFile() ? sha256(await readFile(absolute)) : "invalid";
    if (actual !== entry.sha256) throw new Error(`runtime integrity mismatch: ${entry.path}`);
  }
  for (const required of [
    "node/bin/node",
    "payload/node_modules/@seedrop/cli/dist/cli.js",
    "payload/node_modules/@seedrop/mcp/dist/cli.js",
    "payload/node_modules/@seedrop/observer/dist/cli.js",
    "payload/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  ]) {
    if (!(await exists(path.join(releaseRoot, required)))) throw new Error(`runtime component missing: ${required}`);
  }
  return manifest;
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function writeRuntimeBins() {
  const binRoot = path.join(releaseRoot, "payload", "node_modules", ".bin");
  await rm(binRoot, { recursive: true, force: true });
  await mkdir(binRoot, { recursive: true });
  const bins = {
    seed: "@seedrop/cli/dist/cli.js",
    seedrop: "@seedrop/cli/dist/cli.js",
    "seed-id": "@seedrop/id/dist/cli.js",
    "seed-space": "@seedrop/space/dist/cli.js",
    "seed-mcp": "@seedrop/mcp/dist/cli.js",
    "seedrop-observe": "@seedrop/observer/dist/cli.js",
  };
  for (const [name, target] of Object.entries(bins)) {
    const binPath = path.join(binRoot, name);
    await writeFile(binPath, `#!/usr/bin/env node\nawait import("../${target}");\n`, "utf8");
    await chmod(binPath, 0o755);
  }
}

async function slimPayload(nodeMetadata) {
  const payloadRoot = path.join(releaseRoot, "payload");
  const modulesRoot = path.join(payloadRoot, "node_modules");
  const lock = JSON.parse(await readFile(path.join(payloadRoot, "package-lock.json"), "utf8"));
  const packages = Object.entries(lock.packages ?? {})
    .filter(([location, metadata]) => location.includes("node_modules/") && metadata?.version)
    .map(([location, metadata]) => ({
      location,
      version: metadata.version,
      integrity: metadata.integrity ?? null,
      license: metadata.license ?? null,
    }))
    .sort((left, right) => left.location.localeCompare(right.location));
  await writeFile(
    path.join(releaseRoot, "runtime-provenance.json"),
    `${JSON.stringify({ schemaVersion: "1.0", node: { version: nodeMetadata.version, archiveSha256: nodeMetadata.archiveSha256 }, packages }, null, 2)}\n`,
    "utf8",
  );

  // The workspace packages declare tsx only for source-first development.
  // Production dispatch is compiled JS, so its compiler and platform binary
  // are dead weight and must not enter the app-managed runtime.
  await rm(path.join(modulesRoot, "tsx"), { recursive: true, force: true });
  await rm(path.join(modulesRoot, "esbuild"), { recursive: true, force: true });
  await rm(path.join(modulesRoot, "@esbuild"), { recursive: true, force: true });

  // Keep only the native SQLite product, not the C++ compilation workspace.
  const sqliteRoot = path.join(modulesRoot, "better-sqlite3");
  const nativeAddon = await readFile(path.join(sqliteRoot, "build", "Release", "better_sqlite3.node"));
  await rm(path.join(sqliteRoot, "build"), { recursive: true, force: true });
  await mkdir(path.join(sqliteRoot, "build", "Release"), { recursive: true });
  await writeFile(path.join(sqliteRoot, "build", "Release", "better_sqlite3.node"), nativeAddon);
  for (const developmentPath of ["deps", "src", "binding.gyp"]) {
    await rm(path.join(sqliteRoot, developmentPath), { recursive: true, force: true });
  }

}

async function buildRelease(sourceHash) {
  const nodeBinary = path.join(nodeSource, "bin", "node");
  const npmCli = path.join(nodeSource, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (!(await exists(nodeBinary)) || !(await exists(npmCli))) {
    throw new Error(`verified Node runtime missing for ${arch}; run npm run fetch-runtime first`);
  }
  const nodeMetadata = JSON.parse(await readFile(nodeMetadataPath, "utf8"));

  process.stdout.write(`building Seedrop production packages for ${arch}\n`);
  await run("npm", ["run", "build", "-w", "@seedrop/id", "-w", "@seedrop/space", "-w", "@seedrop/cli", "-w", "@seedrop/mcp", "-w", "@seedrop/observer"]);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "seedrop-desktop-runtime-"));
  try {
    const tarballs = [];
    for (const workspace of packageWorkspaces) {
      const before = new Set(await readdir(scratch));
      await run("npm", ["pack", "--silent", "--pack-destination", scratch, "-w", workspace], {
        env: { npm_config_cache: path.join(os.tmpdir(), "seedrop-desktop-npm-cache") },
      });
      const created = (await readdir(scratch)).find((name) => name.endsWith(".tgz") && !before.has(name));
      if (!created) throw new Error(`npm pack produced no tarball for ${workspace}`);
      tarballs.push(path.join(scratch, created));
    }

    await rm(releaseRoot, { recursive: true, force: true });
    await mkdir(path.join(releaseRoot, "node", "bin"), { recursive: true });
    await cp(nodeBinary, path.join(releaseRoot, "node", "bin", "node"));
    await chmod(path.join(releaseRoot, "node", "bin", "node"), 0o755);
    await cp(path.join(nodeSource, "LICENSE"), path.join(releaseRoot, "node", "LICENSE"));
    await cp(path.join(nodeSource, ".seedrop-node.json"), path.join(releaseRoot, "node", ".seedrop-node.json"));

    const payloadRoot = path.join(releaseRoot, "payload");
    await mkdir(payloadRoot, { recursive: true });
    await cp(path.join(runtimeDependenciesRoot, "package.json"), path.join(payloadRoot, "package.json"));
    await cp(path.join(runtimeDependenciesRoot, "package-lock.json"), path.join(payloadRoot, "package-lock.json"));
    await run(nodeBinary, [npmCli, "ci", "--prefix", payloadRoot, "--omit=dev", "--no-audit", "--no-fund"], {
      env: {
        PATH: `${path.dirname(nodeBinary)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        npm_config_cache: path.join(os.tmpdir(), "seedrop-desktop-npm-cache"),
        npm_config_update_notifier: "false",
      },
    });

    // Local Seedrop packages are installed from freshly packed, compiled
    // workspace artifacts. External dependencies come only from the exact
    // checked-in runtime lockfile above.
    for (let index = 0; index < packageWorkspaces.length; index += 1) {
      const workspace = packageWorkspaces[index];
      const target = path.join(payloadRoot, "node_modules", ...workspace.split("/"));
      await mkdir(target, { recursive: true });
      await run("tar", ["-xzf", tarballs[index], "-C", target, "--strip-components=1"]);
    }

    await slimPayload(nodeMetadata);

    // Tauri dereferences resource symlinks when assembling an app bundle. Keep
    // this payload symlink-free, and use tiny regular-file launchers so their
    // relative imports still resolve after packaging and runtime installation.
    await writeRuntimeBins();

    const entries = await manifestEntries(releaseRoot);
    const manifest = {
      schemaVersion: "1.0",
      version: runtimeVersion,
      platform,
      arch,
      sourceHash,
      nodeVersion: nodeMetadata.version,
      nodeArchiveSha256: nodeMetadata.archiveSha256,
      generatedAt: new Date().toISOString(),
      entries,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const sourceHash = await hashSourceInputs();
if (process.argv.includes("--verify-only")) {
  const manifest = await verifyRelease(sourceHash);
  process.stdout.write(`runtime verified: ${manifest.version} ${manifest.platform}/${manifest.arch}, ${manifest.entries.length} entries\n`);
} else if (process.argv.includes("--if-needed")) {
  try {
    const manifest = await verifyRelease(sourceHash);
    process.stdout.write(`runtime current: ${manifest.version} ${manifest.arch}\n`);
  } catch {
    await buildRelease(sourceHash);
    const manifest = await verifyRelease(sourceHash);
    process.stdout.write(`runtime prepared: ${manifest.version} ${manifest.arch}, ${manifest.entries.length} entries\n`);
  }
} else {
  await buildRelease(sourceHash);
  const manifest = await verifyRelease(sourceHash);
  process.stdout.write(`runtime prepared: ${manifest.version} ${manifest.arch}, ${manifest.entries.length} entries\n`);
}
