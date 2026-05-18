import { describe, expect, it } from "vitest";
import { seedropManual } from "../src/manual.js";

describe("seedropManual", () => {
  it("returns a non-empty markdown document by default", () => {
    const out = seedropManual();
    expect(out.length).toBeGreaterThan(500);
    expect(out).toMatch(/^# seedrop manual/);
    expect(out).toMatch(/## Concepts/);
    expect(out).toMatch(/## Common workflows/);
    expect(out).toMatch(/## Where to look for what/);
    expect(out).toMatch(/## Anti-patterns/);
  });

  it("returns only the requested section when one is named", () => {
    const concepts = seedropManual("concepts");
    expect(concepts).toMatch(/^## Concepts/);
    expect(concepts).not.toMatch(/## Common workflows/);
    expect(concepts).not.toMatch(/## Anti-patterns/);
  });

  it("workflows section documents the sprint → tasks recipe explicitly", () => {
    const workflows = seedropManual("workflows");
    expect(workflows).toMatch(/Create a sprint and derive tasks/i);
    expect(workflows).toMatch(/seed task create/);
    expect(workflows).toMatch(/--from-knowledge/);
  });

  it("workflows mentions the run-finish dirty-tree gate", () => {
    const workflows = seedropManual("workflows");
    expect(workflows).toMatch(/refuses dirty completes/i);
    expect(workflows).toMatch(/Auto-syncs the manifest/);
  });

  it("anti-patterns names absolute-paths and sprint-board-creep", () => {
    const antipatterns = seedropManual("anti-patterns");
    expect(antipatterns).toMatch(/absolute paths/i);
    expect(antipatterns).toMatch(/sprint board/i);
  });

  it("is stable across calls (cacheable by agents)", () => {
    const a = seedropManual();
    const b = seedropManual();
    expect(a).toBe(b);
  });
});
