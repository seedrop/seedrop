import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveStore } from "../src/live.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-live-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LiveStore", () => {
  it("creates the live.db file on first connection and bootstraps the sessions table", async () => {
    const live = LiveStore.open({ root });
    const db = await live.connection();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("sessions");

    const dbPath = path.join(root, ".seedrop", "space", "live.db");
    await expect(stat(dbPath)).resolves.toBeTruthy();
    live.close();
  });

  it("reuses an open connection across calls", async () => {
    const live = LiveStore.open({ root });
    const first = await live.connection();
    const second = await live.connection();
    expect(second).toBe(first);
    live.close();
  });

  it("supports an absolute dataDir without joining the root", () => {
    const absolute = path.join(root, "alt-live");
    const live = LiveStore.open({ root, dataDir: absolute });
    expect(live.paths.dataDir).toBe(absolute);
    expect(live.paths.liveDb).toBe(path.join(absolute, "live.db"));
  });

  it("respects a custom filename", () => {
    const live = LiveStore.open({ root, filename: "presence.db" });
    expect(live.paths.liveDb).toBe(path.join(root, ".seedrop", "space", "presence.db"));
  });

  it("is idempotent on close when no connection has been opened", () => {
    const live = LiveStore.open({ root });
    expect(() => live.close()).not.toThrow();
  });
});
