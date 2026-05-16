#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Notification, Presence, Space, SpaceStore } from "../src/index.js";

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

async function main(): Promise<void> {
  console.log("seed-space smoke");
  console.log("─────────────────");

  const root = await mkdtemp(path.join(os.tmpdir(), "seed-space-smoke-"));
  let exitCode = 0;

  try {
    record(1, "wipe temp dir", "pass", root);

    const alpha = await Presence.register({ root, passportId: "alpha", workingOn: "smoke test" });
    record(2, "register alpha session", "pass", alpha.id.slice(0, 8));

    const beta = await Presence.register({ root, passportId: "beta", workingOn: "smoke test" });
    record(3, "register beta session", "pass", beta.id.slice(0, 8));

    const room = await Space.open("smoke-test-room", { root, passportId: "alpha" });
    record(4, "alpha opens space", "pass", room.meta.id);

    const joined = await Space.join("smoke-test-room", { root, passportId: "beta" });
    if (joined.meta.id !== room.meta.id) {
      throw new Error(`beta joined a different space: ${joined.meta.id} !== ${room.meta.id}`);
    }
    record(5, "beta joins space", "pass");

    const posted = await room.post({ content: "hello from alpha" });
    record(6, "alpha posts a message", "pass", posted.id.slice(0, 8));

    const seen = await joined.messages();
    if (seen.length !== 1 || seen[0]?.content !== "hello from alpha") {
      throw new Error(`beta did not see alpha's message: ${JSON.stringify(seen)}`);
    }
    record(7, "beta reads the message", "pass");

    const notification = await Notification.send({
      root,
      senderPassportId: "alpha",
      recipientPassportId: "beta",
      pointer: { kind: "space-message", ref: `${room.meta.id}/${posted.id}` },
    });
    record(8, "alpha sends notification to beta", "pass", notification.id.slice(0, 8));

    const notifications = await Notification.list({ root, recipientPassportId: "beta" });
    if (notifications.length !== 1 || notifications[0]?.pointer.ref !== `${room.meta.id}/${posted.id}`) {
      throw new Error(`beta did not see expected notification: ${JSON.stringify(notifications)}`);
    }
    record(9, "beta lists notifications", "pass");

    await Notification.ack({ root, recipientPassportId: "beta", notificationId: notification.id });
    record(10, "beta acks notification", "pass");

    const afterAck = await Notification.list({ root, recipientPassportId: "beta" });
    if (afterAck.length !== 0) {
      throw new Error(`notification list not empty after ack: ${JSON.stringify(afterAck)}`);
    }
    record(11, "notification list empties on ack", "pass");

    await room.end();
    record(12, "alpha ends the space", "pass");

    const spaces = await Space.list({ root });
    const ended = spaces.find((s) => s.id === room.meta.id);
    if (!ended || ended.lifecycle !== "ended") {
      throw new Error(`space is not in ended state: ${JSON.stringify(ended)}`);
    }
    record(13, "space lifecycle is ended", "pass");

    const store = SpaceStore.open({ root });
    const replayed = await store.readMessages(room.meta.id);
    if (replayed.length !== 1 || replayed[0]?.content !== "hello from alpha") {
      throw new Error(`message log not replayable after end: ${JSON.stringify(replayed)}`);
    }
    record(14, "message log replays after end", "pass");

    const liveDb = path.join(root, ".seedrop", "space", "live.db");
    await rm(liveDb, { force: true });

    const resumedAlpha = await Presence.register({ root, passportId: "alpha" });
    const resumedBeta = await Presence.register({ root, passportId: "beta" });
    if (!resumedAlpha.id || !resumedBeta.id) {
      throw new Error("re-registration after live.db wipe failed");
    }

    const postWipe = await store.readMessages(room.meta.id);
    if (postWipe.length !== 1 || postWipe[0]?.content !== "hello from alpha") {
      throw new Error(`message log corrupted after live.db wipe: ${JSON.stringify(postWipe)}`);
    }
    record(15, "wipe live.db; durable history intact", "pass");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const nextStep = results.length + 1;
    record(nextStep, "unexpected failure", "fail", message);
    exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const pending = results.filter((r) => r.status === "pending").length;

  console.log("─────────────────");
  console.log(`pass:${passed}  fail:${failed}  pending:${pending}`);

  if (failed > 0) {
    exitCode = 1;
  }
  process.exit(exitCode);
}

await main();
