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

  it("additively migrates a pre-outbox live store without losing v1 rows", async () => {
    const legacy = LiveStore.open({ root });
    const legacyDb = await legacy.connection();
    legacyDb.exec("DROP TABLE post_outbox_v2");
    legacyDb.prepare(
      "INSERT INTO sessions (id, passport_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
    ).run("legacy-session", "codex", "2026-08-09T08:00:00.000Z", "2026-08-09T08:00:00.000Z");
    legacy.close();

    const migrated = LiveStore.open({ root });
    const db = await migrated.connection();
    expect(db.prepare("SELECT passport_id FROM sessions WHERE id = ?").get("legacy-session")).toEqual({
      passport_id: "codex",
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='post_outbox_v2'").get()).toEqual({
      name: "post_outbox_v2",
    });
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='post_outbox_v2'").get() as { sql: string };
    expect(sql.sql).toContain("schema_version = '2.0'");
    migrated.close();
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
