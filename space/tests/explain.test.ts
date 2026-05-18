import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "../src/view.js";
import { explainPath, explainSuccess } from "../src/explain.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-explain-"));
  now = new Date("2026-05-18T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(): WorkspaceView {
  return WorkspaceView.open({ root, agent: "claude", now: () => now });
}

describe("explainPath", () => {
  it("flags a file that is on disk but not in the manifest", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().init("demo");
    // No sync yet — manifest is empty.
    const report = await explainPath(view(), "README.md");
    expect(report.on_disk).toBe(true);
    expect(report.in_manifest).toBe(false);
    expect(report.notes.some((n) => /not in the manifest/.test(n))).toBe(true);
  });

  it("surfaces policy.recommended_read_reason flow after sync", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "policy.json"),
      JSON.stringify({
        purpose: "demo",
        path_purposes: {
          "README.md": { purpose: "Project overview", recommended_read_reason: "Start here", recommended_read_priority: 1 },
        },
      }),
    );
    await view().sync({ workspaceId: "demo" });

    const report = await explainPath(view(), "README.md");
    expect(report.in_manifest).toBe(true);
    expect(report.policy_purpose).toBe("Project overview");
    expect(report.policy_recommended_read_reason).toBe("Start here");
    expect(report.policy_recommended_read_priority).toBe(1);
    expect(report.in_recommended_reads).toBe(true);
  });

  it("flags ignored paths", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, "secrets.env"), "...");
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "policy.json"),
      JSON.stringify({ purpose: "demo", ignore: ["secrets.env"] }),
    );
    await view().sync({ workspaceId: "demo" });

    const report = await explainPath(view(), "secrets.env");
    expect(report.ignored).toBe(true);
    expect(report.in_manifest).toBe(false);
    expect(report.notes.some((n) => /policy\.ignore/.test(n))).toBe(true);
  });
});

describe("explainSuccess", () => {
  it("shows all criteria as failing when nothing is set up", async () => {
    await view().init("demo");
    const report = await explainSuccess(view());
    expect(report.level).toBe("L1");
    const byId = Object.fromEntries(report.criteria.map((c) => [c.id, c.met]));
    expect(byId.view_present).toBe(true);
    expect(byId.manifest_present).toBe(true);
    expect(byId.policy_purpose).toBe(false);
    expect(byId.verification_commands).toBe(false);
  });

  it("flips criteria to met as state is added (derived, not narrated)", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n');
    await mkdir(path.join(root, ".seedrop", "view"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "policy.json"),
      JSON.stringify({
        purpose: "demo",
        preferred_verification_commands: ["npm test"],
      }),
    );
    await view().sync({ workspaceId: "demo" });

    const report = await explainSuccess(view());
    const byId = Object.fromEntries(report.criteria.map((c) => [c.id, c.met]));
    expect(byId.policy_purpose).toBe(true);
    expect(byId.verification_commands).toBe(true);
  });
});
