#!/usr/bin/env node
/**
 * Fail before a release runner consumes signing authority unless source,
 * version, tag, and credential shape all agree.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCredentialShape } from "./release-controls.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const requireCredentials = process.argv.includes("--credentials");
const allowDirty = process.argv.includes("--allow-dirty");
const tag = flagValue("tag") ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;

function flagValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const cargoManifest = await readFile(path.join(desktopRoot, "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = new Map([
  ["Desktop package", desktopPackage.version],
  ["Tauri config", tauriConfig.version],
  ["Cargo package", cargoVersion],
]);

for (const [surface, version] of versions) {
  if (version !== desktopPackage.version) {
    throw new Error(`${surface} version ${version ?? "<missing>"} does not match ${desktopPackage.version}`);
  }
}

const expectedTag = `desktop-v${desktopPackage.version}`;
if (!tag) throw new Error(`release tag is required; expected ${expectedTag}`);
if (tag !== expectedTag) throw new Error(`release tag must be ${expectedTag}; got ${tag}`);

const headTags = run("git", ["tag", "--points-at", "HEAD"], "tag inspection").split("\n").filter(Boolean);
if (!headTags.includes(tag)) throw new Error(`HEAD is not exactly tagged ${tag}`);

if (!allowDirty) {
  const dirty = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], "worktree inspection");
  if (dirty) throw new Error("release worktree must be clean");
}

if (requireCredentials) {
  assertCredentialShape(process.env);
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: "1.0",
  releaseTag: tag,
  version: desktopPackage.version,
  commit: run("git", ["rev-parse", "HEAD"], "commit inspection"),
  clean: !allowDirty,
  credentialsChecked: requireCredentials,
}, null, 2)}\n`);
