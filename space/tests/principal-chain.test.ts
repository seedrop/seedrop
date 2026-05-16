import { describe, expect, it } from "vitest";
import { resolvePrincipalChain, type PassportIdentity } from "../src/index.js";

function id(partial: Partial<PassportIdentity> & { agentId: string }): PassportIdentity {
  return {
    passportId: partial.passportId ?? partial.agentId,
    name: partial.name,
    issuedBy: partial.issuedBy,
    autonomous: partial.autonomous,
    ...partial,
  };
}

describe("resolvePrincipalChain", () => {
  it("returns just the agent when there's no issuer", () => {
    const identities = [id({ agentId: "mc" })];
    expect(resolvePrincipalChain("mc", identities)).toEqual(["mc"]);
  });

  it("walks a single-step chain agent ← operator", () => {
    const identities = [id({ agentId: "claude", issuedBy: "mc" }), id({ agentId: "mc" })];
    expect(resolvePrincipalChain("claude", identities)).toEqual(["claude", "mc"]);
  });

  it("walks a multi-step chain agent ← agent ← operator", () => {
    const identities = [
      id({ agentId: "researcher", issuedBy: "claude" }),
      id({ agentId: "claude", issuedBy: "mc" }),
      id({ agentId: "mc" }),
    ];
    expect(resolvePrincipalChain("researcher", identities)).toEqual(["researcher", "claude", "mc"]);
  });

  it("stops at autonomous principal", () => {
    const identities = [id({ agentId: "ci-bot", autonomous: true })];
    expect(resolvePrincipalChain("ci-bot", identities)).toEqual(["ci-bot"]);
  });

  it("does not loop on accidental cycles", () => {
    const identities = [
      id({ agentId: "a", issuedBy: "b" }),
      id({ agentId: "b", issuedBy: "a" }),
    ];
    const chain = resolvePrincipalChain("a", identities);
    expect(chain.length).toBeLessThan(16);
    expect(chain[0]).toBe("a");
  });

  it("returns the passportId verbatim when not in the identity set", () => {
    expect(resolvePrincipalChain("unknown", [])).toEqual(["unknown"]);
  });
});
