import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes, projectTransactionBytes, projectTransactionDigest } from "@seedrop/protocol";
import {
  inspectProjectSituation,
  projectStoreLayout,
  publishProjectTransaction,
  queryProjectWorkReceipts,
  rebuildProjectProjection,
} from "../src/index.js";
import type { ProjectArtifactFamily } from "../src/index.js";
import { PROJECT_ID, makeTransaction } from "./fixtures.js";

const OBSERVED_AT = "2026-08-11T16:00:00.000Z";
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("evidence-backed Project situation", () => {
  it("reports a clean canonical source and disposable index as healthy", async () => {
    const { root } = await baseline();
    const situation = await inspectProjectSituation(root, PROJECT_ID, { observed_at: OBSERVED_AT });
    expect(situation.health.substrate).toBe("healthy");
    expect(situation.projection.lag.complete).toBe(true);
    expect(situation.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "transaction", status: "valid" }),
      expect.objectContaining({ family: "projection_index", status: "valid" }),
      expect.objectContaining({ family: "staging", status: "absent" }),
      expect.objectContaining({ family: "writer_lock", status: "absent" }),
    ]));
  });

  it("promotes structural transaction diagnostics into corrupt Health", async () => {
    const fixture = await baseline();
    await publishProjectTransaction({ root: fixture.root, transaction: makeTransaction(2, fixture.transaction_digest) });
    await publishProjectTransaction({ root: fixture.root, transaction: makeTransaction(3, fixture.transaction_digest) });
    const situation = await inspectProjectSituation(fixture.root, PROJECT_ID, { observed_at: OBSERVED_AT });
    expect(situation.projection.lag.complete).toBe(false);
    expect(situation.health.substrate).toBe("corrupt");
    expect(situation.artifacts.filter((item) => item.family === "transaction" && item.code === "fork")).toHaveLength(2);
    expect(situation.health.quarantined.filter((item) => item.code === "fork")).toHaveLength(2);
  });

  it("does not hide unexpected index or lock-family artifacts", async () => {
    const fixture = await baseline();
    const layout = projectStoreLayout(fixture.root);
    await writeFile(join(layout.index_dir, ".project-projection.crash.tmp"), "index-evidence");
    await mkdir(join(layout.locks_dir, ".stale-project-writer.proof"), { recursive: true });
    await writeFile(join(layout.locks_dir, ".stale-project-writer.proof", "owner.json"), "lock-evidence");
    const situation = await inspectProjectSituation(fixture.root, PROJECT_ID, { observed_at: OBSERVED_AT });
    expect(situation.health.substrate).toBe("degraded");
    expect(situation.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "projection_index", code: "unexpected_path", actual_digest: expect.any(String) }),
      expect.objectContaining({ family: "writer_lock", code: "unexpected_path", path: expect.stringContaining("owner.json"), actual_digest: expect.any(String) }),
    ]));
  });

  it.each([
    ["transaction", "corrupt"], ["transaction", "truncate"], ["transaction", "deny"],
    ["staging", "corrupt"], ["staging", "truncate"], ["staging", "deny"],
    ["projection_index", "corrupt"], ["projection_index", "truncate"], ["projection_index", "deny"],
    ["writer_lock", "corrupt"], ["writer_lock", "truncate"], ["writer_lock", "deny"],
  ] as const)("preserves and exposes %s bytes after %s", async (family, mutation) => {
    const fixture = await baseline();
    const target = await artifactTarget(fixture, family);
    const original = await readFile(target);
    const replacement = mutation === "corrupt" ? corruptBytes(family)
      : mutation === "truncate" ? original.subarray(0, Math.max(1, Math.floor(original.byteLength / 3)))
        : original;
    if (mutation === "deny") await chmod(target, 0o000);
    else await writeFile(target, replacement);

    try {
      const situation = await inspectProjectSituation(fixture.root, PROJECT_ID, { observed_at: OBSERVED_AT });
      const evidence = situation.artifacts.find((item) => item.family === family && item.status === "quarantined");
      expect(evidence).toMatchObject({ family, status: "quarantined" });
      expect(evidence?.path).toBeTruthy();
      if (mutation === "deny") expect(evidence?.code).toBe("read_failed");
      else expect(typeof evidence?.code).toBe("string");
      expect(evidence?.repair).toBeTruthy();
      expect(situation.health.quarantined).toEqual(expect.arrayContaining([
        expect.objectContaining({ source_id: sourceId(family), referent: evidence?.path, repair: evidence?.repair }),
      ]));
      expect(situation.health.substrate).toBe(family === "transaction" ? "corrupt" : "degraded");

      const query = await queryProjectWorkReceipts(fixture.root, PROJECT_ID, {}, { observed_at: OBSERVED_AT });
      expect(query.complete).toBe(family !== "transaction");
      expect(query.health.substrate).toBe(situation.health.substrate);
      expect(query.artifacts).toEqual(situation.artifacts);
    } finally {
      if (mutation === "deny") await chmod(target, 0o600);
    }
    expect(await readFile(target)).toEqual(replacement);
  });
});

interface Baseline {
  root: string;
  transaction_path: string;
  transaction_bytes: Uint8Array;
  transaction_digest: ReturnType<typeof projectTransactionDigest>;
}

async function baseline(): Promise<Baseline> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-project-situation-"));
  roots.push(root);
  const transaction = makeTransaction(1, null);
  const receipt = await publishProjectTransaction({ root, transaction });
  await rebuildProjectProjection(root, PROJECT_ID);
  return {
    root,
    transaction_path: join(root, ...receipt.relative_path.split("/")),
    transaction_bytes: projectTransactionBytes(transaction),
    transaction_digest: projectTransactionDigest(transaction),
  };
}

async function artifactTarget(fixture: Baseline, family: ProjectArtifactFamily): Promise<string> {
  const layout = projectStoreLayout(fixture.root);
  if (family === "transaction") return fixture.transaction_path;
  if (family === "projection_index") return layout.projection_index;
  if (family === "staging") {
    const path = join(layout.staging_dir, `${fixture.transaction_digest.slice(7)}.999.proof.tmp`);
    await writeFile(path, fixture.transaction_bytes);
    return path;
  }
  await mkdir(layout.writer_lock, { recursive: true });
  const path = join(layout.writer_lock, "owner.json");
  await writeFile(path, canonicalJsonBytes({
    acquired_at: "2026-08-11T15:59:00.000Z",
    hostname: "proof-host",
    pid: 999_999,
    schema_version: "1.0",
    stale_after: "2026-08-11T16:01:00.000Z",
    token: "proof-owner",
  }));
  return path;
}

function sourceId(family: ProjectArtifactFamily): string {
  return ({
    transaction: "project-transactions",
    staging: "project-staging",
    projection_index: "project-projection-index",
    writer_lock: "project-writer-lock",
  })[family];
}

function corruptBytes(family: ProjectArtifactFamily): Buffer {
  if (family === "projection_index" || family === "writer_lock") return Buffer.from("{}");
  return Buffer.from("definitely-not-the-original-artifact");
}
