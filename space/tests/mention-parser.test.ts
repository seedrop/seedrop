import { describe, expect, it } from "vitest";
import { extractMentions } from "../src/mention-parser.js";

describe("extractMentions", () => {
  it("returns [] for empty or null content", () => {
    expect(extractMentions("")).toEqual([]);
  });

  it("extracts a single mention at the start", () => {
    expect(extractMentions("@claude please review")).toEqual(["claude"]);
  });

  it("extracts a mention in the middle", () => {
    expect(extractMentions("hey @claude can you look")).toEqual(["claude"]);
  });

  it("extracts multiple distinct mentions in order", () => {
    expect(extractMentions("@claude @codex anyone around?")).toEqual(["claude", "codex"]);
  });

  it("dedupes repeated mentions", () => {
    expect(extractMentions("@claude and again @claude")).toEqual(["claude"]);
  });

  it("requires a non-word boundary before @", () => {
    expect(extractMentions("email@claude.example.com")).toEqual([]);
  });

  it("accepts dots and dashes and underscores in agent_id", () => {
    expect(extractMentions("@ci-bot @release.engineer @bot_3")).toEqual([
      "ci-bot",
      "release.engineer",
      "bot_3",
    ]);
  });

  it("lowercases captures", () => {
    expect(extractMentions("@Claude")).toEqual(["claude"]);
  });

  it("does not match @<empty>", () => {
    expect(extractMentions("hi @ there")).toEqual([]);
  });

  it("handles punctuation right after the agent_id", () => {
    expect(extractMentions("@claude, thoughts? @codex.")).toEqual(["claude", "codex"]);
  });
});
