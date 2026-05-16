import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Presence } from "../src/presence.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seed-refresh-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Presence.refreshByPassport", () => {
  it("bumps last_seen_at on existing sessions", async () => {
    const t0 = new Date("2026-05-15T08:00:00.000Z");
    const t1 = new Date("2026-05-15T08:05:00.000Z");
    const session = await Presence.register({
      root,
      passportId: "claude",
      now: () => t0,
    });
    expect(session.last_seen_at).toBe(t0.toISOString());

    const changes = await Presence.refreshByPassport({
      root,
      passportId: "claude",
      now: () => t1,
    });
    expect(changes).toBe(1);

    const presence = await Presence.list({ root, now: () => t1 });
    expect(presence[0]?.last_seen_at).toBe(t1.toISOString());
    expect(presence[0]?.online).toBe(true);
  });

  it("is a no-op when no session exists for the passport", async () => {
    const changes = await Presence.refreshByPassport({ root, passportId: "ghost" });
    expect(changes).toBe(0);
  });

  it("refreshes all sessions of the same passport", async () => {
    const t0 = new Date("2026-05-15T08:00:00.000Z");
    const t1 = new Date("2026-05-15T08:05:00.000Z");
    await Presence.register({ root, passportId: "claude", now: () => t0 });
    await Presence.register({ root, passportId: "claude", now: () => t0 });
    const changes = await Presence.refreshByPassport({ root, passportId: "claude", now: () => t1 });
    expect(changes).toBe(2);
  });
});
