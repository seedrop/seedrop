#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/index.js";

interface StepResult {
  step: number;
  name: string;
  status: "pass" | "fail" | "pending";
  detail?: string;
}

const results: StepResult[] = [];

function record(step: number, name: string, status: StepResult["status"], detail?: string): void {
  results.push({ step, name, status, detail });
  const icon = status === "pass" ? "✓" : status === "fail" ? "✗" : "·";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`  ${icon} step ${String(step).padStart(2)}: ${name}${suffix}`);
}

async function call(
  baseUrl: string,
  method: string,
  pathSuffix: string,
  init: { body?: unknown; passport?: string } = {},
): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.passport) {
    headers["x-seedrop-passport"] = init.passport;
  }
  const response = await fetch(`${baseUrl}${pathSuffix}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`${method} ${pathSuffix} → ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function main(): Promise<void> {
  console.log("seed-space smoke (HTTP)");
  console.log("────────────────────────");

  const root = await mkdtemp(path.join(os.tmpdir(), "seed-space-smoke-http-"));
  const server = createServer({ root });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let exitCode = 0;

  try {
    record(1, "wipe temp dir + start server", "pass", baseUrl);

    const alpha = await call(baseUrl, "POST", "/sessions", {
      passport: "alpha",
      body: { workingOn: "smoke test" },
    });
    record(2, "register alpha session", "pass", alpha.session.id.slice(0, 8));

    const beta = await call(baseUrl, "POST", "/sessions", {
      passport: "beta",
      body: { workingOn: "smoke test" },
    });
    record(3, "register beta session", "pass", beta.session.id.slice(0, 8));

    const roomName = "smoke-test-room";
    const opened = await call(baseUrl, "POST", `/spaces/${encodeURIComponent(roomName)}/join`, {
      passport: "alpha",
      body: {},
    });
    record(4, "alpha opens space", "pass", opened.space.id);

    const joined = await call(baseUrl, "POST", `/spaces/${encodeURIComponent(roomName)}/join`, {
      passport: "beta",
      body: {},
    });
    if (joined.space.id !== opened.space.id) {
      throw new Error(`beta joined a different space: ${joined.space.id} !== ${opened.space.id}`);
    }
    record(5, "beta joins space", "pass");

    const posted = await call(baseUrl, "POST", `/spaces/${encodeURIComponent(roomName)}/messages`, {
      passport: "alpha",
      body: { content: "hello from alpha" },
    });
    record(6, "alpha posts a message", "pass", posted.message.id.slice(0, 8));

    const seen = await call(baseUrl, "GET", `/spaces/${encodeURIComponent(roomName)}/messages`, {
      passport: "beta",
    });
    if (seen.messages.length !== 1 || seen.messages[0]?.content !== "hello from alpha") {
      throw new Error(`beta did not see alpha's message: ${JSON.stringify(seen)}`);
    }
    record(7, "beta reads the message", "pass");

    const sent = await call(baseUrl, "POST", "/notifications", {
      passport: "alpha",
      body: {
        recipientPassportId: "beta",
        pointer: { kind: "space-message", ref: `${opened.space.id}/${posted.message.id}` },
      },
    });
    record(8, "alpha sends notification to beta", "pass", sent.notification.id.slice(0, 8));

    const notifs = await call(baseUrl, "GET", "/notifications", { passport: "beta" });
    if (notifs.notifications.length !== 1 || notifs.notifications[0]?.id !== sent.notification.id) {
      throw new Error(`beta did not see expected notification: ${JSON.stringify(notifs)}`);
    }
    record(9, "beta lists notifications", "pass");

    await call(baseUrl, "POST", `/notifications/${encodeURIComponent(sent.notification.id)}/ack`, {
      passport: "beta",
      body: {},
    });
    record(10, "beta acks notification", "pass");

    const afterAck = await call(baseUrl, "GET", "/notifications", { passport: "beta" });
    if (afterAck.notifications.length !== 0) {
      throw new Error(`notification list not empty after ack: ${JSON.stringify(afterAck)}`);
    }
    record(11, "notification list empties on ack", "pass");

    await call(baseUrl, "POST", `/spaces/${encodeURIComponent(roomName)}/end`, {
      passport: "alpha",
      body: {},
    });
    record(12, "alpha ends the space", "pass");

    const endedRead = await call(baseUrl, "GET", `/spaces/${encodeURIComponent(roomName)}/messages`, {
      passport: "alpha",
    });
    if (endedRead.messages.length !== 1) {
      throw new Error(`ended space lost its messages: ${JSON.stringify(endedRead)}`);
    }
    record(13, "space lifecycle ended + messages still readable", "pass");

    const replayed = await call(baseUrl, "GET", `/spaces/${encodeURIComponent(roomName)}/messages`, {
      passport: "alpha",
    });
    if (replayed.messages[0]?.content !== "hello from alpha") {
      throw new Error(`message log not replayable through HTTP: ${JSON.stringify(replayed)}`);
    }
    record(14, "message log replays through HTTP after end", "pass");

    await rm(path.join(root, ".seedrop", "space", "live.db"), { force: true });

    await call(baseUrl, "POST", "/sessions", { passport: "alpha", body: {} });
    await call(baseUrl, "POST", "/sessions", { passport: "beta", body: {} });

    const postWipe = await call(baseUrl, "GET", `/spaces/${encodeURIComponent(roomName)}/messages`, {
      passport: "alpha",
    });
    if (postWipe.messages.length !== 1 || postWipe.messages[0]?.content !== "hello from alpha") {
      throw new Error(`message log corrupted after live.db wipe: ${JSON.stringify(postWipe)}`);
    }
    record(15, "wipe live.db; durable history intact through HTTP", "pass");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const nextStep = results.length + 1;
    record(nextStep, "unexpected failure", "fail", message);
    exitCode = 1;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const pending = results.filter((r) => r.status === "pending").length;

  console.log("────────────────────────");
  console.log(`pass:${passed}  fail:${failed}  pending:${pending}`);

  if (failed > 0) {
    exitCode = 1;
  }
  process.exit(exitCode);
}

await main();
