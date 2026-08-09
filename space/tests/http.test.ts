import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { request as nodeRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, Presence, SpaceAuthError, type CreateServerOptions } from "../src/index.js";

let root: string;
let server: Server;
let baseUrl: string;
let currentTime: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-http-"));
  currentTime = new Date("2026-05-14T10:00:00.000Z");
  await startServer();
});

afterEach(async () => {
  await closeServer();
  await rm(root, { recursive: true, force: true });
});

async function startServer(options: Omit<CreateServerOptions, "root" | "now"> = {}): Promise<void> {
  server = createServer({ root, now: () => currentTime, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function restartServer(options: Omit<CreateServerOptions, "root" | "now"> = {}): Promise<void> {
  await closeServer();
  await startServer(options);
}

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function request(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function chunkedRequest(pathname: string, chunks: readonly string[]): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = nodeRequest(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-seedrop-passport": "alpha",
        "transfer-encoding": "chunked",
      },
    }, (res) => {
      const body: Buffer[] = [];
      res.on("data", (chunk) => body.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(body).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe("http server", () => {
  it("registers a session via POST /sessions", async () => {
    const result = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { workingOn: "writing http" },
    });
    expect(result.status).toBe(201);
    expect(result.body.session).toMatchObject({
      passport_id: "alpha",
      working_on: "writing http",
    });
  });

  it("rejects POST /sessions without a passport header", async () => {
    const result = await request("POST", "/sessions", { body: {} });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("seedrop.validation.failed");
  });

  it("returns localhost-safe health without a passport", async () => {
    await restartServer({
      health: {
        service: "seed-space",
        version: "0.1.0-alpha.2",
        buildHash: "test",
        host: "127.0.0.1",
        port: 0,
        registeredPassports: [{ passportId: "codex", agentId: "codex", path: "/tmp/codex.json" }],
        knownAgentIds: ["codex"],
      },
    });

    const result = await request("GET", "/health");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schema_version: "1.0",
      service: "seed-space",
      ok: true,
      version: "0.1.0-alpha.2",
      build_hash: "test",
      registered_passports: [{ passport_id: "codex", agent_id: "codex", path: "/tmp/codex.json" }],
      known_agent_ids: ["codex"],
    });
    expect(typeof result.body.uptime_ms).toBe("number");
  });

  it("rejects an unknown passport when an identity resolver is configured", async () => {
    await restartServer({ identity: { resolve: () => null } });

    const result = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("seedrop.auth.unauthorized");

    const presence = await request("GET", "/presence", { headers: { "x-seedrop-passport": "alpha" } });
    expect(presence.status).toBe(401);
    await expect(Presence.list({ root })).resolves.toEqual([]);
  });

  it("allows a known passport when an identity resolver is configured", async () => {
    await restartServer({
      identity: {
        resolve: (passportId) => (passportId === "alpha" ? { passportId, name: "Alpha" } : null),
      },
    });

    const accepted = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });
    expect(accepted.status).toBe(201);

    const rejected = await request("POST", "/spaces/Build%20Room/join", {
      headers: { "x-seedrop-passport": "beta" },
      body: {},
    });
    expect(rejected.status).toBe(401);
  });

  it("maps resolver authorization failures to 403", async () => {
    await restartServer({
      identity: {
        resolve: () => {
          throw new SpaceAuthError("passport lacks access to this server", 403);
        },
      },
    });

    const result = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("seedrop.auth.forbidden");
  });

  it("rejects resolver/header mismatches as forbidden", async () => {
    await restartServer({ identity: { resolve: () => ({ passportId: "different" }) } });

    const result = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("seedrop.auth.forbidden");
  });

  it("heartbeats and lists presence", async () => {
    const register = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });
    const sessionId = register.body.session.id;

    currentTime = new Date("2026-05-14T10:00:30.000Z");
    const beat = await request("POST", "/presence/heartbeat", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { sessionId, workingOn: "still writing" },
    });
    expect(beat.status).toBe(200);
    expect(beat.body.session.working_on).toBe("still writing");

    const list = await request("GET", "/presence?ttlMs=60000", {
      headers: { "x-seedrop-passport": "alpha" },
    });
    expect(list.status).toBe(200);
    expect(list.body.presence).toHaveLength(1);
    expect(list.body.presence[0].online).toBe(true);
  });

  it("returns 404 when heartbeating an unknown session", async () => {
    const result = await request("POST", "/presence/heartbeat", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { sessionId: "missing" },
    });
    expect(result.status).toBe(404);
  });

  it("rejects presence list with a malformed ttlMs query", async () => {
    const result = await request("GET", "/presence?ttlMs=not-a-number", {
      headers: { "x-seedrop-passport": "alpha" },
    });
    expect(result.status).toBe(400);
  });

  it("opens, posts, lists, and ends a space through HTTP", async () => {
    const join = await request("POST", "/spaces/Build%20Room/join", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });
    expect(join.status).toBe(200);
    expect(join.body.space.lifecycle).toBe("open");

    const post = await request("POST", "/spaces/Build%20Room/messages", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { content: "hello" },
    });
    expect(post.status).toBe(201);
    expect(post.body.message.content).toBe("hello");

    const list = await request("GET", "/spaces/Build%20Room/messages", {
      headers: { "x-seedrop-passport": "alpha" },
    });
    expect(list.status).toBe(200);
    expect(list.body.messages).toHaveLength(1);

    const end = await request("POST", "/spaces/Build%20Room/end", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });
    expect(end.status).toBe(200);
    expect(end.body.space.lifecycle).toBe("ended");
  });

  it("default-denies protected Space routes to authenticated non-members", async () => {
    await request("POST", "/spaces/Build%20Room/join", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });

    for (const [method, path, body] of [
      ["GET", "/spaces/Build%20Room/messages", undefined],
      ["POST", "/spaces/Build%20Room/messages", { content: "intrusion" }],
      ["POST", "/spaces/Build%20Room/end", {}],
      ["POST", "/sessions", { spaceId: "Build Room" }],
    ] as const) {
      const result = await request(method, path, {
        headers: { "x-seedrop-passport": "beta" },
        body,
      });
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(result.body.error.code, `${method} ${path}`).toBe("seedrop.auth.forbidden");
    }

    const list = await request("GET", "/spaces/Build%20Room/messages", {
      headers: { "x-seedrop-passport": "alpha" },
    });
    expect(list.body.messages).toEqual([]);
  });

  it("binds heartbeats to the authenticated session owner", async () => {
    const register = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });

    const result = await request("POST", "/presence/heartbeat", {
      headers: { "x-seedrop-passport": "beta" },
      body: { sessionId: register.body.session.id },
    });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("seedrop.auth.forbidden");
  });

  it("rejects declared oversized request bodies with a stable 413 error", async () => {
    await restartServer({ maxBodyBytes: 32 });
    const result = await request("POST", "/sessions", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { workingOn: "x".repeat(64) },
    });

    expect(result.status).toBe(413);
    expect(result.body.error).toMatchObject({
      code: "seedrop.http.body_too_large",
      class: "validation",
      retryable: false,
      details: { limit_bytes: 32 },
    });
  });

  it("rejects invalid body-limit configuration before listening", async () => {
    expect(() => createServer({ root, maxBodyBytes: Number.POSITIVE_INFINITY })).toThrow(/positive safe integer/);
    expect(() => createServer({ root, maxBodyBytes: 0 })).toThrow(/positive safe integer/);
  });

  it("bounds chunked bodies even when content-length is absent", async () => {
    await restartServer({ maxBodyBytes: 24 });
    const result = await chunkedRequest("/sessions", ["{\"workingOn\":\"", "x".repeat(64), "\"}"]);

    expect(result.status).toBe(413);
    expect(result.body.error).toMatchObject({
      code: "seedrop.http.body_too_large",
      details: { limit_bytes: 24 },
    });
    expect(result.body.error.details.received_bytes).toBeGreaterThan(24);
  });

  it("returns 404 when loading an unknown space", async () => {
    const result = await request("GET", "/spaces/missing/messages", {
      headers: { "x-seedrop-passport": "alpha" },
    });
    expect(result.status).toBe(404);
  });

  it("rejects an invalid message body with 400", async () => {
    await request("POST", "/spaces/Build%20Room/join", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });
    const result = await request("POST", "/spaces/Build%20Room/messages", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { content: "" },
    });
    expect(result.status).toBe(400);
  });

  it("rejects non-JSON request bodies with 400", async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seedrop-passport": "alpha" },
      body: "this is not json",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("seedrop.validation.failed");
  });

  it("sends, lists, and acks a notification through HTTP", async () => {
    await request("POST", "/spaces/Build%20Room/join", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });
    const post = await request("POST", "/spaces/Build%20Room/messages", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { content: "hello beta" },
    });
    const messageId = post.body.message.id;

    const send = await request("POST", "/notifications", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {
        recipientPassportId: "beta",
        pointer: { kind: "space-message", ref: `${post.body.message.space_id}/${messageId}` },
      },
    });
    expect(send.status).toBe(201);
    const notificationId = send.body.notification.id;

    const list = await request("GET", "/notifications", {
      headers: { "x-seedrop-passport": "beta" },
    });
    expect(list.body.notifications).toHaveLength(1);

    const ack = await request("POST", `/notifications/${notificationId}/ack`, {
      headers: { "x-seedrop-passport": "beta" },
      body: {},
    });
    expect(ack.status).toBe(200);
    expect(ack.body.notification.acked_at).not.toBeNull();

    const empty = await request("GET", "/notifications", {
      headers: { "x-seedrop-passport": "beta" },
    });
    expect(empty.body.notifications).toEqual([]);
  });

  it("returns 404 for an unknown route", async () => {
    const result = await request("GET", "/no-such-thing");
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("seedrop.http.not_found");
  });

  it("returns 404 when acking an unknown notification", async () => {
    const result = await request("POST", "/notifications/missing/ack", {
      headers: { "x-seedrop-passport": "beta" },
      body: {},
    });
    expect(result.status).toBe(404);
  });

  it("treats an empty body as an empty object on POST /sessions", async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "x-seedrop-passport": "alpha" },
    });
    expect(response.status).toBe(201);
  });

  it("treats a whitespace-only body as an empty object", async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seedrop-passport": "alpha" },
      body: "   \n  ",
    });
    expect(response.status).toBe(201);
  });

  it("keeps message reads available when a JSONL row is corrupted", async () => {
    const join = await request("POST", "/spaces/Build%20Room/join", {
      headers: { "x-seedrop-passport": "alpha" },
      body: {},
    });
    await request("POST", "/spaces/Build%20Room/messages", {
      headers: { "x-seedrop-passport": "alpha" },
      body: { content: "real" },
    });

    const target = join.body.space.id;
    const messagesPath = path.join(root, ".seedrop", "space", "spaces", target, "messages.jsonl");
    await writeFile(messagesPath, "{not-json\n");

    const result = await request("GET", "/spaces/Build%20Room/messages", {
      headers: { "x-seedrop-passport": "alpha" },
    });
    expect(result.status).toBe(200);
    expect(result.body.messages).toEqual([]);
  });

  it("serves an HTML status page at /status", async () => {
    const response = await fetch(`${baseUrl}/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const body = await response.text();
    expect(body).toMatch(/<title>Seedrop daemon status<\/title>/);
    expect(body).toMatch(/Online agents/);
    expect(body).toMatch(/Registered passports/);
  });
});
