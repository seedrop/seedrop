import { describe, it, expect } from "vitest";
import { cosineSimilarity, cosineDistance, meanVector } from "../src/vectors.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([3, 4], [3, 4])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("is scale-invariant", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 when either vector is zero", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe("cosineDistance", () => {
  it("is 1 - similarity", () => {
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0, 10);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 10);
  });
});

describe("meanVector", () => {
  it("averages componentwise", () => {
    expect(meanVector([[1, 2], [3, 4]])).toEqual([2, 3]);
    expect(meanVector([[0, 0, 0], [10, 10, 10]])).toEqual([5, 5, 5]);
  });

  it("returns the single vector when given one", () => {
    expect(meanVector([[7, 8, 9]])).toEqual([7, 8, 9]);
  });

  it("throws on an empty input set", () => {
    expect(() => meanVector([])).toThrow(/empty set/);
  });

  it("throws on inconsistent vector lengths", () => {
    expect(() => meanVector([[1, 2], [1, 2, 3]])).toThrow(/length mismatch/);
  });
});
