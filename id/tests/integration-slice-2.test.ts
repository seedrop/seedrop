/**
 * Slice 2 ship-criterion (PRD §9.2):
 *
 *   Load passport → record 10 mixed messages → reconstruct →
 *   assert system prompt contains all passport core_commitments verbatim.
 */

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "../src/identity.js";
import type { Channel, Message } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

describe("Slice 2 ship-criterion", () => {
  it("load passport → record 10 mixed messages → reconstruct → system prompt holds every core_commitment verbatim", async () => {
    const id = await Identity.fromPassport(fixturePath);
    const session = id.session();

    const mixed: Array<{ msg: Message; channel?: Channel }> = [
      { msg: { role: "user", content: "Please review this PR." } },
      { msg: { role: "assistant", content: "Sure, opening the diff." } },
      { msg: { role: "user", content: "fyi the cat knocked over my coffee" }, channel: "boundary" },
      { msg: { role: "assistant", content: "Tests look correct — no skips." } },
      { msg: { role: "user", content: "haha lol" }, channel: "boundary" },
      { msg: { role: "user", content: "Should we force-push to clean history?" } },
      { msg: { role: "assistant", content: "I need explicit confirmation before any force-push to main." } },
      { msg: { role: "tool", content: "ci-status: green" } },
      { msg: { role: "user", content: "ok thanks" } },
      { msg: { role: "assistant", content: "Ready to merge." } },
    ];

    for (const { msg, channel } of mixed) {
      await session.record(msg, channel ? { channel } : {});
    }
    expect(session.history.length).toBe(10);

    const reconstructed = session.reconstruct();
    const systemPrompt = reconstructed[0];
    expect(systemPrompt?.role).toBe("system");

    for (const commitment of id.passport.core_commitments) {
      expect(systemPrompt?.content).toContain(commitment);
    }

    const boundaryCount = mixed.filter((m) => m.channel === "boundary").length;
    expect(reconstructed.length).toBe(1 + mixed.length - boundaryCount);

    const dropped = mixed.filter((m) => m.channel === "boundary").map((m) => m.msg.content);
    for (const d of dropped) {
      expect(reconstructed.find((m) => m.content === d)).toBeUndefined();
    }
  });
});
