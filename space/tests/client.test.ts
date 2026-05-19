import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("raises typed errors for unauthorized requests", async () => {
    const unknown = new SpaceHttpClient({ baseUrl: started.url, passportId: "unknown" });

    await expect(unknown.join("seedrop-team")).rejects.toMatchObject({
      status: 401,
    } satisfies Partial<SpaceHttpClientError>);
  });

  it("wraps fetch failures with daemon status recovery guidance", async () => {
    const originalFetch = globalThis.fetch;
    const cause = Object.assign(new Error("connect EPERM 127.0.0.1:18791"), { code: "EPERM" });
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));
    try {
      await expect(codex.inbox()).rejects.toMatchObject({
        status: 0,
        message: expect.stringContaining("seed daemon status"),
        body: {
          error: {
            code: "seedrop.http.fetch_failed",
            recovery: [expect.objectContaining({ command: "seed daemon status" })],
          },
        },
      } satisfies Partial<SpaceHttpClientError>);
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
