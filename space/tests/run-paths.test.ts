import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceView } from "../src/view.js";

let root: string;
let now: Date;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-runpaths-"));
  now = new Date("2026-05-18T10:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(): WorkspaceView {
  return WorkspaceView.open({ root, agent: "kimi", now: () => now });
}

describe("run journal path normalization (kimi's data-integrity bug)", () => {
  it("logRun stores absolute paths as workspace-relative", async () => {
    await writeFile(path.join(root, "package.json"), "{}\n");
    await view().sync();
    await view().startRun({ goal: "test absolute paths" });

    const absolute = path.join(root, "package.json");
    const updated = await view().logRun({
      summary: "added package",
      changedPaths: [absolute],
    });

    // Stored form is relative (no leading slash, no absolute prefix).
    expect(updated.changed_paths).toEqual(["package.json"]);
    expect(updated.steps[0]?.changed_paths).toEqual(["package.json"]);
  });

  it("logRun rejects paths that escape the workspace root", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await view().startRun({ goal: "test escape" });

    await expect(
      view().logRun({ summary: "naughty", changedPaths: ["../escape.md"] }),
    ).rejects.toThrow(/escapes workspace root/);
  });

  it("log() (continuity packet) normalizes absolute paths too", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    const packet = await view().log({
      mission: "abs paths in packet",
      summary: "did stuff",
      changedPaths: [path.join(root, "README.md")],
    });
    expect(packet.changed_paths).toEqual(["README.md"]);
  });

  it("claimSignal normalizes target", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/view.ts"), "// stub\n");
    await view().sync();
    const signal = await view().claimSignal({
      target: path.join(root, "src/view.ts"),
      intent: "test claim",
    });
    expect(signal.target).toBe("src/view.ts");
  });

  it("startRun --claim normalizes paths and writes a relative-form signal", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    const { run } = await view().startRun({
      goal: "test claim normalization",
      claim: [path.join(root, "README.md")],
    });
    expect(run.run_id).toBeTruthy();
    const signals = await view().listSignals();
    expect(signals.find((s) => s.target === "README.md")).toBeDefined();
  });

  it("listRunsWithErrors surfaces malformed run files with the parse error", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await mkdir(path.join(root, ".seedrop", "view", "runs"), { recursive: true });
    // Write a corrupted run file directly (simulates kimi's pre-fix scenario).
    await writeFile(
      path.join(root, ".seedrop", "view", "runs", "broken.json"),
      JSON.stringify({
        schema_version: "1.0",
        run_id: "00000000-0000-4000-8000-000000000000",
        agent_id: "kimi",
        goal: "broken",
        status: "in_progress",
        started_at: "2026-05-18T10:00:00.000Z",
        updated_at: "2026-05-18T10:00:00.000Z",
        steps: [],
        decisions: [],
        assumptions: [],
        open_threads: [],
        changed_paths: ["/absolute/path/leaks/in.ts"], // <— invalid per RelativePath
        validation: [],
        next_actions: [],
      }),
    );

    // Silence stderr so the test output stays clean.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { runs, malformed } = await view().listRunsWithErrors();
      expect(runs).toHaveLength(0);
      expect(malformed).toHaveLength(1);
      expect(malformed[0]?.filename).toBe("broken.json");
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("requireActiveRun's error mentions corrupted run files when present", async () => {
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await view().sync();
    await mkdir(path.join(root, ".seedrop", "view", "runs"), { recursive: true });
    await writeFile(
      path.join(root, ".seedrop", "view", "runs", "corrupt.json"),
      "{not-json",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // logRun calls requireActiveRun internally. Should surface the corruption hint.
      await expect(
        view().logRun({ summary: "test" }),
      ).rejects.toThrow(/failed to parse|corrupt/i);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
