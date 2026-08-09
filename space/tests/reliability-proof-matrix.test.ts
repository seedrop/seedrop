import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startSpaceServer,
  type PostOutboxFaultPhase,
  type StartedSpaceServer,
} from "../src/index.js";

const SPACE = "reliability-proof";

let root: string;
let authorPassport: string;
let recipientPassport: string;
let started: StartedSpaceServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-reliability-proof-"));
  authorPassport = await writePassport("author");
  recipientPassport = await writePassport("recipient", "author");
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

describe("Wave 1B PR-09 outbox reliability proof matrix", () => {
  it.each([
    ["before_message", 0],
    ["after_message", 1],
    ["before_effects", 1],
    ["after_effects", 1],
  ] as const)(
    "redelivers after a %s fault with one logical message and one mention",
    async (faultPhase, messagesAfterFault) => {
      let armed = true;
      await start({
        fault: (phase) => {
          if (armed && phase === faultPhase) {
            armed = false;
            throw new Error(`injected ${faultPhase} fault`);
          }
        },
      });
      const requestId = randomUUID();

      const failed = await post(requestId, "@recipient prove redelivery");
      expect(failed.status).toBe(500);
      await expect(failed.json()).resolves.toMatchObject({
        error: {
          code: "seedrop.space.post_outbox_pending",
          retryable: true,
          details: {
            request_id: requestId,
            outbox_state: "pending",
            attempt_count: 1,
          },
        },
      });
      expect(await messageCount()).toBe(messagesAfterFault);
      expect(await mentionCount()).toBe(0);

      const retried = await post(requestId, "@recipient prove redelivery");
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toMatchObject({
        request_id: requestId,
        replayed: true,
        outbox: {
          state: "completed",
          attempt_count: 2,
          effect_keys: [expect.stringMatching(/^mention:.*:recipient$/)],
        },
      });

      const replayed = await post(requestId, "@recipient prove redelivery");
      expect(replayed.status).toBe(200);
      expect(await messageCount()).toBe(1);
      expect(await mentionCount()).toBe(1);
      await expect(outbox()).resolves.toEqual([
        expect.objectContaining({
          state: "completed",
          attempt_count: 2,
          effect_keys: [expect.stringMatching(/^mention:.*:recipient$/)],
        }),
      ]);
    },
  );

  it("makes poison effects explicit, non-automatic, and repairable", async () => {
    let poison = true;
    await start({
      maxAttempts: 2,
      fault: (phase) => {
        if (poison && phase === "before_effects") throw new Error("poison mention effect");
      },
    });
    const requestId = randomUUID();

    expect((await post(requestId, "@recipient prove dead letter")).status).toBe(500);
    const exhausted = await post(requestId, "@recipient prove dead letter");
    expect(exhausted.status).toBe(500);
    await expect(exhausted.json()).resolves.toMatchObject({
      error: {
        code: "seedrop.space.post_outbox_dead_letter",
        retryable: false,
        next_command: `seed space outbox-retry \"${SPACE}\" ${requestId}`,
        details: {
          request_id: requestId,
          outbox_state: "dead_letter",
          attempt_count: 2,
        },
      },
    });
    expect(await messageCount()).toBe(1);
    expect(await mentionCount()).toBe(0);
    await expect(outbox("dead_letter")).resolves.toEqual([
      expect.objectContaining({
        state: "dead_letter",
        attempt_count: 2,
        last_error: "poison mention effect",
        effect_keys: [expect.stringMatching(/^mention:.*:recipient$/)],
      }),
    ]);

    const automaticRetry = await post(requestId, "@recipient prove dead letter");
    expect(automaticRetry.status).toBe(500);
    poison = false;
    const repaired = await repair(requestId);
    expect(repaired.status).toBe(200);
    await expect(repaired.json()).resolves.toMatchObject({
      request_id: requestId,
      repaired: true,
      outbox: { state: "completed", attempt_count: 1 },
    });
    expect(await messageCount()).toBe(1);
    expect(await mentionCount()).toBe(1);
  });

  it("rejects request-id reuse with a different command without adding effects", async () => {
    await start({});
    const requestId = randomUUID();

    expect((await post(requestId, "@recipient original command")).status).toBe(201);
    const conflict = await post(requestId, "@recipient mutated command");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: {
        code: "seedrop.space.request_conflict",
        retryable: false,
        details: { request_id: requestId },
      },
    });
    expect(await messageCount()).toBe(1);
    expect(await mentionCount()).toBe(1);
  });
});

async function writePassport(agentId: string, issuedBy?: string): Promise<string> {
  const passportPath = path.join(root, `${agentId}.json`);
  await writeFile(passportPath, JSON.stringify({
    version: "1.0",
    agent_id: agentId,
    name: agentId,
    purpose: "PR-09 executable reliability proof",
    ...(issuedBy ? { issued_by: issuedBy } : {}),
    core_commitments: [],
    value_anchors: [],
    competencies: [],
    limits: [],
    learned_blocks: [],
    metadata: { created_at: "2026-08-09T09:00:00.000Z", session_count: 0 },
  }));
  return passportPath;
}

async function start(options: {
  fault?: (phase: PostOutboxFaultPhase) => void;
  maxAttempts?: number;
}): Promise<void> {
  started = await startSpaceServer({
    root,
    passportPaths: [authorPassport, recipientPassport],
    port: 0,
    postOutboxFault: options.fault,
    postOutboxMaxAttempts: options.maxAttempts,
  });
  const response = await fetch(`${started.url}/spaces/${SPACE}/join`, {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(response.status).toBe(200);
}

function post(requestId: string, content: string): Promise<Response> {
  return fetch(`${started!.url}/spaces/${SPACE}/messages`, {
    method: "POST",
    headers: headers({ "x-seedrop-request-id": requestId }),
    body: JSON.stringify({ content }),
  });
}

function repair(requestId: string): Promise<Response> {
  return fetch(`${started!.url}/spaces/${SPACE}/outbox/${requestId}/retry`, {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
}

async function messageCount(): Promise<number> {
  const response = await fetch(`${started!.url}/spaces/${SPACE}/messages`, {
    headers: { "x-seedrop-passport": "author" },
  });
  const payload = await response.json() as { messages: unknown[] };
  return payload.messages.length;
}

async function mentionCount(): Promise<number> {
  const response = await fetch(`${started!.url}/inbox/recipient`, {
    headers: { "x-seedrop-passport": "recipient" },
  });
  const payload = await response.json() as { mentions: unknown[] };
  return payload.mentions.length;
}

async function outbox(state?: string): Promise<unknown[]> {
  const query = state ? `?state=${state}` : "";
  const response = await fetch(`${started!.url}/spaces/${SPACE}/outbox${query}`, {
    headers: { "x-seedrop-passport": "author" },
  });
  const payload = await response.json() as { outbox: unknown[] };
  return payload.outbox;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-seedrop-passport": "author",
    ...extra,
  };
}
