#!/usr/bin/env node
/**
 * Fetch and verify the official Node.js Darwin archive used to build the
 * sealed Desktop runtime. By default we fetch only the host architecture;
 * release CI builds each architecture on its matching runner.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const NODE_VERSION = process.env.SEEDROP_NODE_VERSION ?? "20.19.4";
const HOST_ARCH = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
const requestedArch = flagValue("arch") ?? HOST_ARCH;
const ARCHES = requestedArch === "all" ? ["arm64", "x64"] : [requestedArch];

if (ARCHES.some((arch) => arch !== "arm64" && arch !== "x64")) {
  throw new Error(`unsupported Node runtime architecture: ${requestedArch ?? process.arch}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.join(here, "..", "src-tauri", "resources", "runtime");
const baseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`;

function flagValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed ${response.status} ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function expectedChecksums() {
  const response = await fetch(`${baseUrl}/SHASUMS256.txt`);
  if (!response.ok) throw new Error(`checksum download failed ${response.status}`);
  const raw = await response.text();
  return new Map(raw.trim().split("\n").map((line) => {
    const [digest, filename] = line.trim().split(/\s+/);
    return [filename, digest];
  }));
}

async function runtimeIsCurrent(target, arch, digest) {
  const markerPath = path.join(target, ".seedrop-node.json");
  if (!(await exists(path.join(target, "bin", "node"))) || !(await exists(markerPath))) return false;
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return marker.version === NODE_VERSION && marker.arch === arch && marker.archiveSha256 === digest;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(outRoot, { recursive: true });
  const checksums = await expectedChecksums();

  for (const arch of ARCHES) {
    const label = `node-darwin-${arch}`;
    const filename = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
    const expected = checksums.get(filename);
    if (!expected) throw new Error(`official checksum missing for ${filename}`);

    const target = path.join(outRoot, label);
    if (!process.argv.includes("--force") && await runtimeIsCurrent(target, arch, expected)) {
      process.stdout.write(`skip ${label} (verified Node ${NODE_VERSION})\n`);
      continue;
    }

    const archive = path.join(outRoot, filename);
    const staging = path.join(outRoot, `.install-${label}-${process.pid}`);
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
    process.stdout.write(`fetch ${baseUrl}/${filename}\n`);
    await fetchFile(`${baseUrl}/${filename}`, archive);
    const actual = await sha256(archive);
    if (actual !== expected) {
      await rm(archive, { force: true });
      throw new Error(`checksum mismatch for ${filename}: expected ${expected}, got ${actual}`);
    }

    await mkdir(staging, { recursive: true });
    await execFileAsync("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"]);
    await writeFile(path.join(staging, ".seedrop-node.json"), `${JSON.stringify({
      schemaVersion: "1.0",
      version: NODE_VERSION,
      arch,
      archiveSha256: expected,
    }, null, 2)}\n`);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await rm(archive, { force: true });
    process.stdout.write(`ready ${label} (sha256 ${expected.slice(0, 12)}…)\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
