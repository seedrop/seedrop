import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/system-prompt.js";
import type { SessionSlots } from "../src/types.js";

const baseSlots: SessionSlots = {
  name: "Atlas",
  current_goal: "Help engineering teams ship reliable software.",
  hard_constraints: [
    "Never recommend skipping tests",
    "Always disclose uncertainty",
  ],
  priorities: [
    { name: "correctness", priority: 1 },
    { name: "honesty", priority: 2 },
  ],
  project_conventions: ["typescript", "code-review"],
  boundary_seed: ["cannot deploy"],
  blocked_paths: ["editing CHANGELOG.md retroactively"],
};

describe("buildSystemPrompt", () => {
  it("includes the agent name", () => {
    const text = buildSystemPrompt(baseSlots);
    expect(text).toContain("You are Atlas.");
  });

  it("includes the goal/purpose", () => {
    const text = buildSystemPrompt(baseSlots);
    expect(text).toContain("Purpose: Help engineering teams ship reliable software.");
  });

  it("includes every hard_constraint verbatim", () => {
    const text = buildSystemPrompt(baseSlots);
    for (const c of baseSlots.hard_constraints) {
      expect(text).toContain(c);
    }
  });

  it("numbers priorities in slot order", () => {
    const text = buildSystemPrompt(baseSlots);
    expect(text).toContain("1. correctness");
    expect(text).toContain("2. honesty");
  });

  it("includes every project convention verbatim", () => {
    const text = buildSystemPrompt(baseSlots);
    for (const c of baseSlots.project_conventions) {
      expect(text).toContain(c);
    }
  });

  it("includes every limit verbatim", () => {
    const text = buildSystemPrompt(baseSlots);
    for (const l of baseSlots.boundary_seed) {
      expect(text).toContain(l);
    }
  });

  it("includes every blocked_path verbatim", () => {
    const text = buildSystemPrompt(baseSlots);
    for (const p of baseSlots.blocked_paths) {
      expect(text).toContain(p);
    }
  });

  it("skips empty sections cleanly", () => {
    const minimal: SessionSlots = {
      name: "Bare",
      current_goal: "Do stuff.",
      hard_constraints: [],
      priorities: [],
      project_conventions: [],
      boundary_seed: [],
      blocked_paths: [],
    };
    const text = buildSystemPrompt(minimal);
    expect(text).toBe("You are Bare.\n\nPurpose: Do stuff.");
  });

  it("renders all sections in deterministic order", () => {
    const text = buildSystemPrompt(baseSlots);
    const order = [
      "You are",
      "Purpose:",
      "Hard constraints",
      "Priorities",
      "Conventions:",
      "Limits:",
      "Patterns to avoid",
    ];
    let lastIdx = -1;
    for (const marker of order) {
      const idx = text.indexOf(marker);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});
