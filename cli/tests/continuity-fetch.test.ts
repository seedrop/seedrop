import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeContinuityPage,
  continuityAcknowledgementStatePath,
  ContinuityAcknowledgementError,
  readContinuityAcknowledgementState,
} from "../src/continuity-ack.js";
import { buildContinuity, runContinuity } from "../src/continuity.js";
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
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(fixture, { recursive: true, force: true });
});

describe("read-only continuity pages and explicit acknowledgement", () => {
  it.each(["presence", "inbox", "messages"] as const)(
    "returns an unacknowledgeable page and preserves state when the %s fetch fails",
    async (failure) => {
      const transport = createTransport(failure);
      const report = await build(transport.fetchImpl);

      expect(report.watermarkAdvanced).toBe(false);
      expect(report.page).toMatchObject({ complete: false, acknowledgeable: false });
      expect(report.page?.ack_token).toBeUndefined();
      expect((await readContinuityState(AGENT))?.last_seen_at).toBe(OLD_WATERMARK);
      expect(await readContinuityAcknowledgementState(AGENT)).toBeNull();
      expect(transport.posts()).toBe(0);
      expect(transport.observationsAreReadOnly()).toBe(true);
      expect(report.warnings.some((warning) => warning.includes("cannot be acknowledged"))).toBe(true);
    },
  );

  it("retries from the unchanged watermark, then commits a complete page exactly once", async () => {
    const transport = createTransport("messages");
    const partial = await build(transport.fetchImpl);

    expect(partial.since).toBe(OLD_WATERMARK);
    expect(partial.inbox.unacked.map((item) => item.id)).toEqual(["mention-1"]);
    expect(partial.joinedSpaces.find((space) => space.name === "alpha")?.recentMessages.map((message) => message.content)).toEqual(["alpha unseen"]);
    expect(partial.joinedSpaces.find((space) => space.name === "beta")?.unreachable).toBe(true);
    expect((await readContinuityState(AGENT))?.last_seen_at).toBe(OLD_WATERMARK);

    transport.recover();
    const retry = await build(transport.fetchImpl);

    expect(retry.since).toBe(OLD_WATERMARK);
    expect(retry.watermarkAdvanced).toBe(false);
    expect(retry.page).toMatchObject({ complete: true, acknowledgeable: true, high_watermark: STAGED_WATERMARK });
    expect(retry.inbox.unacked).toEqual(partial.inbox.unacked);
    expect(retry.joinedSpaces.find((space) => space.name === "alpha")?.recentMessages).toEqual(
      partial.joinedSpaces.find((space) => space.name === "alpha")?.recentMessages,
    );
    expect(retry.joinedSpaces.find((space) => space.name === "beta")?.recentMessages.map((message) => message.content)).toEqual(["arrived during fetch"]);
    expect((await readContinuityState(AGENT))?.last_seen_at).toBe(OLD_WATERMARK);
    expect(await readContinuityAcknowledgementState(AGENT)).toBeNull();
    expect(transport.posts()).toBe(0);

    const presenceRequests: string[] = [];
    const token = retry.page?.ack_token;
    expect(token).toBeTruthy();
    const committed = await acknowledgeContinuityPage({
      agentId: AGENT,
      token: token!,
      commitPresence: async (requestId) => { presenceRequests.push(requestId); },
      now: () => new Date("2026-08-09T10:01:00.000Z"),
    });
    const repeated = await acknowledgeContinuityPage({
      agentId: AGENT,
      token: token!,
      commitPresence: async (requestId) => { presenceRequests.push(requestId); },
      now: () => new Date("2026-08-09T10:02:00.000Z"),
    });

    expect(committed).toMatchObject({ acknowledged: true, idempotent: false, presence_committed: true });
    expect(repeated).toMatchObject({ acknowledged: true, idempotent: true, presence_committed: false });
    expect(presenceRequests).toHaveLength(1);
    expect((await readContinuityAcknowledgementState(AGENT))).toMatchObject({
      last_seen_at: STAGED_WATERMARK,
      ack_count: 1,
      last_page_id: retry.page?.page_id,
    });
  });

  it("rejects an out-of-order page after another page wins the watermark compare-and-set", async () => {
    const transport = createTransport(null);
    const first = await build(transport.fetchImpl, "2026-08-09T10:00:00.000Z");
    const competing = await build(transport.fetchImpl, "2026-08-09T10:05:00.000Z");
    await acknowledgeContinuityPage({
      agentId: AGENT,
      token: first.page!.ack_token!,
      commitPresence: async () => {},
    });

    await expect(acknowledgeContinuityPage({
      agentId: AGENT,
      token: competing.page!.ack_token!,
      commitPresence: async () => {},
    })).rejects.toMatchObject<Partial<ContinuityAcknowledgementError>>({ code: "watermark_conflict" });
    expect((await readContinuityAcknowledgementState(AGENT))?.last_seen_at).toBe("2026-08-09T10:00:00.000Z");
  });

  it("makes peek pages complete but deliberately non-acknowledgeable", async () => {
    const transport = createTransport(null);
    const report = await buildContinuity({
      passportPath,
      spaceUrl: "http://seedrop.test",
      cwd: fixture,
      root: fixture,
      rootKind: "folder",
      fetchImpl: transport.fetchImpl,
      now: () => new Date(STAGED_WATERMARK),
      peek: true,
    });
    expect(report.page).toMatchObject({ complete: true, acknowledgeable: false });
    expect(report.page?.ack_token).toBeUndefined();
  });

  it("routes an explicit CLI acknowledgement and makes command retry side-effect free", async () => {
    const transport = createTransport(null);
    const report = await build(transport.fetchImpl);
    const presence = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://seedrop.test/presence/ack");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        observedAt: STAGED_WATERMARK,
      });
      return json({ session: { id: "stable" } }, 201);
    });
    vi.stubGlobal("fetch", presence);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: { write: (value: string) => { stdout.push(value); return true; } },
      stderr: { write: (value: string) => { stderr.push(value); return true; } },
    } as never;
    const argv = ["ack", "--json", "--token", report.page!.ack_token!];
    const options = { defaultPassport: passportPath, defaultUrl: "http://seedrop.test" };

    expect(await runContinuity(argv, io, options)).toBe(0);
    expect(await runContinuity(argv, io, options)).toBe(0);
    expect(presence).toHaveBeenCalledTimes(1);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain('"idempotent": true');
  });

  it("serializes concurrent acknowledgement attempts into one commit", async () => {
    const report = await build(createTransport(null).fetchImpl);
    let presenceEffects = 0;
    const commitPresence = async () => {
      presenceEffects += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    const results = await Promise.all([
      acknowledgeContinuityPage({ agentId: AGENT, token: report.page!.ack_token!, commitPresence }),
      acknowledgeContinuityPage({ agentId: AGENT, token: report.page!.ack_token!, commitPresence }),
    ]);

    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(presenceEffects).toBe(1);
    expect((await readContinuityAcknowledgementState(AGENT))?.ack_count).toBe(1);
  });

  it("rejects tampered page tokens before presence or state effects", async () => {
    const report = await build(createTransport(null).fetchImpl);
    const token = report.page!.ack_token!;
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    let presenceEffects = 0;

    await expect(acknowledgeContinuityPage({
      agentId: AGENT,
      token: tampered,
      commitPresence: async () => { presenceEffects += 1; },
    })).rejects.toMatchObject<Partial<ContinuityAcknowledgementError>>({ code: "invalid_token" });
    expect(presenceEffects).toBe(0);
    expect(await readContinuityAcknowledgementState(AGENT)).toBeNull();
  });

  it("fails closed on internally inconsistent v2 acknowledgement state", async () => {
    const statePath = continuityAcknowledgementStatePath(AGENT);
    await writeFile(statePath, JSON.stringify({
      schema_version: "2.0",
      agent_id: AGENT,
      last_seen_at: STAGED_WATERMARK,
      last_page_id: "a".repeat(64),
      ack_count: 1,
      acknowledged_pages: [],
      updated_at: STAGED_WATERMARK,
    }));

    await expect(build(createTransport(null).fetchImpl)).rejects.toMatchObject<Partial<ContinuityAcknowledgementError>>({ code: "state_invalid" });
  });

  it("reaps a lock immediately after its owner process is gone", async () => {
    const report = await build(createTransport(null).fetchImpl);
    await writeFile(`${continuityAcknowledgementStatePath(AGENT)}.lock`, JSON.stringify({
      pid: 2_000_000_000,
      token: "dead-owner",
      created_at: new Date().toISOString(),
    }));

    await expect(acknowledgeContinuityPage({
      agentId: AGENT,
      token: report.page!.ack_token!,
      commitPresence: async () => {},
    })).resolves.toMatchObject({ acknowledged: true, idempotent: false });
  });
});

async function build(fetchImpl: typeof fetch, watermark = STAGED_WATERMARK) {
  return buildContinuity({
    passportPath,
    spaceUrl: "http://seedrop.test",
    cwd: fixture,
    root: fixture,
    rootKind: "folder",
    fetchImpl,
    now: () => new Date(watermark),
  });
}

function createTransport(initialFailure: "presence" | "inbox" | "messages" | null) {
  let failure = initialFailure;
  const calls: Array<{ url: string; method: string; passport: string | null; observeOnly: string | null }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      passport: headers.get("x-seedrop-passport"),
      observeOnly: headers.get("x-seedrop-observe-only"),
    });

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
    return json({ error: "unexpected route" }, 404);
  });

  return {
    fetchImpl,
    recover: () => { failure = null; },
    posts: () => calls.filter((call) => call.method === "POST").length,
    observationsAreReadOnly: () => calls
      .filter((call) => call.method === "GET")
      .every((call) => call.passport === AGENT && call.observeOnly === "true"),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
