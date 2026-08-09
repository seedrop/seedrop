import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Space, SpaceAuthError, SpaceNotFoundError, SpaceValidationError } from "../src/index.js";

let root: string;
let currentTime: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-space-api-"));
  currentTime = new Date("2026-05-14T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function now(): Date {
  return currentTime;
}

describe("Space", () => {
  it("opens a new durable space with the opening passport as member", async () => {
    const space = await Space.open("Build Room", { root, passportId: "alpha", now });

    expect(space.meta.name).toBe("Build Room");
    expect(space.meta.lifecycle).toBe("open");
    expect(space.meta.members).toEqual([{ passport_id: "alpha", joined_at: "2026-05-14T10:00:00.000Z" }]);
    expect(space.meta.id).toMatch(/^build-room-[a-f0-9-]{8}$/);
  });

  it("joins an existing space by name and activates it when a second member arrives", async () => {
    const alpha = await Space.open("Build Room", { root, passportId: "alpha", now });

    currentTime = new Date("2026-05-14T10:01:00.000Z");
    const beta = await Space.join("build room", { root, passportId: "beta", now });

    expect(beta.meta.id).toBe(alpha.meta.id);
    expect(beta.meta.lifecycle).toBe("active");
    expect(beta.members()).toEqual([
      { passport_id: "alpha", joined_at: "2026-05-14T10:00:00.000Z" },
      { passport_id: "beta", joined_at: "2026-05-14T10:01:00.000Z" },
    ]);
  });

  it("does not duplicate active members when joining twice", async () => {
    await Space.open("Build Room", { root, passportId: "alpha", now });
    const same = await Space.join("Build Room", { root, passportId: "alpha", now });

    expect(same.members()).toHaveLength(1);
  });

  it("posts and reads append-only messages through the space", async () => {
    const space = await Space.open("Build Room", { root, passportId: "alpha", now });

    const first = await space.post({ content: "First." });
    currentTime = new Date("2026-05-14T10:02:00.000Z");
    const second = await space.post({ content: "Second.", metadata: { pointer: "src/space.ts" } });

    expect(await space.messages()).toEqual([
      {
        schema_version: "1.0",
        id: first.id,
        space_id: space.meta.id,
        author_passport_id: "alpha",
        role: "agent",
        created_at: "2026-05-14T10:00:00.000Z",
        content: "First.",
      },
      {
        schema_version: "1.0",
        id: second.id,
        space_id: space.meta.id,
        author_passport_id: "alpha",
        role: "agent",
        created_at: "2026-05-14T10:02:00.000Z",
        content: "Second.",
        metadata: { pointer: "src/space.ts" },
      },
    ]);
  });

  it("marks a member as left without deleting membership history", async () => {
    const space = await Space.open("Build Room", { root, passportId: "alpha", now });

    currentTime = new Date("2026-05-14T10:03:00.000Z");
    await space.leave();

    expect(space.members()).toEqual([
      {
        passport_id: "alpha",
        joined_at: "2026-05-14T10:00:00.000Z",
        left_at: "2026-05-14T10:03:00.000Z",
      },
    ]);
  });

  it("ends the space lifecycle", async () => {
    const space = await Space.open("Build Room", { root, passportId: "alpha", now });

    currentTime = new Date("2026-05-14T10:04:00.000Z");
    await space.end();

    expect(space.meta.lifecycle).toBe("ended");
    expect(space.meta.ended_at).toBe("2026-05-14T10:04:00.000Z");
  });

  it("lists and loads spaces", async () => {
    const space = await Space.open("Build Room", { root, passportId: "alpha", now });

    await expect(Space.list({ root })).resolves.toEqual([space.meta]);
    await expect(Space.load(space.meta.id, { root, passportId: "alpha", now })).resolves.toMatchObject({
      meta: space.meta,
    });
  });

  it("throws a typed error when loading an unknown space", async () => {
    await expect(Space.load("missing", { root, passportId: "alpha", now })).rejects.toBeInstanceOf(SpaceNotFoundError);
  });

  it("default-denies load for passports without active membership", async () => {
    const space = await Space.open("Build Room", { root, passportId: "alpha", now });

    await expect(Space.load(space.meta.id, { root, passportId: "beta", now })).rejects.toBeInstanceOf(
      SpaceAuthError,
    );
    await space.leave();
    await expect(Space.load(space.meta.id, { root, passportId: "alpha", now })).rejects.toBeInstanceOf(
      SpaceAuthError,
    );
  });

  it("rechecks membership before every protected operation", async () => {
    const staleHandle = await Space.open("Build Room", { root, passportId: "alpha", now });
    const leavingHandle = await Space.load(staleHandle.meta.id, { root, passportId: "alpha", now });
    await leavingHandle.leave();

    await expect(staleHandle.post({ content: "must not persist" })).rejects.toBeInstanceOf(SpaceAuthError);
    await expect(staleHandle.messages()).rejects.toBeInstanceOf(SpaceAuthError);
    await expect(staleHandle.end()).rejects.toBeInstanceOf(SpaceAuthError);
  });

  it("requires a passportId when opening a space", async () => {
    await expect(Space.open("Build Room", { root, passportId: "", now })).rejects.toBeInstanceOf(
      SpaceValidationError,
    );
  });
});
