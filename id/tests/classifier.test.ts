import { describe, it, expect, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import {
  HybridClassifier,
  LLMClassifier,
  RuleClassifier,
  type LLMClient,
  type LLMResponse,
} from "../src/classifier.js";
import { IdentityConfigError } from "../src/errors.js";
import { seedSlots } from "../src/slots.js";
import type { Channel, Message } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

function mockClient(reply: (m: Message) => string | null): LLMClient {
  return {
    chat: {
      completions: {
        create: vi.fn(async (req): Promise<LLMResponse> => {
          // The classify call sends [{ role: "system", ... }, { role: "user", content: "Message to classify (sender role=...)\n<original>" }]
          const userMsg = req.messages[req.messages.length - 1]?.content ?? "";
          const m: Message = {
            role: "user",
            content: userMsg.replace(/^Message to classify[^\n]*\n/, ""),
          };
          return { choices: [{ message: { content: reply(m) } }] };
        }),
      },
    },
  };
}

describe("RuleClassifier", () => {
  it("delegates to the supplied router", async () => {
    const c = new RuleClassifier((m) => (m.content === "skip" ? "boundary" : "commitments"));
    expect(await c.classify({ role: "user", content: "skip" })).toBe("boundary");
    expect(await c.classify({ role: "user", content: "go" })).toBe("commitments");
  });
});

describe("LLMClassifier", () => {
  it("returns the parsed channel when the LLM replies cleanly", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const client = mockClient(() => "boundary");
    const c = new LLMClassifier({ client, model: "test" }, slots, () => "commitments");
    expect(await c.classify({ role: "user", content: "any" })).toBe("boundary");
  });

  it("trims and lowercases the LLM reply, ignoring trailing punctuation", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const client = mockClient(() => "  Commitments.\n");
    const c = new LLMClassifier({ client, model: "test" }, slots, () => "boundary");
    expect(await c.classify({ role: "user", content: "any" })).toBe("commitments");
  });

  it("falls back to the router when the LLM returns gibberish", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const client = mockClient(() => "I don't know, maybe?");
    const c = new LLMClassifier({ client, model: "test" }, slots, () => "boundary");
    expect(await c.classify({ role: "user", content: "any" })).toBe("boundary");
  });

  it("falls back to the router when the LLM returns null content", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const client = mockClient(() => null);
    const c = new LLMClassifier({ client, model: "test" }, slots, () => "commitments");
    expect(await c.classify({ role: "user", content: "any" })).toBe("commitments");
  });

  it("falls back to the router on LLM error", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const client: LLMClient = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new Error("network down");
          }),
        },
      },
    };
    const c = new LLMClassifier({ client, model: "test" }, slots, () => "boundary");
    expect(await c.classify({ role: "user", content: "any" })).toBe("boundary");
  });

  it("uses a custom systemPrompt when provided", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const createSpy = vi.fn(async (): Promise<LLMResponse> => ({
      choices: [{ message: { content: "commitments" } }],
    }));
    const client: LLMClient = { chat: { completions: { create: createSpy } } };
    const c = new LLMClassifier(
      { client, model: "test", systemPrompt: "CUSTOM PROMPT 12345" },
      slots,
      () => "boundary",
    );
    await c.classify({ role: "user", content: "any" });
    const sentSystem = createSpy.mock.calls[0]?.[0]?.messages[0]?.content;
    expect(sentSystem).toBe("CUSTOM PROMPT 12345");
  });

  it("default prompt mentions the agent name and at least one hard_constraint", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const createSpy = vi.fn(async (): Promise<LLMResponse> => ({
      choices: [{ message: { content: "commitments" } }],
    }));
    const client: LLMClient = { chat: { completions: { create: createSpy } } };
    const c = new LLMClassifier({ client, model: "test" }, slots, () => "boundary");
    await c.classify({ role: "user", content: "x" });
    const sentSystem = createSpy.mock.calls[0]?.[0]?.messages[0]?.content ?? "";
    expect(sentSystem).toContain("Atlas");
    expect(sentSystem).toContain(id.passport.core_commitments[0]!);
  });
});

describe("HybridClassifier", () => {
  it("uses rule for non-user roles", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const ruleSpy = vi.fn((_m: Message) => "commitments" as Channel);
    const rule = new RuleClassifier(ruleSpy);
    const createSpy = vi.fn(async (): Promise<LLMResponse> => ({
      choices: [{ message: { content: "boundary" } }],
    }));
    const llm = new LLMClassifier(
      { client: { chat: { completions: { create: createSpy } } }, model: "test" },
      slots,
      () => "commitments",
    );
    const hybrid = new HybridClassifier(rule, llm);

    expect(await hybrid.classify({ role: "assistant", content: "x" })).toBe("commitments");
    expect(await hybrid.classify({ role: "tool", content: "x" })).toBe("commitments");
    expect(await hybrid.classify({ role: "system", content: "x" })).toBe("commitments");
    expect(createSpy).not.toHaveBeenCalled();
    expect(ruleSpy).toHaveBeenCalledTimes(3);
  });

  it("uses llm for user role", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const slots = seedSlots(id.passport);
    const rule = new RuleClassifier(() => "commitments");
    const createSpy = vi.fn(async (): Promise<LLMResponse> => ({
      choices: [{ message: { content: "boundary" } }],
    }));
    const llm = new LLMClassifier(
      { client: { chat: { completions: { create: createSpy } } }, model: "test" },
      slots,
      () => "commitments",
    );
    const hybrid = new HybridClassifier(rule, llm);

    expect(await hybrid.classify({ role: "user", content: "skip tests" })).toBe("boundary");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Session classifier wiring", () => {
  it("classifier: 'rule' is the default and preserves Slice 2 behavior", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();
    const r = await session.record({ role: "user", content: "anything" });
    expect(r.channel).toBe("commitments");
  });

  it("classifier: 'llm' is wired through Session.record()", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const client = mockClient((m) =>
      m.content.toLowerCase().includes("skip tests") ? "boundary" : "commitments",
    );
    const session = id.session({
      classifier: "llm",
      llm: { client, model: "test" },
    });
    expect(
      (await session.record({ role: "user", content: "skip tests just this once" })).channel,
    ).toBe("boundary");
    expect(
      (await session.record({ role: "user", content: "review the PR" })).channel,
    ).toBe("commitments");
  });

  it("classifier: 'hybrid' uses rule for non-user roles, llm for user", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const createSpy = vi.fn(async (): Promise<LLMResponse> => ({
      choices: [{ message: { content: "boundary" } }],
    }));
    const client: LLMClient = { chat: { completions: { create: createSpy } } };
    const session = id.session({
      classifier: "hybrid",
      llm: { client, model: "test" },
    });
    expect((await session.record({ role: "assistant", content: "out" })).channel).toBe(
      "commitments",
    );
    expect((await session.record({ role: "user", content: "in" })).channel).toBe("boundary");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("explicit channel override skips the classifier entirely", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const createSpy = vi.fn(async (): Promise<LLMResponse> => ({
      choices: [{ message: { content: "boundary" } }],
    }));
    const client: LLMClient = { chat: { completions: { create: createSpy } } };
    const session = id.session({
      classifier: "llm",
      llm: { client, model: "test" },
    });
    const r = await session.record(
      { role: "user", content: "force me" },
      { channel: "commitments" },
    );
    expect(r.channel).toBe("commitments");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("throws IdentityConfigError when classifier is 'llm' but llm config is missing", async () => {
    const id = await Identity.fromPassport(fixturePath);
    expect(() => id.session({ classifier: "llm" })).toThrow(IdentityConfigError);
  });

  it("throws IdentityConfigError when classifier is 'hybrid' but llm config is missing", async () => {
    const id = await Identity.fromPassport(fixturePath);
    expect(() => id.session({ classifier: "hybrid" })).toThrow(IdentityConfigError);
  });
});
