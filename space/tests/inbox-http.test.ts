import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSpaceServer, type StartedSpaceServer } from "../src/index.js";

let root: string;
let mcPath: string;
let claudePath: string;
let codexPath: string;
let started: StartedSpaceServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seed-inbox-http-"));
  mcPath = path.join(root, "mc.json");
  claudePath = path.join(root, "claude.json");
  codexPath = path.join(root, "codex.json");
  await writeFile(
    mcPath,
    JSON.stringify({
      version: "1.0",
      agent_id: "mc",
      name: "mc",
      purpose: "op",
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
  await writeFile(
    claudePath,
    JSON.stringify({
      version: "1.0",
      agent_id: "claude",
      name: "claude",
      purpose: "code",
      issued_by: "mc",
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
  await writeFile(
    codexPath,
    JSON.stringify({
      version: "1.0",
      agent_id: "codex",
      name: "codex",
      purpose: "code",
      issued_by: "mc",
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

async function joinAs(url: string, passportId: string, space: string): Promise<void> {
  const r = await fetch(`${url}/spaces/${encodeURIComponent(space)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seedrop-passport": passportId },
    body: "{}",
  });
  if (!r.ok) throw new Error(`join → ${r.status}`);
}

async function postAs(
  url: string,
  passportId: string,
  space: string,
  content: string,
): Promise<{ message: { id: string }; mention_delivery?: { delivered: string[]; unknown: string[] } }> {
  const r = await fetch(`${url}/spaces/${encodeURIComponent(space)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seedrop-passport": passportId },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`post → ${r.status}`);
  return (await r.json()) as { message: { id: string }; mention_delivery?: { delivered: string[]; unknown: string[] } };
}

async function inbox(
  url: string,
  passportId: string,
  query: Record<string, string> = {},
): Promise<{ mentions: Array<{ id: string; content: string; acked_at?: string; delivered_at?: string }> }> {
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(`${url}/inbox/${encodeURIComponent(passportId)}${qs ? "?" + qs : ""}`, {
    headers: { "x-seedrop-passport": passportId },
  });
  if (!r.ok) throw new Error(`inbox → ${r.status}`);
  return (await r.json()) as { mentions: Array<{ id: string; content: string; acked_at?: string; delivered_at?: string }> };
}

async function ack(
  url: string,
  passportId: string,
  itemId: string,
  body: { result: string; note?: string; deferred_until?: string },
): Promise<Response> {
  return fetch(`${url}/inbox/${encodeURIComponent(passportId)}/${encodeURIComponent(itemId)}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seedrop-passport": passportId },
    body: JSON.stringify(body),
  });
}

describe("inbox HTTP", () => {
  it("@mention from mc creates an inbox row for claude with chain attached", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    await postAs(started.url, "mc", "team", "@claude please review the PR");

    const { mentions } = await inbox(started.url, "claude");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.content).toContain("@claude please review");
    expect(mentions[0]?.delivered_at).toBeDefined();
    expect(mentions[0]?.acked_at).toBeUndefined();
  });

  it("multiple mentions in one message create one row per recipient", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    await postAs(started.url, "mc", "team", "@claude and @codex see this");

    const claudeInbox = await inbox(started.url, "claude");
    const codexInbox = await inbox(started.url, "codex");
    expect(claudeInbox.mentions).toHaveLength(1);
    expect(codexInbox.mentions).toHaveLength(1);
  });

  it("retries a persisted message after mention failure without duplicate effects", async () => {
    let injectFailure = true;
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
      postOutboxFault: (phase) => {
        if (phase === "before_effects" && injectFailure) {
          injectFailure = false;
          throw new Error("injected mention failure");
        }
      },
    });
    await joinAs(started.url, "mc", "team");
    const requestId = randomUUID();

    const first = await rawPost(started.url, "mc", "team", "@claude retry me", requestId);
    expect(first.status).toBe(500);
    const failed = await first.json() as { error: { details: { message_id: string; request_id: string } } };
    expect(failed.error.details.request_id).toBe(requestId);

    const retry = await rawPost(started.url, "mc", "team", "@claude retry me", requestId);
    expect(retry.status).toBe(200);
    const replayed = await retry.json() as { request_id: string; replayed: boolean; message: { id: string } };
    expect(replayed).toMatchObject({ request_id: requestId, replayed: true });
    expect(replayed.message.id).toBe(failed.error.details.message_id);

    const third = await rawPost(started.url, "mc", "team", "@claude retry me", requestId);
    expect(third.status).toBe(200);
    const conflict = await rawPost(started.url, "mc", "team", "@claude changed payload", requestId);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "seedrop.space.request_conflict", details: { request_id: requestId } },
    });
    const messages = await fetch(`${started.url}/spaces/team/messages`, {
      headers: { "x-seedrop-passport": "mc" },
    }).then((response) => response.json()) as { messages: unknown[] };
    expect(messages.messages).toHaveLength(1);
    expect((await inbox(started.url, "claude")).mentions).toHaveLength(1);
  });

  it("persists pending effects before the message write and repairs the same command", async () => {
    let injectFailure = true;
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
      postOutboxFault: (phase) => {
        if (phase === "before_message" && injectFailure) {
          injectFailure = false;
          throw new Error("crash before message append");
        }
      },
    });
    await joinAs(started.url, "mc", "team");
    const requestId = randomUUID();

    const failed = await rawPost(started.url, "mc", "team", "@claude pending first", requestId);
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toMatchObject({
      error: {
        code: "seedrop.space.post_outbox_pending",
        details: { request_id: requestId, outbox_state: "pending", attempt_count: 1 },
      },
    });
    expect(await messages(started.url, "mc", "team")).toHaveLength(0);
    expect(await outbox(started.url, "mc", "team", "pending")).toEqual([
      expect.objectContaining({
        state: "pending",
        attempt_count: 1,
        effect_keys: [expect.stringMatching(/^mention:.*:claude$/)],
      }),
    ]);

    const retry = await rawPost(started.url, "mc", "team", "@claude pending first", requestId);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      replayed: true,
      outbox: { state: "completed", attempt_count: 2 },
    });
    expect(await messages(started.url, "mc", "team")).toHaveLength(1);
    expect((await inbox(started.url, "claude")).mentions).toHaveLength(1);
  });

  it("rolls mention rows back when finalizing the outbox fails", async () => {
    let injectFailure = true;
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
      postOutboxFault: (phase) => {
        if (phase === "after_effects" && injectFailure) {
          injectFailure = false;
          throw new Error("crash after mention insert");
        }
      },
    });
    await joinAs(started.url, "mc", "team");
    const requestId = randomUUID();

    expect((await rawPost(started.url, "mc", "team", "@claude rollback effects", requestId)).status).toBe(500);
    expect(await messages(started.url, "mc", "team")).toHaveLength(1);
    expect((await inbox(started.url, "claude")).mentions).toHaveLength(0);

    expect((await rawPost(started.url, "mc", "team", "@claude rollback effects", requestId)).status).toBe(200);
    expect(await messages(started.url, "mc", "team")).toHaveLength(1);
    expect((await inbox(started.url, "claude")).mentions).toHaveLength(1);
  });

  it("dead-letters poison effects and requires an explicit repair command", async () => {
    let poison = true;
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
      postOutboxMaxAttempts: 2,
      postOutboxFault: (phase) => {
        if (phase === "before_effects" && poison) throw new Error("poison mention effect");
      },
    });
    await joinAs(started.url, "mc", "team");
    const requestId = randomUUID();

    expect((await rawPost(started.url, "mc", "team", "@claude poison", requestId)).status).toBe(500);
    const second = await rawPost(started.url, "mc", "team", "@claude poison", requestId);
    expect(second.status).toBe(500);
    await expect(second.json()).resolves.toMatchObject({
      error: {
        code: "seedrop.space.post_outbox_dead_letter",
        retryable: false,
        next_command: expect.stringContaining(`outbox-retry`),
        details: { outbox_state: "dead_letter", attempt_count: 2 },
      },
    });
    const rejectedRetry = await rawPost(started.url, "mc", "team", "@claude poison", requestId);
    expect(rejectedRetry.status).toBe(500);
    expect(await outbox(started.url, "mc", "team", "dead_letter")).toEqual([
      expect.objectContaining({ state: "dead_letter", attempt_count: 2 }),
    ]);

    poison = false;
    const repaired = await retryOutbox(started.url, "mc", "team", requestId);
    expect(repaired.status).toBe(200);
    await expect(repaired.json()).resolves.toMatchObject({
      repaired: true,
      outbox: { state: "completed", attempt_count: 1 },
    });
    expect(await messages(started.url, "mc", "team")).toHaveLength(1);
    expect((await inbox(started.url, "claude")).mentions).toHaveLength(1);
  });

  it("ignores @unknown_id (no inbox row created)", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    const post = await postAs(started.url, "mc", "team", "hey @ghost are you around?");
    expect(post.mention_delivery?.unknown).toEqual(["ghost"]);
    const claudeInbox = await inbox(started.url, "claude");
    const codexInbox = await inbox(started.url, "codex");
    expect(claudeInbox.mentions).toHaveLength(0);
    expect(codexInbox.mentions).toHaveLength(0);
  });

  it("ack with result moves the row out of unacked", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    await postAs(started.url, "mc", "team", "@claude review");
    const before = await inbox(started.url, "claude");
    const id = before.mentions[0]!.id;

    const ackResp = await ack(started.url, "claude", id, { result: "done", note: "reviewed and approved" });
    expect(ackResp.status).toBe(200);

    const unacked = await inbox(started.url, "claude", { unacked_only: "true" });
    expect(unacked.mentions).toHaveLength(0);

    const all = await inbox(started.url, "claude");
    expect(all.mentions).toHaveLength(1);
    expect(all.mentions[0]?.acked_at).toBeDefined();
  });

  it("ack accepts a unique short mention prefix", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    await postAs(started.url, "mc", "team", "@claude review");
    const before = await inbox(started.url, "claude");
    const id = before.mentions[0]!.id;

    const ackResp = await ack(started.url, "claude", id.slice(0, 8), { result: "done" });
    expect(ackResp.status).toBe(200);
    const payload = await ackResp.json() as { mention: { id: string; acked_at?: string } };
    expect(payload.mention.id).toBe(id);
    expect(payload.mention.acked_at).toBeDefined();
  });

  it("rejects ack from a non-recipient passport", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    await postAs(started.url, "mc", "team", "@claude review");
    const before = await inbox(started.url, "claude");
    const id = before.mentions[0]!.id;

    // codex tries to ack claude's mention; should be 403.
    const r = await fetch(`${started.url}/inbox/${encodeURIComponent("claude")}/${encodeURIComponent(id)}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seedrop-passport": "codex" },
      body: JSON.stringify({ result: "done" }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects inbox read for a different passport", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    const r = await fetch(`${started.url}/inbox/${encodeURIComponent("claude")}`, {
      headers: { "x-seedrop-passport": "codex" },
    });
    expect(r.status).toBe(403);
  });

  it("rejects invalid ack result", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, codexPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    await postAs(started.url, "mc", "team", "@claude review");
    const before = await inbox(started.url, "claude");
    const id = before.mentions[0]!.id;
    const r = await ack(started.url, "claude", id, { result: "lol" });
    expect(r.ok).toBe(false);
  });
});

function rawPost(
  url: string,
  passportId: string,
  space: string,
  content: string,
  requestId: string,
): Promise<Response> {
  return fetch(`${url}/spaces/${encodeURIComponent(space)}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-seedrop-passport": passportId,
      "x-seedrop-request-id": requestId,
    },
    body: JSON.stringify({ content }),
  });
}

async function messages(url: string, passportId: string, space: string): Promise<unknown[]> {
  const response = await fetch(`${url}/spaces/${encodeURIComponent(space)}/messages`, {
    headers: { "x-seedrop-passport": passportId },
  });
  const payload = await response.json() as { messages: unknown[] };
  return payload.messages;
}

async function outbox(
  url: string,
  passportId: string,
  space: string,
  state?: string,
): Promise<Array<{ state: string; attempt_count: number; effect_keys: string[] }>> {
  const query = state ? `?state=${encodeURIComponent(state)}` : "";
  const response = await fetch(`${url}/spaces/${encodeURIComponent(space)}/outbox${query}`, {
    headers: { "x-seedrop-passport": passportId },
  });
  const payload = await response.json() as { outbox: Array<{ state: string; attempt_count: number; effect_keys: string[] }> };
  return payload.outbox;
}

function retryOutbox(url: string, passportId: string, space: string, requestId: string): Promise<Response> {
  return fetch(
    `${url}/spaces/${encodeURIComponent(space)}/outbox/${encodeURIComponent(requestId)}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-seedrop-passport": passportId },
      body: "{}",
    },
  );
}
