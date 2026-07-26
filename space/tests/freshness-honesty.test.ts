import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/view.js";

/**
 * Regression cover for a source-disagreement bug: `context()` reads freshness
 * from a cached audit snapshot, and the cached path used to return "fresh"
 * whenever it could not tell — missing snapshot, unparseable snapshot, or a
 * snapshot of any age. Absence of evidence became evidence of freshness, so
 * boot reported L4/meets_required while `view brief` and `view preflight`
 * reported L1/below-required on the same repo in the same second.
 *
 * The invariant these tests defend: a surface with weaker evidence must never
 * report a higher trust level than one with stronger evidence.
 */

let root: string;

const LEVELS = ["L0", "L1", "L2", "L3", "L4"] as const;
const rank = (level: string): number => LEVELS.indexOf(level as (typeof LEVELS)[number]);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-fresh-"));
  await writeFile(path.join(root, "README.md"), "# Demo\n");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n");
  await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
  await writeFile(
    path.join(root, ".seedrop", "view", "policy.json"),
    JSON.stringify({
      purpose: "Demo orientation substrate.",
      required_success_level: "L2",
      freshness_ttl_hours: 24,
      preferred_verification_commands: ["npm test"],
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(): WorkspaceView {
  return WorkspaceView.open({ root, agent: "codex" });
}

const auditPath = (): string => path.join(root, ".seedrop", "view", "audit.json");
const manifestPath = (): string => path.join(root, ".seedrop", "view", "manifest.json");

/** Push the manifest's own updated_at past the policy TTL (24h in these fixtures). */
async function ageManifestBeyondTtl(): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath(), "utf8")) as { updated_at: string };
  manifest.updated_at = new Date(Date.now() - 72 * 3_600_000).toISOString();
  await writeFile(manifestPath(), JSON.stringify(manifest));
}

describe("cached freshness fails closed", () => {
  it("falls back to manifest age when no audit snapshot exists", async () => {
    await view().sync();
    await rm(auditPath(), { force: true });
    const brief = await view().brief({ checkFreshness: false });
    // Just synced: fresh by construction, and must not be punished for never
    // having been audited.
    expect(brief.manifest?.freshness).toBe("fresh");
    expect(brief.manifest?.freshness_source).toBe("cached");
  });

  it("reports unknown when no snapshot exists and the manifest is past the TTL", async () => {
    await view().sync();
    await rm(auditPath(), { force: true });
    await ageManifestBeyondTtl();
    const brief = await view().brief({ checkFreshness: false });
    expect(brief.manifest?.freshness).toBe("unknown");
  });

  it("reports unknown when the snapshot is unparseable and the manifest is past the TTL", async () => {
    await view().sync();
    await ageManifestBeyondTtl();
    await writeFile(auditPath(), "{not json");
    const brief = await view().brief({ checkFreshness: false });
    expect(brief.manifest?.freshness).toBe("unknown");
  });

  it("reports unknown when both the snapshot and the manifest are past the TTL", async () => {
    await view().sync();
    await view().audit();
    const old = new Date(Date.now() - 72 * 3_600_000);
    await utimes(auditPath(), old, old);
    await ageManifestBeyondTtl();
    const brief = await view().brief({ checkFreshness: false });
    expect(brief.manifest?.freshness).toBe("unknown");
  });

  it("still reports fresh from a recent, clean snapshot", async () => {
    await view().sync();
    await view().audit();
    const brief = await view().brief({ checkFreshness: false });
    expect(brief.manifest?.freshness).toBe("fresh");
  });
});

describe("freshness provenance is explicit", () => {
  it("labels a live check as live and a cached read as cached", async () => {
    await view().sync();
    await view().audit();
    expect((await view().brief()).manifest?.freshness_source).toBe("live");
    expect((await view().brief({ checkFreshness: false })).manifest?.freshness_source).toBe("cached");
  });
});

describe("weaker evidence never outranks stronger evidence", () => {
  it("context() never reports a higher success level than a live brief", async () => {
    await view().sync();
    await rm(auditPath(), { force: true });
    await ageManifestBeyondTtl();
    // Drift the tree so a live check would say stale.
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = false; // changed\n");

    const live = await view().brief();
    const context = await view().context({ budgetBytes: 0 });
    const contextLevel = (context.brief as { success?: { level: string } } | undefined)?.success?.level;

    expect(contextLevel).toBeTruthy();
    expect(rank(contextLevel!)).toBeLessThanOrEqual(rank(live.success.level));
  });

  it("does not claim meets_required off a missing snapshot", async () => {
    await view().sync();
    await rm(auditPath(), { force: true });
    await ageManifestBeyondTtl();
    await writeFile(path.join(root, "src", "index.ts"), "export const drifted = true;\n");
    const context = await view().context({ budgetBytes: 0 });
    const success = (context.brief as { success?: { meets_required?: boolean } } | undefined)?.success;
    expect(success?.meets_required).toBe(false);
  });
});
