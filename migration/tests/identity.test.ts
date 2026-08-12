import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PrincipalCandidate, ProjectCandidate } from "@seedrop/protocol";
import {
  MigrationContractError,
  assertIdentityImportResult,
  buildMigrationCorpus,
  identityImportBytes,
  identityImportDigest,
  importIdentityRegistries,
} from "../src/index.js";

const fixturePath = fileURLToPath(new URL("../../protocol/fixtures/machine-identity-corpus.json", import.meta.url));
const fixtureRaw = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureRaw.toString("utf8"));

function frozenInput() {
  const principals: PrincipalCandidate[] = fixture.principals.map((entry: any) => ({
    source_ref: entry.source_ref,
    kind: entry.kind,
    aliases: [
      { namespace: "passport_id", value: entry.passport_id },
      { namespace: "agent_id", value: entry.agent_id },
      { namespace: "display_name", value: entry.display_name },
    ],
  }));
  const projects: ProjectCandidate[] = fixture.projects.map((entry: any) => ({
    source_ref: entry.source_ref,
    legacy_id: entry.legacy_id,
    root: entry.root,
    placement_kind: entry.placement_kind,
    repository_identities: entry.git_remote ? [{ kind: "git_remote", value: entry.git_remote }] : [],
  }));
  return {
    corpus: buildMigrationCorpus([{
      source_ref: "frozen:machine-identity-corpus-v1",
      source_kind: "identity" as const,
      source_digest: `sha256:${createHash("sha256").update(fixtureRaw).digest("hex")}` as const,
      file_count: 1,
      byte_count: fixtureRaw.byteLength,
      record_count: principals.length + projects.length,
    }]),
    principals,
    projects,
  };
}

describe("shadow identity import", () => {
  it("reconciles the frozen machine corpus without losing a source", () => {
    const result = importIdentityRegistries(frozenInput());
    expect(result.receipt.counts).toEqual({
      principal_sources: 9,
      project_sources: 29,
      canonical_principals: 9,
      canonical_projects: 23,
      unique_project_placements: 24,
      unresolved_project_sources: 0,
    });
    expect(Object.keys(result.source_to_principal)).toHaveLength(9);
    expect(Object.keys(result.source_to_project)).toHaveLength(29);
    expect(result.receipt.unresolved_project_sources).toEqual([]);
    expect(result.receipt.principal_diagnostics).toEqual([]);
    expect(result.receipt.project_diagnostics).toEqual([]);
  });

  it("is byte-identical across reruns and candidate discovery order", () => {
    const input = frozenInput();
    const first = importIdentityRegistries(input);
    const second = importIdentityRegistries({
      corpus: input.corpus,
      principals: [...input.principals].reverse(),
      projects: [...input.projects].reverse(),
    });
    expect(identityImportBytes(second)).toEqual(identityImportBytes(first));
    expect(identityImportDigest(second)).toBe(identityImportDigest(first));
  });

  it("keeps ambiguous project evidence in the explicit unresolved queue", () => {
    const principals: PrincipalCandidate[] = [{
      source_ref: "agent:a",
      kind: "agent",
      aliases: [{ namespace: "agent_id", value: "a" }],
    }];
    const projects: ProjectCandidate[] = [
      { source_ref: "a:0", root: "/same", placement_kind: "repository", repository_identities: [{ kind: "git_remote", value: "git@github.com:o/a.git" }] },
      { source_ref: "a:1", root: "/same", placement_kind: "repository", repository_identities: [{ kind: "git_remote", value: "git@github.com:o/b.git" }] },
    ];
    const corpus = buildMigrationCorpus([{
      source_ref: "conflict", source_kind: "identity", source_digest: `sha256:${"a".repeat(64)}`,
      file_count: 1, byte_count: 1, record_count: 3,
    }]);
    const result = importIdentityRegistries({ corpus, principals, projects });
    expect(result.receipt.counts.project_sources).toBe(2);
    expect(result.receipt.counts.unresolved_project_sources).toBe(2);
    expect(result.source_to_project).toEqual({});
    expect(result.receipt.unresolved_project_sources).toEqual(["a:0", "a:1"]);
    expect(result.receipt.project_diagnostics).toEqual([
      expect.objectContaining({ code: "conflicting_repository_identity" }),
    ]);
  });

  it("rejects a corpus whose record count cannot account for every identity source", () => {
    const input = frozenInput();
    const badCorpus = buildMigrationCorpus([{
      source_ref: "bad", source_kind: "identity", source_digest: `sha256:${"b".repeat(64)}`,
      file_count: 1, byte_count: 1, record_count: 37,
    }]);
    expect(() => importIdentityRegistries({ ...input, corpus: badCorpus }))
      .toThrowError(expect.objectContaining<Partial<MigrationContractError>>({ code: "invalid_contract" }));
  });

  it("rejects tampered registry and source-mapping evidence", () => {
    const result = importIdentityRegistries(frozenInput());
    const tamperedDigest = {
      ...result,
      receipt: { ...result.receipt, project_registry_digest: `sha256:${"0".repeat(64)}` },
    };
    expect(() => assertIdentityImportResult(tamperedDigest as typeof result))
      .toThrowError(expect.objectContaining<Partial<MigrationContractError>>({ code: "invalid_contract" }));

    const firstRef = Object.keys(result.source_to_principal)[0]!;
    const tamperedMapping = {
      ...result,
      source_to_principal: { ...result.source_to_principal, [firstRef]: result.project_registry.projects[0]!.project_id },
    };
    expect(() => assertIdentityImportResult(tamperedMapping as unknown as typeof result))
      .toThrowError(expect.objectContaining<Partial<MigrationContractError>>({ code: "invalid_contract" }));
  });
});
