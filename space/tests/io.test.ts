import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SpaceStore,
  SpaceValidationError,
  type Message,
  type Notification,
  type SpaceMeta,
} from "../src/index.js";

let root: string;
const now = "2026-05-14T10:00:00.000Z";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-core-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(): SpaceStore {
  return SpaceStore.open({ root });
}

function spaceMeta(overrides: Partial<SpaceMeta> = {}): SpaceMeta {
  return {
    schema_version: "1.0",
    id: "space-1",
    name: "Demo Room",
    lifecycle: "open",
    members: [{ passport_id: "alpha", joined_at: now }],
    created_at: now,
    ended_at: null,
    archived_at: null,
    ...overrides,
  };
}

function message(id: string, content: string): Message {
  return {
    schema_version: "1.0",
    id,
    space_id: "space-1",
    author_passport_id: "alpha",
    role: "agent",
    created_at: now,
    content,
  };
}

function notification(id: string): Notification {
  return {
    schema_version: "1.0",
    id,
    recipient_passport_id: "beta",
    sender_passport_id: "alpha",
    created_at: now,
    expires_at: "2026-05-14T11:00:00.000Z",
    pointer: { kind: "space-message", ref: "space-1/message-1" },
    acked_at: null,
  };
}

describe("SpaceStore", () => {
  it("writes and reads space metadata", async () => {
    await store().writeSpaceMeta(spaceMeta());

    await expect(store().readSpaceMeta("space-1")).resolves.toEqual(spaceMeta());
    const raw = await readFile(path.join(root, ".seedrop", "space", "spaces", "space-1", "meta.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(spaceMeta());
  });

  it("appends and reads messages in order", async () => {
    await store().appendMessage(message("message-1", "First."));
    await store().appendMessage(message("message-2", "Second."));

    await expect(store().readMessages("space-1")).resolves.toEqual([
      message("message-1", "First."),
      message("message-2", "Second."),
    ]);

    const raw = await readFile(path.join(root, ".seedrop", "space", "spaces", "space-1", "messages.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("appends and reads notifications per passport", async () => {
    await store().appendNotification(notification("notification-1"));
    await store().appendNotification(notification("notification-2"));

    await expect(store().readNotifications("beta")).resolves.toEqual([
      notification("notification-1"),
      notification("notification-2"),
    ]);
  });

  it("creates storage directories on first write", async () => {
    await store().writeSpaceMeta(spaceMeta());

    await expect(readFile(path.join(root, ".seedrop", "space", "spaces", "space-1", "meta.json"), "utf8")).resolves.toContain(
      "Demo Room",
    );
  });

  it("rejects unsafe path segments", async () => {
    expect(() => store().spaceDir("../nope")).toThrow(SpaceValidationError);
  });

  it("skips malformed JSONL rows while preserving readable records", async () => {
    const messagesPath = path.join(root, ".seedrop", "space", "spaces", "space-1", "messages.jsonl");
    await store().ensure();
    await mkdir(path.dirname(messagesPath), { recursive: true });
    await writeFile(messagesPath, `${JSON.stringify(message("message-1", "First."))}\n{nope}\n`);

    await expect(store().readMessages("space-1")).resolves.toEqual([message("message-1", "First.")]);
  });

  it("skips invalid JSONL rows while preserving valid records", async () => {
    const messagesPath = path.join(root, ".seedrop", "space", "spaces", "space-1", "messages.jsonl");
    await store().ensure();
    await mkdir(path.dirname(messagesPath), { recursive: true });
    await writeFile(
      messagesPath,
      `${JSON.stringify({ ...message("message-1", "First."), role: "robot" })}\n${JSON.stringify(message("message-2", "Second."))}\n`,
    );

    await expect(store().readMessages("space-1")).resolves.toEqual([message("message-2", "Second.")]);
  });

  it("throws a typed validation error when writing invalid metadata", async () => {
    await expect(store().writeSpaceMeta(spaceMeta({ lifecycle: "ended", ended_at: null }))).rejects.toBeInstanceOf(
      SpaceValidationError,
    );
  });

  it("throws a typed parse error for malformed space metadata JSON", async () => {
    const metaPath = path.join(root, ".seedrop", "space", "spaces", "space-1", "meta.json");
    await store().ensure();
    await mkdir(path.dirname(metaPath), { recursive: true });
    await writeFile(metaPath, "{not-json");

    await expect(store().readSpaceMeta("space-1")).rejects.toThrow();
  });

  it("throws a typed validation error for invalid space metadata JSON", async () => {
    const metaPath = path.join(root, ".seedrop", "space", "spaces", "space-1", "meta.json");
    await store().ensure();
    await mkdir(path.dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify({ ...spaceMeta(), lifecycle: "ended", ended_at: null }));

    await expect(store().readSpaceMeta("space-1")).rejects.toBeInstanceOf(SpaceValidationError);
  });

  it("returns an empty message list when the message log is missing", async () => {
    await store().ensure();
    await expect(store().readMessages("space-1")).resolves.toEqual([]);
  });

  it("resolves an absolute dataDir without joining the root", () => {
    const absolute = path.join(root, "alt-store");
    const custom = SpaceStore.open({ root, dataDir: absolute });
    expect(custom.paths.dataDir).toBe(absolute);
    expect(custom.paths.spacesDir).toBe(path.join(absolute, "spaces"));
  });

  it("lists empty when no spaces have been written", async () => {
    await expect(store().listSpaceMetas()).resolves.toEqual([]);
  });

  it("ignores stray non-directory entries when listing spaces", async () => {
    await store().writeSpaceMeta(spaceMeta());
    await writeFile(path.join(root, ".seedrop", "space", "spaces", "README"), "stray\n");
    await expect(store().listSpaceMetas()).resolves.toEqual([spaceMeta()]);
  });
});
