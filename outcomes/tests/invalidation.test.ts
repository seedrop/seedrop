import { describe, expect, it } from "vitest";
import type { ProjectTransactionDigest } from "@seedrop/protocol";
import { compileSourceInvalidation, sourceInvalidationBytes } from "../src/index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ProjectTransactionDigest;
const original = [
  { source_id: "git:head", digest: digest("a") },
  { source_id: "artifact:build", digest: digest("b") },
  { source_id: "schema:protocol", digest: digest("c") },
  { source_id: "policy:release", digest: digest("d") },
];
const claims = original.map((source) => ({ claim_id: `claim:${source.source_id}`, dependencies: [{ source_id: source.source_id, observed_digest: source.digest }] }));

describe("source-digest invalidation", () => {
  it.each(original.map((source) => source.source_id))("invalidates exactly the claim depending on changed %s", (sourceId) => {
    const current = original.map((source) => source.source_id === sourceId ? { ...source, digest: digest("f") } : source);
    const projected = compileSourceInvalidation({ current_sources: current, claims });
    expect(projected.claims.filter((claim) => claim.state === "invalidated")).toEqual([
      { claim_id: `claim:${sourceId}`, state: "invalidated", changed_source_ids: [sourceId] },
    ]);
  });

  it("invalidates a dependency when its source disappears and ignores unrelated additions", () => {
    const missing = compileSourceInvalidation({ current_sources: original.slice(1), claims });
    expect(missing.claims.find((claim) => claim.claim_id === "claim:git:head"))
      .toMatchObject({ state: "invalidated", changed_source_ids: ["git:head"] });
    const added = compileSourceInvalidation({ current_sources: [...original, { source_id: "artifact:new", digest: digest("e") }], claims });
    expect(added.claims.every((claim) => claim.state === "current")).toBe(true);
  });

  it("is deterministic across input order", () => {
    const forward = compileSourceInvalidation({ current_sources: original, claims });
    const reverse = compileSourceInvalidation({ current_sources: [...original].reverse(), claims: [...claims].reverse() });
    expect(sourceInvalidationBytes(reverse)).toEqual(sourceInvalidationBytes(forward));
  });
});
