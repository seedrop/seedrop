#!/usr/bin/env node
/**
 * Fail-closed Desktop release gate. This command is intentionally stricter
 * than development validation: it requires a sealed, correctly-architected,
 * signed, notarized application artifact.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseSignature } from "./release-controls.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const targetArch = process.argv.find((argument) => argument.startsWith("--arch="))?.slice("--arch=".length)
  ?? process.env.SEEDROP_DESKTOP_ARCH
  ?? (process.arch === "arm64" ? "arm64" : "x64");
if (!["arm64", "x64"].includes(targetArch)) throw new Error(`unsupported release architecture: ${targetArch}`);
const expectedArch = targetArch === "x64" ? "x86_64" : "arm64";
const appArgument = process.argv.find((arg) => arg.startsWith("--app="))?.slice("--app=".length);
const app = path.resolve(appArgument ?? path.join(desktopRoot, "src-tauri", "target", "release", "bundle", "macos", "Seedrop Desktop.app"));
const maxAppMb = Number(process.env.SEEDROP_MAX_APP_MB ?? "220");
const allowUnsigned = process.argv.includes("--allow-unsigned");
const executable = path.join(app, "Contents", "MacOS", "seedrop-desktop");
const resources = path.join(app, "Contents", "Resources", "resources", "release");
const bundledNode = path.join(resources, "node", "bin", "node");
const bundledNativeStore = path.join(resources, "payload", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: options.env ?? process.env });
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`.trim();
}

async function directoryBytes(root) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(absolute);
    else if (entry.isFile()) total += (await stat(absolute)).size;
  }
  return total;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function treeEntries(root, prefix = "") {
  const entries = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) entries.push(...await treeEntries(root, relative));
    else entries.push(relative);
  }
  return entries;
}

const tauriConfig = JSON.parse(await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
if (!tauriConfig.app?.security?.csp) throw new Error("release CSP must be explicit and non-empty");

const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const cargoManifest = await readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!(await exists(app))) throw new Error(`application artifact missing: ${app}`);
for (const required of [
  executable,
  path.join(resources, "runtime-manifest.json"),
  path.join(resources, "runtime-provenance.json"),
  bundledNode,
  bundledNativeStore,
  path.join(resources, "payload", "node_modules", "@seedrop", "observer", "dist", "cli.js"),
]) {
  if (!(await exists(required))) throw new Error(`application resource missing: ${required}`);
}
const runtimeManifest = JSON.parse(await readFile(path.join(resources, "runtime-manifest.json"), "utf8"));
const versions = new Map([
  ["desktop package", desktopPackage.version],
  ["Tauri config", tauriConfig.version],
  ["Cargo package", cargoVersion],
  ["sealed runtime", runtimeManifest.version],
]);
for (const [surface, version] of versions) {
  if (version !== desktopPackage.version) {
    throw new Error(`${surface} version ${version ?? "<missing>"} does not match Desktop ${desktopPackage.version}`);
  }
}
if (runtimeManifest.arch !== targetArch) {
  throw new Error(`sealed runtime architecture must be ${targetArch}; got ${runtimeManifest.arch}`);
}

run(process.execPath, ["--test", path.join(here, "runtime-artifact.node.mjs")], "clean-machine artifact test", {
  env: {
    ...process.env,
    SEEDROP_DESKTOP_ARCH: targetArch,
    SEEDROP_DESKTOP_RELEASE: resources,
  },
});

const bundledEntries = (await treeEntries(resources)).filter((entry) => entry !== "runtime-manifest.json").sort();
const declaredEntries = runtimeManifest.entries.map((entry) => entry.path).sort();
if (JSON.stringify(bundledEntries) !== JSON.stringify(declaredEntries)) {
  throw new Error("bundled runtime contents differ from the sealed manifest");
}
for (const entry of runtimeManifest.entries) {
  const absolute = path.join(resources, entry.path);
  const metadata = await lstat(absolute);
  if (entry.kind !== "file" || !metadata.isFile()) {
    throw new Error(`bundled runtime entry changed type: ${entry.path}`);
  }
  const actual = sha256(await readFile(absolute));
  if (actual !== entry.sha256) throw new Error(`bundled runtime integrity mismatch: ${entry.path}`);
  if (entry.executable && !(metadata.mode & 0o111)) {
    throw new Error(`bundled runtime executable bit missing: ${entry.path}`);
  }
}

for (const [label, binary] of [["application", executable], ["Node", bundledNode], ["native datastore", bundledNativeStore]]) {
  const architectures = run("/usr/bin/lipo", ["-archs", binary], `${label} architecture inspection`).split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== expectedArch) {
    throw new Error(`${label} architecture must be exactly ${expectedArch}; got ${architectures.join(", ")}`);
  }
}

const appMb = (await directoryBytes(app)) / (1024 * 1024);
if (appMb > maxAppMb) throw new Error(`artifact is ${appMb.toFixed(1)} MB; limit is ${maxAppMb} MB`);

if (!allowUnsigned) {
  const inspection = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  const signature = `${inspection.stdout}\n${inspection.stderr}`;
  if (inspection.status !== 0) throw new Error("release signature inspection failed");
  assertReleaseSignature(signature, process.env.SEEDROP_EXPECTED_TEAM_ID);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", app], "code-signature verification");
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app], "Gatekeeper assessment");
  run("/usr/bin/xcrun", ["stapler", "validate", app], "notarization staple validation");
}

process.stdout.write(allowUnsigned
  ? `unsigned artifact verified: ${appMb.toFixed(1)} MB, ${expectedArch}; signing/notarization intentionally not claimed\n`
  : `release verified: ${appMb.toFixed(1)} MB, ${expectedArch}, signed and notarized\n`);
