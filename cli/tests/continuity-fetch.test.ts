import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContinuity } from "../src/continuity.js";
import { readContinuityState, writeContinuityState } from "../src/continuity-state.js";

const AGENT = "watermark-agent";
const OLD_WATERMARK = "2026-08-09T09:00:00.000Z";
const STAGED_WATERMARK = "2026-08-09T10:00:00.000Z";

let fixture: string;
let passportPath: string;
let originalHome: string | undefined;

beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), "seedrop-continuity-fetch-"));
  originalHome = process.env.HOME;
  process.env.HOME = fixture;
  passportPath = path.join(fixture, "passport.json");
  await writeFile(passportPath, JSON.stringify({
    agent_id: AGENT,
    active_projects: [
      { id: "one", root: fixture, space: "alpha" },
      { id: "two", root: fixture, space: "beta" },
    ],
  }));
  await writeContinuityState(AGENT, { schema_version: "1.0", last_seen_at: OLD_WATERMARK });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(fixture, { recursive: true, force: true });
});

describe("continuity observation commit", () => {
  it.each(["presence", "inbox", "messages"] as const)(
    "preserves the prior watermark when the %s fetch fails",
    async (failure) => {
      const transport = createTransport(failure);
      const report = await build(transport.fetchImpl);

      expect(report.watermarkAdvanced).toBe(false);
      expect((await readContinuityState(AGENT))?.last_seen_at).toBe(OLD_WATERMARK);
      expect(transport.posts()).toBe(0);
      expect(report.warnings.some((warning) => warning.includes("watermark"))).toBe(true);
    },
  );

  it("retries from the unchanged watermark and commits the pre-fetch boundary only after complete success", async () => {
    const transport = createTransport("messages");
    const partial = await build(transport.fetchImpl);

    expect(partial.since).toBe(OLD_WATERMARK);
    expect(partial.inbox.unacked.map((item) => item.id)).toEqual(["mention-1"]);
    expect(partial.joinedSpaces.find((space) => space.name === "alpha")?.recentMessages.map((message) => message.content)).toEqual(["alpha unseen"]);
    expect(partial.joinedSpaces.find((space) => space.name === "beta")?.unreachable).toBe(true);
    expect((await readContinuityState(AGENT))?.last_seen_at).toBe(OLD_WATERMARK);
    expect(transport.posts()).toBe(0);

    transport.recover();
    const retry = await build(transport.fetchImpl);

    expect(retry.since).toBe(OLD_WATERMARK);
    expect(retry.watermarkAdvanced).toBe(true);
    expect(retry.inbox.unacked).toEqual(partial.inbox.unacked);
    expect(retry.joinedSpaces.find((space) => space.name === "alpha")?.recentMessages).toEqual(
      partial.joinedSpaces.find((space) => space.name === "alpha")?.recentMessages,
    );
    expect(retry.joinedSpaces.find((space) => space.name === "beta")?.recentMessages.map((message) => message.content)).toEqual(["arrived during fetch"]);
    expect((await readContinuityState(AGENT))?.last_seen_at).toBe(STAGED_WATERMARK);
    expect(transport.posts()).toBe(1);
    expect(transport.presenceAuthenticated()).toBe(true);
  });
});

async function build(fetchImpl: typeof fetch) {
  return buildContinuity({
    passportPath,
    spaceUrl: "http://seedrop.test",
    cwd: fixture,
    root: fixture,
    rootKind: "folder",
    fetchImpl,
    now: () => new Date(STAGED_WATERMARK),
  });
}

function createTransport(initialFailure: "presence" | "inbox" | "messages") {
  let failure: typeof initialFailure | null = initialFailure;
  const calls: Array<{ url: string; method: string; passport: string | null }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const passport = new Headers(init?.headers).get("x-seedrop-passport");
    calls.push({ url, method, passport });

    if (url.endsWith("/presence")) {
      if (failure === "presence") return json({ error: "injected" }, 503);
      return json({ presence: [] });
    }
    if (url.includes("/inbox/")) {
      if (failure === "inbox") return json({ error: "injected" }, 503);
      return json({ mentions: [{
        id: "mention-1",
        message_id: "message-1",
        space_id: "alpha-id",
        sender_passport_id: "sender",
        content: "unseen inbox item",
        created_at: "2026-08-09T09:30:00.000Z",
      }] });
    }
    if (url.includes("/spaces/alpha/messages")) {
      return json({ messages: [{
        author_passport_id: "sender",
        content: "alpha unseen",
        created_at: "2026-08-09T09:45:00.000Z",
      }] });
    }
    if (url.includes("/spaces/beta/messages")) {
      if (failure === "messages") return json({ error: "injected" }, 503);
      return json({ messages: [{
        author_passport_id: "sender",
        content: "arrived during fetch",
        created_at: "2026-08-09T10:00:00.500Z",
      }] });
    }
    if (url.endsWith("/sessions") && method === "POST") {
      return json({ session: { id: "session-1" } }, 201);
    }
    return json({ error: "unexpected route" }, 404);
  });

  return {
    fetchImpl,
    recover: () => { failure = null; },
    posts: () => calls.filter((call) => call.method === "POST").length,
    presenceAuthenticated: () => calls
      .filter((call) => call.url.endsWith("/presence"))
      .every((call) => call.passport === AGENT),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
