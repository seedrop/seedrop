import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import type { Message } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

describe("Session", () => {
  it("is created via identity.session()", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    expect(session.slots.name).toBe("Atlas");
    expect(session.history.length).toBe(0);
  });

  it("default classifier (rule) sends all messages to commitments", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    const r = await session.record({ role: "user", content: "hello" });
    expect(r.channel).toBe("commitments");
    expect(r.index).toBe(0);
  });

  it("respects explicit channel: 'boundary' override at record-time", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    const r = await session.record(
      { role: "user", content: "noise" },
      { channel: "boundary" },
    );
    expect(r.channel).toBe("boundary");
  });

  it("custom router decides the channel when no override is given", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({
      router: (m) => (m.content.startsWith("//") ? "boundary" : "commitments"),
    });
    expect((await session.record({ role: "user", content: "real" })).channel).toBe(
      "commitments",
    );
    expect((await session.record({ role: "user", content: "// aside" })).channel).toBe(
      "boundary",
    );
  });

  it("explicit override beats the custom router", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session({ router: () => "boundary" });
    const r = await session.record(
      { role: "user", content: "force" },
      { channel: "commitments" },
    );
    expect(r.channel).toBe("commitments");
  });

  it("history is append-only and indexes are sequential", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    for (let i = 0; i < 5; i++) {
      await session.record({ role: "user", content: `msg ${i}` });
    }
    expect(session.history.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reconstruct returns system prompt as first message", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    const messages = session.reconstruct();
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe(session.systemPrompt);
  });

  it("reconstruct excludes messages routed to boundary", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    await session.record({ role: "user", content: "in" });
    await session.record(
      { role: "assistant", content: "drop me" },
      { channel: "boundary" },
    );
    await session.record({ role: "user", content: "out" });
    const messages = session.reconstruct();
    expect(messages.length).toBe(3);
    expect(messages.slice(1).map((m) => m.content)).toEqual(["in", "out"]);
  });

  it("reconstruct preserves role and content of commitment messages", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    const messages: Message[] = [
      { role: "user", content: "user-1" },
      { role: "assistant", content: "asst-1" },
      { role: "tool", content: "tool-1" },
    ];
    for (const m of messages) await session.record(m);
    const out = session.reconstruct();
    expect(out.slice(1)).toEqual(messages);
  });
});
