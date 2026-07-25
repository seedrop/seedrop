import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceView } from "@seedrop/space";
import { startBenchServer } from "../src/server.js";
import type { Passport } from "@seedrop/id";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-bench-server-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("startBenchServer", () => {
  it("serves the Bench shell, state JSON, and health over loopback", async () => {
    const projectRoot = await createProject("seedrop");
    const passportPath = await writePassport({
      active_projects: [{ id: "seedrop", root: projectRoot, view: ".seedrop/view" }],
    });
    const started = await startBenchServer({
      passportPath,
      spaceUrl: null,
      host: "127.0.0.1",
      port: 0,
      selectedProjectId: "seedrop",
    });

    try {
      const html = await fetchText(started.url);
      expect(html).toContain("Seedrop Bench");
      expect(html).toContain("Activity");
      expect(html).toContain("seedrop");

      const state = await fetchJson(`${started.url}state.json`) as { schema_version?: string; projects?: Array<{ id: string }> };
      expect(state.schema_version).toBe("1.0");
      expect(state.projects?.map((project) => project.id)).toEqual(["seedrop"]);

      const health = await fetchJson(`${started.url}health`) as { ok?: boolean; service?: string };
      expect(health).toEqual({ ok: true, service: "seedrop-bench" });
    } finally {
      await started.close();
    }
  });
});

async function createProject(id: string): Promise<string> {
  const projectRoot = path.join(root, id);
  await mkdir(path.join(projectRoot, ".seedrop", "view"), { recursive: true });
  await writeFile(path.join(projectRoot, "README.md"), `# ${id}\n`);
  await writeFile(
    path.join(projectRoot, ".seedrop", "view", "policy.json"),
    JSON.stringify({
      purpose: `${id} fixture.`,
      current_focus: "Launch through Bench.",
      required_success_level: "L1",
    }),
  );
  await WorkspaceView.open({ root: projectRoot, agent: "codex" }).sync({ workspaceId: id });
  return projectRoot;
}

async function writePassport(overrides: Partial<Passport>): Promise<string> {
  const passport: Passport = {
    version: "1.0",
    agent_id: "codex",
    name: "Codex",
    purpose: "Test Seedrop Bench",
    core_commitments: [],
    value_anchors: [],
    competencies: [],
    limits: [],
    learned_blocks: [],
    active_projects: [],
    metadata: {
      created_at: "2026-06-12T12:00:00.000Z",
      session_count: 0,
    },
    ...overrides,
  };
  const passportPath = path.join(root, "passport.json");
  await writeFile(passportPath, JSON.stringify(passport, null, 2));
  return passportPath;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return await response.text();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return await response.json();
}
