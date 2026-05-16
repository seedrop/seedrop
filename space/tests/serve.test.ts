import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPassportIdentityResolver, startSpaceServer, type StartedSpaceServer } from "../src/index.js";

let root: string;
let passportPath: string;
let claudePassportPath: string;
let started: StartedSpaceServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-serve-"));
  passportPath = path.join(root, "passport.json");
  claudePassportPath = path.join(root, "claude.passport.json");
  await writeFile(
    passportPath,
    JSON.stringify({
      version: "1.0",
      agent_id: "codex",
      name: "Codex",
      purpose: "Test agent",
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
  await writeFile(
    claudePassportPath,
    JSON.stringify({
      version: "1.0",
      agent_id: "claude",
      name: "Claude",
      purpose: "Test agent",
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
});

afterEach(async () => {
  if (started) {
    await new Promise<void>((resolve, reject) =>
      started?.server.close((error) => (error ? reject(error) : resolve())),
    );
    started = undefined;
  }
  await rm(root, { recursive: true, force: true });
});

describe("serve identity binding", () => {
  it("resolves the passport agent_id and rejects other ids", async () => {
    const { identity, resolver } = await createPassportIdentityResolver({ passportPath });

    expect(identity).toMatchObject({ passportId: "codex", agentId: "codex", name: "Codex" });
    await expect(Promise.resolve(resolver.resolve("codex"))).resolves.toMatchObject({
      passportId: "codex",
      agentId: "codex",
    });
    await expect(Promise.resolve(resolver.resolve("Codex"))).resolves.toMatchObject({
      passportId: "Codex",
      agentId: "codex",
    });
    await expect(Promise.resolve(resolver.resolve("claude"))).resolves.toBeNull();
  });

  it("can expose a selected passport id alias", async () => {
    const { identity, resolver } = await createPassportIdentityResolver({ passportPath, passportId: "local-codex" });

    expect(identity.passportId).toBe("local-codex");
    await expect(Promise.resolve(resolver.resolve("local-codex"))).resolves.toMatchObject({
      passportId: "local-codex",
      agentId: "codex",
    });
    await expect(Promise.resolve(resolver.resolve("codex"))).resolves.toMatchObject({
      passportId: "codex",
      agentId: "codex",
    });
  });

  it("starts an HTTP server that authorizes only the passport identity", async () => {
    started = await startSpaceServer({ root, passportPath, port: 0 });

    const accepted = await fetch(`${started.url}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": "codex" },
    });
    expect(accepted.status).toBe(201);

    const rejected = await fetch(`${started.url}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": "claude" },
    });
    expect(rejected.status).toBe(401);
  });

  it("can authorize multiple passport files", async () => {
    started = await startSpaceServer({ root, passportPaths: [passportPath, claudePassportPath], port: 0 });

    const codex = await fetch(`${started.url}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": "codex" },
    });
    expect(codex.status).toBe(201);

    const claude = await fetch(`${started.url}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": "claude" },
    });
    expect(claude.status).toBe(201);

    const unknown = await fetch(`${started.url}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": "qwen" },
    });
    expect(unknown.status).toBe(401);
  });

  it("exposes health metadata with registered passports", async () => {
    started = await startSpaceServer({ root, passportPaths: [passportPath, claudePassportPath], port: 0 });

    const response = await fetch(`${started.url}/health`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      root: string;
      registered_passports: Array<{ passport_id: string; agent_id: string; path: string }>;
      known_agent_ids: string[];
    };

    expect(body.root).toBe(root);
    expect(body.registered_passports).toEqual([
      { passport_id: "codex", agent_id: "codex", path: passportPath },
      { passport_id: "claude", agent_id: "claude", path: claudePassportPath },
    ]);
    expect(body.known_agent_ids).toEqual(["codex", "claude"]);
  });
});
