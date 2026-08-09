import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRecovery } from "../src/errors.js";
import { SpaceHttpClient, SpaceHttpClientError, startSpaceServer, type StartedSpaceServer } from "../src/index.js";

let root: string;
let started: StartedSpaceServer;
let codex: SpaceHttpClient;
let claude: SpaceHttpClient;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-client-"));
  const codexPassport = path.join(root, "codex.passport.json");
  const claudePassport = path.join(root, "claude.passport.json");
  await writePassport(codexPassport, "codex", "Codex");
  await writePassport(claudePassport, "claude", "Claude");
  started = await startSpaceServer({ root, passportPaths: [codexPassport, claudePassport], port: 0 });
  codex = new SpaceHttpClient({ baseUrl: started.url, passportId: "codex" });
  claude = new SpaceHttpClient({ baseUrl: started.url, passportId: "claude" });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    started.server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(root, { recursive: true, force: true });
});

describe("SpaceHttpClient", () => {
  it("joins, posts, reads, notifies, acks, and ends through HTTP", async () => {
    const join = (await codex.join("seedrop-team")) as { space: { name: string } };
    expect(join.space.name).toBe("seedrop-team");

    await claude.join("seedrop-team");

    const post = (await codex.post("seedrop-team", { content: "hello claude" })) as {
      message: { id: string; content: string };
    };
    expect(post.message.content).toBe("hello claude");

    const messages = (await claude.messages("seedrop-team")) as { messages: Array<{ content: string }> };
    expect(messages.messages.map((message) => message.content)).toContain("hello claude");

    const notification = (await codex.notify({
      recipientPassportId: "claude",
      pointer: { kind: "space-message", ref: post.message.id },
    })) as { notification: { id: string } };
    const notifications = (await claude.notifications()) as { notifications: Array<{ id: string }> };
    expect(notifications.notifications.map((item) => item.id)).toContain(notification.notification.id);

    await claude.ack(notification.notification.id);
    await expect(claude.notifications()).resolves.toEqual({ notifications: [] });

    const ended = (await codex.end("seedrop-team")) as { space: { lifecycle: string } };
    expect(ended.space.lifecycle).toBe("ended");
  });

  it("replays an explicit post request id without duplicating the message", async () => {
    await codex.join("seedrop-team");
    const requestId = "33333333-3333-4333-8333-333333333333";
    const first = await codex.post("seedrop-team", { content: "exactly once", requestId }) as {
      request_id: string;
      replayed: boolean;
      message: { id: string };
    };
    const retry = await codex.post("seedrop-team", { content: "exactly once", requestId }) as typeof first;

    expect(first).toMatchObject({ request_id: requestId, replayed: false });
    expect(retry).toMatchObject({ request_id: requestId, replayed: true });
    expect(retry.message.id).toBe(first.message.id);
    const listed = await codex.messages("seedrop-team") as { messages: unknown[] };
    expect(listed.messages).toHaveLength(1);
  });

  it("acknowledges a continuity presence boundary through the client", async () => {
    const registered = await codex.register({ workingOn: "preserve" }) as { session: { id: string; last_seen_at: string } };
    const input = { sessionId: registered.session.id, observedAt: registered.session.last_seen_at };
    const first = await codex.acknowledgePresence(input) as { session: { id: string; last_seen_at: string; working_on: string } };
    const repeated = await codex.acknowledgePresence(input) as typeof first;

    expect(repeated).toEqual(first);
    expect(first.session).toMatchObject({ id: registered.session.id, last_seen_at: input.observedAt, working_on: "preserve" });
  });

  it("lists and explicitly retries post outbox commands", async () => {
    await codex.join("seedrop-team");
    const requestId = "55555555-5555-4555-8555-555555555555";
    await codex.post("seedrop-team", { content: "outbox-visible", requestId });

    const listed = await codex.postOutbox("seedrop-team", "completed") as {
      outbox: Array<{ state: string; attempt_count: number }>;
    };
    expect(listed.outbox).toEqual([expect.objectContaining({ state: "completed", attempt_count: 1 })]);
    await expect(codex.retryPostOutbox("seedrop-team", requestId)).resolves.toMatchObject({
      repaired: true,
      outbox: { state: "completed", attempt_count: 1 },
    });
    expect((await codex.messages("seedrop-team") as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("raises typed errors for unauthorized requests", async () => {
    const unknown = new SpaceHttpClient({ baseUrl: started.url, passportId: "unknown" });

    await expect(unknown.join("seedrop-team")).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<SpaceHttpClientError>);
  });

  it("turns outbox next_command responses into executable recovery", () => {
    const error = new SpaceHttpClientError(500, {
      error: {
        message: "post effects are dead-lettered",
        next_command: "seed space outbox-retry seedrop-team 55555555-5555-4555-8555-555555555555",
      },
    });
    expect(error.recovery).toEqual([
      expect.objectContaining({
        kind: "command",
        command: expect.stringContaining("outbox-retry"),
      }),
    ]);
    expect(renderRecovery(error)).toContain("outbox-retry");
  });

  it("wraps fetch failures with daemon status recovery guidance", async () => {
    const originalFetch = globalThis.fetch;
    const cause = Object.assign(new Error("connect EPERM 127.0.0.1:18791"), { code: "EPERM" });
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));
    try {
      await expect(codex.inbox()).rejects.toMatchObject({
        status: 0,
        message: expect.stringContaining("GET /inbox/codex"),
        body: {
          error: {
            code: "seedrop.http.fetch_failed",
            message: expect.stringContaining("GET /inbox/codex"),
            details: expect.objectContaining({
              method: "GET",
              path: "/inbox/codex",
              base_url: started.url,
              cause: expect.objectContaining({
                message: "fetch failed",
                cause: expect.objectContaining({
                  message: "connect EPERM 127.0.0.1:18791",
                  code: "EPERM",
                }),
              }),
            }),
            recovery: [expect.objectContaining({ command: "seed daemon status" })],
          },
        },
      } satisfies Partial<SpaceHttpClientError>);
      await codex.inbox().catch((error) => {
        expect(error.message).toContain("GET /inbox/codex");
        expect(error.message).toContain(started.url);
        expect(error.message).toContain("connect EPERM 127.0.0.1:18791");
        expect(error.message).toContain("EPERM");
        expect(renderRecovery(error)).toContain("seed daemon status");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves the post request id in transport failures", async () => {
    const originalFetch = globalThis.fetch;
    const requestId = "44444444-4444-4444-8444-444444444444";
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("connection dropped after write"));
    try {
      await expect(codex.post("seedrop-team", { content: "retry me", requestId })).rejects.toMatchObject({
        requestId,
        message: expect.stringContaining(`request_id=${requestId}`),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function writePassport(filePath: string, agentId: string, name: string): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify({
      version: "1.0",
      agent_id: agentId,
      name,
      purpose: "Test agent",
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
}
