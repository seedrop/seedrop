import { describe, it, expect } from "vitest";
import { intervalsOverlap, wilsonInterval } from "../benchmarks/erosion/stats.js";

describe("wilsonInterval", () => {
  it("returns [0, 0] for n = 0", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });

  it("centres around p for large n with clamped bounds", () => {
    const [lo, hi] = wilsonInterval(50, 100);
    expect(lo).toBeGreaterThan(0.4);
    expect(hi).toBeLessThan(0.6);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });

  it("does not produce negative lows at p = 0", () => {
    const [lo, hi] = wilsonInterval(0, 25);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThan(0.2);
  });

  it("does not produce highs > 1 at p = 1", () => {
    const [lo, hi] = wilsonInterval(25, 25);
    expect(hi).toBe(1);
    expect(lo).toBeGreaterThan(0.8);
  });

  it("is narrower at larger n for the same p", () => {
    const [a_lo, a_hi] = wilsonInterval(5, 10);
    const [b_lo, b_hi] = wilsonInterval(50, 100);
    expect(b_hi - b_lo).toBeLessThan(a_hi - a_lo);
  });

  it("throws when successes is out of range", () => {
    expect(() => wilsonInterval(-1, 10)).toThrow(/out of range/);
    expect(() => wilsonInterval(11, 10)).toThrow(/out of range/);
  });
});

describe("intervalsOverlap", () => {
  it("returns true for touching intervals (closed convention)", () => {
    expect(intervalsOverlap([0, 0.5], [0.5, 1])).toBe(true);
  });

  it("returns true for nested intervals", () => {
    expect(intervalsOverlap([0.1, 0.9], [0.4, 0.6])).toBe(true);
    expect(intervalsOverlap([0.4, 0.6], [0.1, 0.9])).toBe(true);
  });

  it("returns false for disjoint intervals", () => {
    expect(intervalsOverlap([0, 0.3], [0.4, 0.7])).toBe(false);
    expect(intervalsOverlap([0.4, 0.7], [0, 0.3])).toBe(false);
  });
});
