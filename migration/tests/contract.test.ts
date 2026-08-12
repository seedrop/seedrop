import { describe, expect, it } from "vitest";
import type { ProjectProjectionReference } from "@seedrop/project";
import {
  MigrationContractError,
  advanceShadowMigrationReceipt,
  assertMigrationCorpusUnchanged,
  assertShadowMigrationReceipt,
  buildMigrationCorpus,
  buildPreviewMigrationReceipt,
  shadowMigrationNextAction,
  shadowMigrationReceiptDigest,
} from "../src/index.js";

const A = `sha256:${"a".repeat(64)}` as const;
const B = `sha256:${"b".repeat(64)}` as const;
const C = `sha256:${"c".repeat(64)}` as const;
const D = `sha256:${"d".repeat(64)}` as const;
const PROJECT = "sd_prj_00000000-0000-7000-8000-000000000001" as ProjectProjectionReference["project_id"];

function corpus() {
  return buildMigrationCorpus([
    { source_ref: "view:z", source_kind: "view", source_digest: B, file_count: 3, byte_count: 90, record_count: 5 },
    { source_ref: "identity", source_kind: "identity", source_digest: A, file_count: 2, byte_count: 10, record_count: 2 },
  ]);
}

describe("Wave 4 shadow migration contract", () => {
  it("conserves and deterministically orders the admitted source corpus", () => {
    const value = corpus();
    expect(value.sources.map((source) => source.source_ref)).toEqual(["identity", "view:z"]);
    expect(value.counts).toEqual({ sources: 2, files: 5, bytes: 100, records: 7 });
    expect(value.corpus_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.sources)).toBe(true);
  });

  it("resumes through every representable state and stops before cutover", () => {
    const admitted = corpus();
    const preview = buildPreviewMigrationReceipt({ migration_id: "wave4-test", corpus: admitted, issued_at: "2026-08-12T00:00:00.000Z" });
    const snapshot = advanceShadowMigrationReceipt(preview, {
      state: "source_snapshot_verified", observed_corpus: admitted, snapshot_receipt_digest: C, issued_at: "2026-08-12T00:00:01.000Z",
    });
    const staged = advanceShadowMigrationReceipt(snapshot, {
      state: "staged", observed_corpus: admitted, issued_at: "2026-08-12T00:00:02.000Z",
      staged_projects: [{ project_id: PROJECT, projection_version: "1.0.0", source_high_watermark: D, source_digest: B }],
    });
    const verified = advanceShadowMigrationReceipt(staged, {
      state: "verified_not_authorized_for_cutover", observed_corpus: admitted, issued_at: "2026-08-12T00:00:03.000Z",
      reconciliation: { source_records: 7, imported_records: 5, quarantined_records: 1, unresolved_records: 1 },
    });

    for (const receipt of [preview, snapshot, staged, verified]) {
      expect(() => assertShadowMigrationReceipt(JSON.parse(JSON.stringify(receipt)))).not.toThrow();
      expect(shadowMigrationReceiptDigest(receipt)).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect([preview, snapshot, staged, verified].map(shadowMigrationNextAction)).toEqual([
      "verify_source_snapshot",
      "stage_shadow_import",
      "verify_reconciliation",
      "stop_no_cutover_authority",
    ]);
    expect(() => advanceShadowMigrationReceipt(verified, {
      state: "verified_not_authorized_for_cutover", observed_corpus: admitted, issued_at: "2026-08-12T00:00:04.000Z",
      reconciliation: verified.reconciliation,
    })).toThrowError(MigrationContractError);
  });

  it("refuses source drift at every post-preview boundary", () => {
    const admitted = corpus();
    const changed = buildMigrationCorpus([
      { source_ref: "identity", source_kind: "identity", source_digest: A, file_count: 2, byte_count: 11, record_count: 2 },
      { source_ref: "view:z", source_kind: "view", source_digest: B, file_count: 3, byte_count: 90, record_count: 5 },
    ]);
    expect(() => assertMigrationCorpusUnchanged(admitted, changed)).toThrowError(expect.objectContaining({ code: "source_changed" }));
    const preview = buildPreviewMigrationReceipt({ migration_id: "wave4-drift", corpus: admitted, issued_at: "2026-08-12T00:00:00.000Z" });
    expect(() => advanceShadowMigrationReceipt(preview, {
      state: "source_snapshot_verified", observed_corpus: changed, snapshot_receipt_digest: C, issued_at: "2026-08-12T00:00:01.000Z",
    })).toThrowError(expect.objectContaining({ code: "source_changed" }));
  });

  it("refuses skipped states and reconciliation that loses records", () => {
    const admitted = corpus();
    const preview = buildPreviewMigrationReceipt({ migration_id: "wave4-invalid", corpus: admitted, issued_at: "2026-08-12T00:00:00.000Z" });
    expect(() => advanceShadowMigrationReceipt(preview, {
      state: "staged", observed_corpus: admitted, issued_at: "2026-08-12T00:00:01.000Z", staged_projects: [],
    })).toThrowError(expect.objectContaining({ code: "invalid_transition" }));

    const snapshot = advanceShadowMigrationReceipt(preview, {
      state: "source_snapshot_verified", observed_corpus: admitted, snapshot_receipt_digest: C, issued_at: "2026-08-12T00:00:01.000Z",
    });
    const staged = advanceShadowMigrationReceipt(snapshot, {
      state: "staged", observed_corpus: admitted, staged_projects: [], issued_at: "2026-08-12T00:00:02.000Z",
    });
    expect(() => advanceShadowMigrationReceipt(staged, {
      state: "verified_not_authorized_for_cutover", observed_corpus: admitted, issued_at: "2026-08-12T00:00:03.000Z",
      reconciliation: { source_records: 7, imported_records: 6, quarantined_records: 0, unresolved_records: 0 },
    })).toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });

  it("rejects noncanonical or cutover-shaped receipt bytes", () => {
    const preview = buildPreviewMigrationReceipt({
      migration_id: "wave4-shape", corpus: corpus(), issued_at: "2026-08-12T00:00:00.000Z",
    });
    const withCutoverAuthority = { ...preview, cutover_authorized: true };
    expect(() => assertShadowMigrationReceipt(withCutoverAuthority as unknown as typeof preview))
      .toThrowError(expect.objectContaining({ code: "invalid_contract" }));
  });
});
