#!/usr/bin/env node
/**
 * Verify the distributable disk image, then run the complete application gate
 * against the exact .app mounted from that image.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMacSignature } from "./release-controls.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const targetArch = flagValue("arch")
  ?? process.env.SEEDROP_DESKTOP_ARCH
  ?? (process.arch === "arm64" ? "arm64" : "x64");
if (!["arm64", "x64"].includes(targetArch)) throw new Error(`unsupported DMG architecture: ${targetArch}`);
const allowUnsigned = process.argv.includes("--allow-unsigned");
const evidencePath = flagValue("evidence");
if (allowUnsigned && evidencePath) throw new Error("release evidence can only be emitted by the strict signed/notarized gate");
const targetTriple = targetArch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
const crossTarget = targetArch !== (process.arch === "arm64" ? "arm64" : "x64");
const defaultDmgDir = crossTarget
  ? path.join(desktopRoot, "src-tauri", "target", targetTriple, "release", "bundle", "dmg")
  : path.join(desktopRoot, "src-tauri", "target", "release", "bundle", "dmg");
const dmg = path.resolve(flagValue("dmg") ?? await discoverDmg(path.resolve(flagValue("dmg-dir") ?? defaultDmgDir)));
let applicationEvidence = null;

function flagValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function discoverDmg(directory) {
  if (!(await exists(directory))) throw new Error(`DMG directory missing: ${directory}`);
  const candidates = (await readdir(directory))
    .filter((entry) => entry.endsWith(".dmg"))
    .map((entry) => path.join(directory, entry));
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one DMG in ${directory}; found ${candidates.length}`);
  }
  return candidates[0];
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`.trim();
}

run("/usr/bin/hdiutil", ["verify", dmg], "DMG integrity verification");
const mountPoint = await mkdtemp(path.join(os.tmpdir(), "seedrop-desktop-dmg-"));
let attached = false;
let detachFailure = null;
try {
  run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmg], "DMG read-only mount");
  attached = true;
  const applications = (await readdir(mountPoint)).filter((entry) => entry.endsWith(".app"));
  if (applications.length !== 1) {
    throw new Error(`expected exactly one application in mounted DMG; found ${applications.length}`);
  }
  const application = path.join(mountPoint, applications[0]);
  const gateArgs = [
    path.join(here, "release-gate.mjs"),
    `--arch=${targetArch}`,
    `--app=${application}`,
  ];
  if (allowUnsigned) gateArgs.push("--allow-unsigned");
  const output = run(process.execPath, gateArgs, "mounted application verification", {
    env: { ...process.env, SEEDROP_DESKTOP_ARCH: targetArch },
  });
  if (output) process.stdout.write(`${output}\n`);
  if (evidencePath) {
    const signature = run("/usr/bin/codesign", ["-dv", "--verbose=4", application], "release signature inspection");
    const parsedSignature = parseMacSignature(signature);
    const manifestPath = path.join(application, "Contents", "Resources", "resources", "release", "runtime-manifest.json");
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    applicationEvidence = {
      version: manifest.version,
      architecture: targetArch,
      runtimeManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      runtimeSourceHash: manifest.sourceHash,
      nodeVersion: manifest.nodeVersion,
      nodeArchiveSha256: manifest.nodeArchiveSha256,
      signing: {
        teamIdentifier: parsedSignature.teamIdentifier,
        authorities: parsedSignature.authorities,
      },
    };
  }
} finally {
  if (attached) {
    const detached = spawnSync("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"], { encoding: "utf8" });
    if (detached.status !== 0) {
      detachFailure = `failed to detach ${mountPoint}: ${detached.stderr}`;
    }
  }
  if (!detachFailure) await rm(mountPoint, { recursive: true, force: true });
}

if (detachFailure) throw new Error(detachFailure);

if (!allowUnsigned) {
  run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg], "DMG Gatekeeper assessment");
  run("/usr/bin/xcrun", ["stapler", "validate", dmg], "DMG notarization staple validation");
}

if (evidencePath) {
  const dmgBytes = await readFile(dmg);
  const metadata = await stat(dmg);
  const evidence = {
    schemaVersion: "1.0",
    kind: "seedrop-desktop-release-evidence",
    generatedAt: new Date().toISOString(),
    source: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      commit: process.env.GITHUB_SHA ?? null,
      ref: process.env.GITHUB_REF ?? null,
      runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    },
    artifact: {
      file: path.basename(dmg),
      bytes: metadata.size,
      sha256: createHash("sha256").update(dmgBytes).digest("hex"),
    },
    application: applicationEvidence,
    verification: {
      mountedReadOnly: true,
      exactRuntimeManifest: true,
      developerIdSignature: true,
      gatekeeperAccepted: true,
      applicationStapleValid: true,
      dmgStapleValid: true,
    },
  };
  const absoluteEvidencePath = path.resolve(evidencePath);
  await mkdir(path.dirname(absoluteEvidencePath), { recursive: true });
  await writeFile(absoluteEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`release evidence: ${absoluteEvidencePath}\n`);
}

process.stdout.write(allowUnsigned
  ? `unsigned DMG verified: ${dmg}; signing/notarization intentionally not claimed\n`
  : `release DMG verified: ${dmg}; signed, Gatekeeper accepted, and notarized\n`);
