import { request as nodeRequest, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  Space,
  startSpaceServer,
} from "../src/index.js";

let root: string;
let servers: Server[];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-pr08-security-"));
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await rm(root, { recursive: true, force: true });
});

describe("PR-08 identity and authorization proof matrix", () => {
  it("maps passport id, agent id, and name aliases to one persisted principal", async () => {
    const passportPath = path.join(root, "codex.passport.json");
    await writePassport(passportPath, "codex", "Codex");
    const started = await startSpaceServer({
      root,
      passportPath,
      passportId: "local-codex",
      port: 0,
    });
    servers.push(started.server);

    const aliases = ["codex", "Codex", "local-codex"];
    for (const alias of aliases) {
      const joined = await jsonRequest(started.url, "POST", "/spaces/Alias%20Room/join", alias, {});
      expect(joined.status, alias).toBe(200);
      const posted = await jsonRequest(started.url, "POST", "/spaces/Alias%20Room/messages", alias, {
        content: `from ${alias}`,
      });
      expect(posted.status, alias).toBe(201);
      expect(posted.body.message.author_passport_id, alias).toBe("codex");
      expect(posted.body.message.principal_chain, alias).toEqual(["codex"]);
    }

    const space = await Space.load("Alias Room", { root, passportId: "codex" });
    expect(space.members().filter((member) => !member.left_at).map((member) => member.passport_id)).toEqual(["codex"]);
    expect((await space.messages()).map((message) => message.author_passport_id)).toEqual(["codex", "codex", "codex"]);

    const sent = await jsonRequest(started.url, "POST", "/notifications", "local-codex", {
      recipientPassportId: "Codex",
      pointer: { kind: "proof", ref: "alias-matrix" },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.notification).toMatchObject({ sender_passport_id: "codex", recipient_passport_id: "codex" });
    const notifications = await jsonRequest(started.url, "GET", "/notifications", "codex");
    expect(notifications.body.notifications).toHaveLength(1);

    expect((await jsonRequest(started.url, "POST", "/spaces/Alias%20Room/messages", "Codex", {
      content: "@codex alias inbox proof",
    })).status).toBe(201);
    const inbox = await jsonRequest(started.url, "GET", "/inbox/Codex", "local-codex");
    expect(inbox.status).toBe(200);
    expect(inbox.body.mentions).toEqual([expect.objectContaining({ recipient_passport_id: "codex" })]);
  });

  it("admits a new passport dynamically and default-denies an alias once it becomes ambiguous", async () => {
    const agentsDir = path.join(root, "agents");
    await writePassport(path.join(agentsDir, "alpha.json"), "alpha", "shared-name");
    const started = await startSpaceServer({
      root,
      agentsDirs: [agentsDir],
      watchAgentsDirs: true,
      agentsDirsPollMs: 10,
      port: 0,
    });
    servers.push(started.server);

    expect((await jsonRequest(started.url, "POST", "/sessions", "beta", {})).status).toBe(401);
    await writePassport(path.join(agentsDir, "beta.json"), "beta", "shared-name");

    let admitted: Awaited<ReturnType<typeof jsonRequest>> | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      admitted = await jsonRequest(started.url, "POST", "/sessions", "beta", {});
      if (admitted.status === 201) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(admitted?.status).toBe(201);
    expect(admitted?.body.session.passport_id).toBe("beta");
    expect((await jsonRequest(started.url, "POST", "/spaces/Dynamic%20Room/join", "beta", {})).status).toBe(200);
    const dynamicPost = await jsonRequest(started.url, "POST", "/spaces/Dynamic%20Room/messages", "beta", { content: "admitted live" });
    expect(dynamicPost.status).toBe(201);
    expect(dynamicPost.body.message.author_passport_id).toBe("beta");

    const ambiguous = await jsonRequest(started.url, "POST", "/sessions", "shared-name", {});
    expect(ambiguous.status).toBe(401);
    expect(ambiguous.body.error.code).toBe("seedrop.auth.unauthorized");
  });

  it("default-denies every protected Space route to an authenticated non-member", async () => {
    const server = createServer({ root });
    servers.push(server);
    const url = await listen(server);
    expect((await jsonRequest(url, "POST", "/spaces/Proof%20Room/join", "alpha", {})).status).toBe(200);

    const requestId = "88888888-8888-4888-8888-888888888888";
    const protectedRoutes: Array<[string, string, unknown?]> = [
      ["GET", "/spaces/Proof%20Room/messages"],
      ["POST", "/spaces/Proof%20Room/messages", { content: "intrusion" }],
      ["GET", "/spaces/Proof%20Room/outbox"],
      ["POST", `/spaces/Proof%20Room/outbox/${requestId}/retry`, {}],
      ["POST", "/spaces/Proof%20Room/end", {}],
      ["POST", "/sessions", { spaceId: "Proof Room" }],
    ];
    for (const [method, pathname, body] of protectedRoutes) {
      const result = await jsonRequest(url, method, pathname, "beta", body);
      expect(result.status, `${method} ${pathname}`).toBe(403);
      expect(result.body.error.code, `${method} ${pathname}`).toBe("seedrop.auth.forbidden");
    }

    const messages = await jsonRequest(url, "GET", "/spaces/Proof%20Room/messages", "alpha");
    expect(messages.body.messages).toEqual([]);
  });

  it("returns the stable body-limit error for declared and chunked bodies on every POST route", async () => {
    const server = createServer({ root, maxBodyBytes: 32 });
    servers.push(server);
    const url = await listen(server);
    const itemId = "99999999-9999-4999-8999-999999999999";
    const postRoutes = [
      "/sessions",
      "/presence/heartbeat",
      "/presence/ack",
      "/spaces/Proof%20Room/join",
      "/spaces/Proof%20Room/messages",
      `/spaces/Proof%20Room/outbox/${itemId}/retry`,
      "/spaces/Proof%20Room/end",
      "/notifications",
      `/notifications/${itemId}/ack`,
      `/inbox/alpha/${itemId}/ack`,
    ];

    for (const pathname of postRoutes) {
      const declared = await jsonRequest(url, "POST", pathname, "alpha", { payload: "x".repeat(128) });
      expectStableLimit(declared, pathname);

      const chunked = await chunkedRequest(url, pathname, ["{\"payload\":\"", "x".repeat(128), "\"}"]);
      expectStableLimit(chunked, `${pathname} (chunked)`);
    }
    expectStableLimit(
      await declaredRawRequest(url, "/health", "GET", "x".repeat(128)),
      "/health GET (declared)",
    );
    expectStableLimit(
      await chunkedRequest(url, "/health", ["x".repeat(128)], "GET"),
      "/health GET (chunked)",
    );
  });
});

async function writePassport(filePath: string, agentId: string, name: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ agent_id: agentId, name }));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose an address");
  return `http://127.0.0.1:${address.port}`;
}

async function jsonRequest(
  baseUrl: string,
  method: string,
  pathname: string,
  passportId: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-seedrop-passport": passportId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function chunkedRequest(
  baseUrl: string,
  pathname: string,
  chunks: readonly string[],
  method = "POST",
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = nodeRequest(`${baseUrl}${pathname}`, {
      method,
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

async function declaredRawRequest(
  baseUrl: string,
  pathname: string,
  method: string,
  bodyValue: string,
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = nodeRequest(`${baseUrl}${pathname}`, {
      method,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(bodyValue)),
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
    req.end(bodyValue);
  });
}

function expectStableLimit(result: { status: number; body: any }, label: string): void {
  expect(result.status, label).toBe(413);
  expect(result.body.error, label).toMatchObject({
    code: "seedrop.http.body_too_large",
    class: "validation",
    retryable: false,
    details: { limit_bytes: 32 },
  });
}
