import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Notification, SpaceNotFoundError, SpaceStore, SpaceValidationError } from "../src/index.js";

let root: string;
let currentTime: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-notification-"));
  currentTime = new Date("2026-05-14T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function now(): Date {
  return currentTime;
}

const pointer = { kind: "space-message", ref: "space-1/message-1" };

describe("Notification", () => {
  it("sends and lists active pointer notifications", async () => {
    const sent = await Notification.send({
      root,
      recipientPassportId: "beta",
      senderPassportId: "alpha",
      pointer,
      now,
    });

    expect(sent).toMatchObject({
      schema_version: "1.0",
      recipient_passport_id: "beta",
      sender_passport_id: "alpha",
      created_at: "2026-05-14T10:00:00.000Z",
      expires_at: "2026-05-14T11:00:00.000Z",
      pointer,
      acked_at: null,
    });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(Notification.list({ root, recipientPassportId: "beta", now })).resolves.toEqual([sent]);
  });

  it("filters expired notifications", async () => {
    await Notification.send({
      root,
      recipientPassportId: "beta",
      senderPassportId: "alpha",
      pointer,
      ttlMs: 1000,
      now,
    });

    currentTime = new Date("2026-05-14T10:00:02.000Z");
    await expect(Notification.list({ root, recipientPassportId: "beta", now })).resolves.toEqual([]);
  });

  it("acks by appending a same-stream tombstone event", async () => {
    const sent = await Notification.send({
      root,
      recipientPassportId: "beta",
      senderPassportId: "alpha",
      pointer,
      now,
    });

    currentTime = new Date("2026-05-14T10:01:00.000Z");
    const acked = await Notification.ack({
      root,
      recipientPassportId: "beta",
      notificationId: sent.id,
      now,
    });

    expect(acked).toEqual({ ...sent, acked_at: "2026-05-14T10:01:00.000Z" });
    await expect(Notification.list({ root, recipientPassportId: "beta", now })).resolves.toEqual([]);

    const raw = await SpaceStore.open({ root }).readNotifications("beta");
    expect(raw).toEqual([sent, acked]);
  });

  it("uses the latest event per id when replaying notification streams", async () => {
    const sent = await Notification.send({
      root,
      recipientPassportId: "beta",
      senderPassportId: "alpha",
      pointer,
      now,
    });
    const store = SpaceStore.open({ root });
    await store.appendNotification({
      ...sent,
      created_at: "2026-05-14T10:02:00.000Z",
      expires_at: "2026-05-14T12:00:00.000Z",
      pointer: { kind: "space-message", ref: "space-1/message-2" },
    });

    await expect(Notification.list({ root, recipientPassportId: "beta", now })).resolves.toEqual([
      {
        ...sent,
        created_at: "2026-05-14T10:02:00.000Z",
        expires_at: "2026-05-14T12:00:00.000Z",
        pointer: { kind: "space-message", ref: "space-1/message-2" },
      },
    ]);
  });

  it("throws a typed error when acking an unknown notification", async () => {
    await expect(
      Notification.ack({ root, recipientPassportId: "beta", notificationId: "missing", now }),
    ).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it("validates required send fields", async () => {
    await expect(
      Notification.send({ root, recipientPassportId: "", senderPassportId: "alpha", pointer, now }),
    ).rejects.toBeInstanceOf(SpaceValidationError);
    await expect(
      Notification.send({ root, recipientPassportId: "beta", senderPassportId: "", pointer, now }),
    ).rejects.toBeInstanceOf(SpaceValidationError);
  });

  it("validates required list and ack fields", async () => {
    await expect(Notification.list({ root, recipientPassportId: "", now })).rejects.toBeInstanceOf(SpaceValidationError);
    await expect(
      Notification.ack({ root, recipientPassportId: "beta", notificationId: "", now }),
    ).rejects.toBeInstanceOf(SpaceValidationError);
  });
});
