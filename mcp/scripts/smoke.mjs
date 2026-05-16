#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cliBin = resolve(root, "dist", "cli.js");

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const icon = status === "pass" ? "✓" : "✗";
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

class StdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
  }

  #onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 10000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method} error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close() {
    this.child.stdin.end();
  }
}

async function main() {
  console.log("seedrop mcp smoke");
  console.log("──────────────────");

  const child = spawn(process.execPath, [cliBin], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  const client = new StdioClient(child);

  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    if (!init.serverInfo?.name) throw new Error("no serverInfo");
    record("initialize", "pass", `${init.serverInfo.name}@${init.serverInfo.version}`);
    client.notify("notifications/initialized");

    const list = await client.request("tools/list", {});
    const names = (list.tools ?? []).map((t) => t.name).sort();
    if (!names.includes("seedrop_continuity")) throw new Error("seedrop_continuity missing");
    if (!names.includes("seedrop_bootstrap")) throw new Error("seedrop_bootstrap missing");
    record("tools/list", "pass", `${names.length} tools`);

    const call = await client.request("tools/call", {
      name: "seedrop_continuity",
      arguments: {},
    });
    const text = (call.content ?? [])[0]?.text ?? "";
    if (!text.includes("Continuity")) throw new Error("continuity output missing header");
    record("call seedrop_continuity", "pass");

    const callJson = await client.request("tools/call", {
      name: "seedrop_continuity",
      arguments: { json: true },
    });
    const jsonText = (callJson.content ?? [])[0]?.text ?? "";
    const parsed = JSON.parse(jsonText);
    if (typeof parsed.daemon?.url !== "string") throw new Error("json output missing daemon.url");
    record("call seedrop_continuity --json", "pass", `daemon=${parsed.daemon.url}`);

    const bad = await client.request("tools/call", {
      name: "seedrop_view_log",
      arguments: {},
    });
    if (!bad.isError) throw new Error("expected isError for missing args");
    record("error handling on missing args", "pass");
  } finally {
    client.close();
    child.kill();
  }

  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  console.log("──────────────────");
  console.log(`pass:${pass}  fail:${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error("mcp smoke failed:", error?.message ?? error);
  process.exit(1);
});
