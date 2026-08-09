import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { applyRootMigration, previewRootMigration, rollbackRootMigration } from "../src/root-migration.js";

describe("Space root migration", () => {
  it("previews without mutation and rejects conflicting canonical files", async () => {
    const fixture = await createFixture();
    const preview = await previewRootMigration({
      canonicalRoot: fixture.canonical,
      backupBase: fixture.backups,
      migrationId: "preview",
    });

    expect(preview.status).toBe("preview");
    expect(preview.source.file_count).toBe(3);
    await expect(stat(preview.backup_root)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(fixture.canonical, "live.db"), "conflict");
    await expect(previewRootMigration({ canonicalRoot: fixture.canonical })).rejects.toThrow(/conflicts at live\.db/);
    await expect(previewRootMigration({
      canonicalRoot: fixture.canonical,
      backupBase: path.join(fixture.canonical, "backups"),
    })).rejects.toThrow(/backup must be outside/);
  });

  it("backs up, reconciles, makes legacy read-only, and rolls back without loss", async () => {
    const fixture = await createFixture();
    const applied = await applyRootMigration({
      canonicalRoot: fixture.canonical,
      backupBase: fixture.backups,
      migrationId: "apply-test",
    });

    expect(applied.status).toBe("applied");
    expect(applied.canonical).toEqual(applied.source);
    expect(applied.backup).toEqual(applied.source);
    expect(await readFile(path.join(fixture.canonical, "spaces", "team", "messages.jsonl"), "utf8")).toBe('{"id":"m1"}\n');
    expect((await stat(fixture.legacy)).mode & 0o222).toBe(0);
    expect((await stat(path.join(fixture.legacy, "live.db"))).mode & 0o222).toBe(0);

    const rolledBack = await rollbackRootMigration(applied.manifest_path);
    expect(rolledBack.status).toBe("rolled_back");
    await expect(stat(path.join(fixture.canonical, "live.db"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(fixture.legacy, "live.db"), "utf8")).toBe("sqlite-fixture");
    expect((await stat(fixture.legacy)).mode & 0o200).toBe(0o200);
    expect((await stat(path.join(fixture.legacy, "live.db"))).mode & 0o200).toBe(0o200);
  });

  it("keeps identical canonical files across rollback", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.canonical, "live.db"), "sqlite-fixture");
    const applied = await applyRootMigration({
      canonicalRoot: fixture.canonical,
      backupBase: fixture.backups,
      migrationId: "preexisting-test",
    });
    await rollbackRootMigration(applied.manifest_path);
    expect(await readFile(path.join(fixture.canonical, "live.db"), "utf8")).toBe("sqlite-fixture");
  });

  it("refuses rollback after canonical data diverges", async () => {
    const fixture = await createFixture();
    const applied = await applyRootMigration({
      canonicalRoot: fixture.canonical,
      backupBase: fixture.backups,
      migrationId: "divergence-test",
    });
    await writeFile(path.join(fixture.canonical, "live.db"), "new canonical writes");

    await expect(rollbackRootMigration(applied.manifest_path)).rejects.toThrow(/would lose data/);
    expect(await readFile(path.join(fixture.canonical, "live.db"), "utf8")).toBe("new canonical writes");
    expect((await stat(fixture.legacy)).mode & 0o222).toBe(0);
  });
});

async function createFixture(): Promise<{ canonical: string; legacy: string; backups: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "seedrop-root-migration-"));
  const canonical = path.join(base, "space");
  const legacy = path.join(canonical, ".seedrop", "space");
  const backups = path.join(base, "backups");
  await mkdir(path.join(legacy, "spaces", "team"), { recursive: true });
  await mkdir(path.join(legacy, "notifications"), { recursive: true });
  await writeFile(path.join(legacy, "live.db"), "sqlite-fixture");
  await writeFile(path.join(legacy, "spaces", "team", "meta.json"), '{"id":"team"}\n');
  await writeFile(path.join(legacy, "spaces", "team", "messages.jsonl"), '{"id":"m1"}\n');
  await chmod(path.join(legacy, "live.db"), 0o640);
  return { canonical, legacy, backups };
}
