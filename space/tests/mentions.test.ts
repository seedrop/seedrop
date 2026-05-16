import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mentions } from "../src/mentions.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seed-mentions-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const baseInsert = {
  messageId: "msg-1",
  spaceId: "space-1",
  spaceName: "seedrop-team",
  senderPassportId: "mc",
  senderPrincipalChain: ["mc"],
  content: "@claude please review",
  createdAt: "2026-05-15T10:00:00.000Z",
};

describe("Mentions storage", () => {
  it("inserts and lists rows for a recipient", async () => {
    const inserted = await Mentions.insertMany(
      [{ ...baseInsert, recipientPassportId: "claude" }],
      { root },
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.delivered_at).toBeUndefined();

    const rows = await Mentions.list({ root, recipientPassportId: "claude" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered_at).toBeDefined();
    expect(rows[0]?.recipient_passport_id).toBe("claude");
    expect(rows[0]?.sender_principal_chain).toEqual(["mc"]);
  });

  it("delivered_at is sticky on second fetch", async () => {
    await Mentions.insertMany([{ ...baseInsert, recipientPassportId: "claude" }], { root });
    const first = await Mentions.list({ root, recipientPassportId: "claude" });
    const second = await Mentions.list({ root, recipientPassportId: "claude" });
    expect(second[0]?.delivered_at).toBe(first[0]?.delivered_at);
  });

  it("does not mark delivered when markDelivered=false", async () => {
    await Mentions.insertMany([{ ...baseInsert, recipientPassportId: "claude" }], { root });
    const rows = await Mentions.list({ root, recipientPassportId: "claude", markDelivered: false });
    expect(rows[0]?.delivered_at).toBeUndefined();
  });

  it("filters to unackedOnly", async () => {
    const inserted = await Mentions.insertMany(
      [
        { ...baseInsert, messageId: "msg-a", recipientPassportId: "claude" },
        { ...baseInsert, messageId: "msg-b", recipientPassportId: "claude" },
      ],
      { root },
    );
    await Mentions.ack({
      root,
      id: inserted[0]!.id,
      recipientPassportId: "claude",
      result: "done",
    });
    const unacked = await Mentions.list({ root, recipientPassportId: "claude", unackedOnly: true });
    expect(unacked).toHaveLength(1);
    expect(unacked[0]?.message_id).toBe("msg-b");
  });

  it("ack records result + note + deferred_until", async () => {
    const inserted = await Mentions.insertMany(
      [{ ...baseInsert, recipientPassportId: "claude" }],
      { root },
    );
    const acked = await Mentions.ack({
      root,
      id: inserted[0]!.id,
      recipientPassportId: "claude",
      result: "deferred",
      note: "tomorrow",
      deferredUntil: "2026-05-16T09:00:00.000Z",
    });
    expect(acked.ack_result).toBe("deferred");
    expect(acked.ack_note).toBe("tomorrow");
    expect(acked.deferred_until).toBe("2026-05-16T09:00:00.000Z");
    expect(acked.acked_at).toBeDefined();
  });

  it("rejects invalid ack result", async () => {
    const inserted = await Mentions.insertMany(
      [{ ...baseInsert, recipientPassportId: "claude" }],
      { root },
    );
    await expect(
      Mentions.ack({
        root,
        id: inserted[0]!.id,
        recipientPassportId: "claude",
        // @ts-expect-error testing invalid input
        result: "lol",
      }),
    ).rejects.toThrow();
  });

  it("rejects ack for unknown id", async () => {
    await expect(
      Mentions.ack({ root, id: "nope", recipientPassportId: "claude", result: "done" }),
    ).rejects.toThrow();
  });

  it("rejects ack from wrong recipient", async () => {
    const inserted = await Mentions.insertMany(
      [{ ...baseInsert, recipientPassportId: "claude" }],
      { root },
    );
    await expect(
      Mentions.ack({ root, id: inserted[0]!.id, recipientPassportId: "codex", result: "done" }),
    ).rejects.toThrow();
  });

  it("countUnacked excludes acked rows", async () => {
    const inserted = await Mentions.insertMany(
      [
        { ...baseInsert, messageId: "m1", recipientPassportId: "claude" },
        { ...baseInsert, messageId: "m2", recipientPassportId: "claude" },
        { ...baseInsert, messageId: "m3", recipientPassportId: "codex" },
      ],
      { root },
    );
    await Mentions.ack({ root, id: inserted[0]!.id, recipientPassportId: "claude", result: "done" });
    expect(await Mentions.countUnacked("claude", { root })).toBe(1);
    expect(await Mentions.countUnacked("codex", { root })).toBe(1);
    expect(await Mentions.countUnacked("nobody", { root })).toBe(0);
  });
});
