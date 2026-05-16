import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Presence,
  Space,
  SpaceNotFoundError,
  SpaceStore,
  SpaceValidationError,
} from "../src/index.js";

let root: string;
let currentTime: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-presence-"));
  currentTime = new Date("2026-05-14T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function now(): Date {
  return currentTime;
}

describe("Presence", () => {
  it("registers a session and stamps created_at and last_seen_at to the same time", async () => {
    const session = await Presence.register({ root, passportId: "alpha", workingOn: "drafting charter", now });

    expect(session.passport_id).toBe("alpha");
    expect(session.created_at).toBe("2026-05-14T10:00:00.000Z");
    expect(session.last_seen_at).toBe("2026-05-14T10:00:00.000Z");
    expect(session.working_on).toBe("drafting charter");
  });

  it("requires a passportId", async () => {
    await expect(Presence.register({ root, passportId: "", now })).rejects.toBeInstanceOf(SpaceValidationError);
  });

  it("updates last_seen_at on heartbeat and clears working_on when omitted", async () => {
    const session = await Presence.register({ root, passportId: "alpha", workingOn: "task-1", now });

    currentTime = new Date("2026-05-14T10:00:30.000Z");
    const beat = await Presence.heartbeat({ root, sessionId: session.id, now });

    expect(beat.last_seen_at).toBe("2026-05-14T10:00:30.000Z");
    expect(beat.working_on).toBeUndefined();
  });

  it("overwrites working_on when supplied to heartbeat", async () => {
    const session = await Presence.register({ root, passportId: "alpha", workingOn: "task-1", now });

    currentTime = new Date("2026-05-14T10:00:30.000Z");
    const beat = await Presence.heartbeat({ root, sessionId: session.id, workingOn: "task-2", now });
    expect(beat.working_on).toBe("task-2");
  });

  it("throws SpaceNotFoundError when heartbeating an unknown session", async () => {
    await expect(Presence.heartbeat({ root, sessionId: "missing", now })).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it("lists registered sessions and marks them online within ttl", async () => {
    await Presence.register({ root, passportId: "alpha", spaceId: "space-1", now });
    currentTime = new Date("2026-05-14T10:00:30.000Z");
    const list = await Presence.list({ root, now, ttlMs: 60_000 });

    expect(list).toHaveLength(1);
    expect(list[0]?.passport_id).toBe("alpha");
    expect(list[0]?.online).toBe(true);
  });

  it("marks sessions offline once their last_seen_at is older than ttl", async () => {
    await Presence.register({ root, passportId: "alpha", now });
    currentTime = new Date("2026-05-14T10:05:00.000Z");
    const list = await Presence.list({ root, now, ttlMs: 60_000 });
    expect(list[0]?.online).toBe(false);
  });

  it("filters list by space_id and passport_id", async () => {
    await Presence.register({ root, passportId: "alpha", spaceId: "space-1", now });
    await Presence.register({ root, passportId: "beta", spaceId: "space-2", now });
    await Presence.register({ root, passportId: "alpha", spaceId: "space-2", now });

    const space1 = await Presence.list({ root, spaceId: "space-1", now });
    expect(space1.map((row) => row.passport_id)).toEqual(["alpha"]);

    const onlyAlpha = await Presence.list({ root, passportId: "alpha", now });
    expect(onlyAlpha.every((row) => row.passport_id === "alpha")).toBe(true);
    expect(onlyAlpha).toHaveLength(2);
  });

  it("ends a session and removes it from the live store", async () => {
    const session = await Presence.register({ root, passportId: "alpha", now });
    await Presence.end({ root, sessionId: session.id });
    await expect(Presence.list({ root, now })).resolves.toEqual([]);
  });

  it("throws SpaceNotFoundError when ending an unknown session", async () => {
    await expect(Presence.end({ root, sessionId: "missing" })).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it("re-registers after live.db is wiped without losing durable space history", async () => {
    const space = await Space.open("Build Room", { root, passportId: "alpha", now });
    await space.post({ content: "First." });
    await Presence.register({ root, passportId: "alpha", spaceId: space.meta.id, now });

    await rm(path.join(root, ".seedrop", "space", "live.db"), { force: true });

    currentTime = new Date("2026-05-14T10:10:00.000Z");
    const resumed = await Presence.register({ root, passportId: "alpha", spaceId: space.meta.id, now });
    expect(resumed.passport_id).toBe("alpha");

    const store = SpaceStore.open({ root });
    await expect(store.readMessages(space.meta.id)).resolves.toEqual([
      expect.objectContaining({ content: "First." }),
    ]);
  });

  it("does not duplicate sessions after a wipe + re-register", async () => {
    await Presence.register({ root, passportId: "alpha", now });
    await rm(path.join(root, ".seedrop", "space", "live.db"), { force: true });
    await Presence.register({ root, passportId: "alpha", now });
    const list = await Presence.list({ root, now });
    expect(list).toHaveLength(1);
  });

  it("creates the live.db file in the configured dataDir", async () => {
    await Presence.register({ root, passportId: "alpha", now });
    await expect(readFile(path.join(root, ".seedrop", "space", "live.db"))).resolves.toBeTruthy();
  });

  it("tolerates a manually-created data dir prior to first register", async () => {
    await mkdir(path.join(root, ".seedrop", "space"), { recursive: true });
    await writeFile(path.join(root, ".seedrop", "space", "notes.txt"), "stray\n");
    await expect(Presence.register({ root, passportId: "alpha", now })).resolves.toBeTruthy();
  });

  it("falls back to wall-clock time when no clock is injected", async () => {
    const before = Date.now();
    const session = await Presence.register({ root, passportId: "alpha" });
    const after = Date.now();
    const stamp = new Date(session.created_at).getTime();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });
});
