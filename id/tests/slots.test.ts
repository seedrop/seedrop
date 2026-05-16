import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedSlots } from "../src/slots.js";
import type { Passport } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "valid-passport.json");

async function loadPassport(): Promise<Passport> {
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as Passport;
}

describe("seedSlots", () => {
  it("maps passport fields into typed slots", async () => {
    const p = await loadPassport();
    const slots = seedSlots(p);
    expect(slots.name).toBe(p.name);
    expect(slots.current_goal).toBe(p.purpose);
    expect(slots.hard_constraints).toEqual(p.core_commitments);
    expect(slots.project_conventions).toEqual(p.competencies);
    expect(slots.boundary_seed).toEqual(p.limits);
  });

  it("sorts value_anchors ascending by priority (highest priority = 1 first)", async () => {
    const p = await loadPassport();
    p.value_anchors = [
      { name: "speed", priority: 3 },
      { name: "correctness", priority: 1 },
      { name: "honesty", priority: 2 },
    ];
    const slots = seedSlots(p);
    expect(slots.priorities.map((a) => a.name)).toEqual(["correctness", "honesty", "speed"]);
  });

  it("derives blocked_paths from learned_blocks.pattern", async () => {
    const p = await loadPassport();
    const slots = seedSlots(p);
    expect(slots.blocked_paths).toEqual(p.learned_blocks.map((b) => b.pattern));
  });

  it("handles empty collection fields without crashing", async () => {
    const p = await loadPassport();
    p.core_commitments = [];
    p.value_anchors = [];
    p.competencies = [];
    p.limits = [];
    p.learned_blocks = [];
    const slots = seedSlots(p);
    expect(slots.hard_constraints).toEqual([]);
    expect(slots.priorities).toEqual([]);
    expect(slots.blocked_paths).toEqual([]);
  });
});
