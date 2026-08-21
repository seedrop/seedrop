#!/usr/bin/env node
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const seedropRoot = resolve(cliRoot, "..");
const cliBin = join(cliRoot, "dist", "cli.js");
const idBin = join(seedropRoot, "id", "dist", "cli.js");
const spaceBin = join(seedropRoot, "space", "dist", "cli.js");
const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const icon = status === "pass" ? "✓" : "✗";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`  ${icon} ${name}${suffix}`);
}

async function main() {
  console.log("seed cli composition smoke");
  console.log("───────────────────────────");

  assertBuilt(cliBin, "@seedrop/cli");
  assertBuilt(idBin, "@seedrop/id");
  assertBuilt(spaceBin, "@seedrop/space");
  await assertExecutable(cliBin, "@seedrop/cli bin is executable");
  await assertExecutable(idBin, "@seedrop/id bin is executable");
  await assertExecutable(spaceBin, "@seedrop/space bin is executable");

  const temp = await mkdtemp(join(os.tmpdir(), "seedrop-cli-smoke-"));
  const binDir = join(temp, "bin");
  await mkdir(binDir);

  try {
    await writeShim(join(binDir, "seed-id"), idBin);
    await writeShim(join(binDir, "seed-space"), spaceBin);
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const projectRoot = join(temp, "project");
    const passportPath = join(projectRoot, ".seedrop", "id", "passport.json");
    const claudePassportPath = join(projectRoot, ".seedrop", "id", "claude.passport.json");

    await expectOk(["--help"], env, "seed help");
    await expectOk(
      ["id", "init", "--name", "codex", "--purpose", "Test agent", "--out", passportPath],
      env,
      "seed id init creates passport",
    );
    await expectOk(
      ["id", "init", "--name", "claude", "--purpose", "Test collaborator", "--out", claudePassportPath],
      env,
      "seed id init creates collaborator passport",
    );
    await expectOk(["id", "validate", passportPath], env, "seed id validate positional passport");
    await expectOk(["id", "show", passportPath, "--json"], env, "seed id show json");
    await expectOk(["id", "status", passportPath], env, "seed id status positional passport");
    await expectOk(["id", "repair", "--passport", passportPath], env, "seed id repair no-op");
    await expectOk(
      ["view", "init", "--root", projectRoot, "--passport", passportPath],
      env,
      "seed view init links passport",
    );
    await expectPassportProject(passportPath, resolve(projectRoot), env, "passport records active project");
    const server = await startSeedServer(
      [
        "space",
        "serve",
        "--root",
        projectRoot,
        "--passport",
        passportPath,
        "--passport",
        claudePassportPath,
        "--port",
        "0",
        "--json",
      ],
      env,
      "seed space serve starts",
    );
    if (server) {
      try {
        await expectHttpStatus(server.url, "codex", 201, "server accepts passport identity");
        await expectHttpStatus(server.url, "qwen", 401, "server rejects unknown passport identity");
        await expectOk(
          ["space", "join", "seedrop-team", "--passport", passportPath, "--url", server.url],
          env,
          "codex joins space",
        );
        await expectOk(
          ["space", "join", "seedrop-team", "--passport", claudePassportPath, "--url", server.url],
          env,
          "claude joins space",
        );
        const post = await expectJson(
          ["space", "post", "seedrop-team", "hello claude", "--passport", passportPath, "--url", server.url],
          env,
          "codex posts message",
          (payload) => payload?.message?.content === "hello claude",
        );
        await expectJson(
          ["space", "messages", "seedrop-team", "--passport", claudePassportPath, "--url", server.url],
          env,
          "claude reads messages",
          (payload) => payload?.messages?.some?.((message) => message.content === "hello claude"),
        );
        await expectJson(
          ["space", "presence", "--passport", passportPath, "--url", server.url],
          env,
          "presence command lists sessions",
          (payload) => Array.isArray(payload?.presence),
        );
        const messageId = post?.message?.id ?? "missing-message";
        const notification = await expectJson(
          [
            "space",
            "notify",
            "--to",
            "claude",
            "--pointer",
            `space-message:${messageId}`,
            "--passport",
            passportPath,
            "--url",
            server.url,
          ],
          env,
          "codex notifies claude",
          (payload) => payload?.notification?.recipient_passport_id === "claude",
        );
        const notificationId = notification?.notification?.id ?? "missing-notification";
        await expectJson(
          ["space", "notifications", "--passport", claudePassportPath, "--url", server.url],
          env,
          "claude lists notifications",
          (payload) => payload?.notifications?.some?.((item) => item.id === notificationId),
        );
        await expectOk(
          ["space", "ack", notificationId, "--passport", claudePassportPath, "--url", server.url],
          env,
          "claude acks notification",
        );
        await expectJson(
          ["space", "notifications", "--passport", claudePassportPath, "--url", server.url],
          env,
          "claude notifications empty after ack",
          (payload) => Array.isArray(payload?.notifications) && payload.notifications.length === 0,
        );
        await expectOk(
          ["space", "end", "seedrop-team", "--passport", passportPath, "--url", server.url],
          env,
          "codex ends space",
        );
      } finally {
        await stopProcess(server.child);
      }
    }
    await expectJson(
      ["run", "start", "--goal", "smoke the run surface", "--root", projectRoot, "--agent", "codex"],
      env,
      "seed run start creates a run",
      (payload) => typeof payload?.run?.run_id === "string",
    );
    await expectJson(
      ["run", "status", "--json", "--root", projectRoot, "--agent", "codex"],
      env,
      "seed run status reports the active run",
      (payload) => payload?.active?.goal === "smoke the run surface" && payload?.run_count === 1,
    );
    await expectOk(["view", "--help"], env, "seed view help");
    await expectOk(["space", "view", "--help"], env, "seed space view help");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  const failed = results.filter((result) => result.status === "fail").length;
  console.log("───────────────────────────");
  console.log(`pass:${results.length - failed}  fail:${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

function assertBuilt(path, name) {
  if (!existsSync(path)) {
    throw new Error(`${name} is not built at ${path}; run npm run build in cli, id, and space first`);
  }
}

async function assertExecutable(path, name) {
  await access(path, constants.X_OK);
  record(name, "pass");
}

async function writeShim(path, target) {
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
}

async function expectOk(args, env, name) {
  const result = await runNode([cliBin, ...args], env);
  if (result.code === 0) {
    record(name, "pass");
    return;
  }
  record(name, "fail", result.stderr || result.stdout || `exit ${result.code}`);
}

async function expectJson(args, env, name, predicate) {
  const result = await runNode([cliBin, ...args], env);
  if (result.code !== 0) {
    record(name, "fail", result.stderr || result.stdout || `exit ${result.code}`);
    return undefined;
  }
  try {
    const payload = JSON.parse(result.stdout);
    if (predicate(payload)) {
      record(name, "pass");
      return payload;
    }
    record(name, "fail", "unexpected JSON payload");
    return payload;
  } catch (error) {
    record(name, "fail", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function startSeedServer(args, env, name) {
  const child = spawn(process.execPath, [cliBin, ...args], { env, cwd: cliRoot });
  let stdout = "";
  let stderr = "";

  return await new Promise((resolveStart) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveStart(value);
    };
    const timeout = setTimeout(() => {
      record(name, "fail", stderr || stdout || "timed out waiting for listening event");
      child.kill("SIGTERM");
      finish(null);
    }, 5000);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.event === "listening" && payload.url) {
            record(name, "pass", payload.url);
            finish({ child, url: payload.url });
            return;
          }
        } catch {
          // The process may print non-JSON diagnostics before the listening event.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (settled) return;
      record(name, "fail", stderr || stdout || `exited ${code ?? 1}`);
      finish(null);
    });
    child.on("error", (error) => {
      if (settled) return;
      record(name, "fail", error.message);
      finish(null);
    });
  });
}

async function expectHttpStatus(baseUrl, passportId, expectedStatus, name) {
  try {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": passportId },
    });
    if (response.status === expectedStatus) {
      record(name, "pass");
      return;
    }
    const body = await response.text();
    record(name, "fail", `expected ${expectedStatus}, got ${response.status}: ${body}`);
  } catch (error) {
    record(name, "fail", error instanceof Error ? error.message : String(error));
  }
}

async function expectPassportProject(passportPath, root, env, name) {
  const result = await runNode([cliBin, "id", "show", passportPath, "--json"], env);
  if (result.code !== 0) {
    record(name, "fail", result.stderr || result.stdout || `exit ${result.code}`);
    return;
  }
  try {
    const passport = JSON.parse(result.stdout);
    const hasProject = passport.active_projects?.some((project) => project.root === root && project.view === ".seedrop/view");
    if (hasProject) {
      record(name, "pass");
      return;
    }
    record(name, "fail", "active project link missing");
  } catch (error) {
    record(name, "fail", error instanceof Error ? error.message : String(error));
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 3000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

function runNode(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { env, cwd: cliRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolveRun({ code: 1, stdout, stderr: error.message }));
  });
}

await main();
