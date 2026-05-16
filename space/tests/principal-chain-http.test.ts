import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSpaceServer, type StartedSpaceServer } from "../src/index.js";

let root: string;
let mcPath: string;
let claudePath: string;
let botPath: string;
let started: StartedSpaceServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seed-chain-http-"));
  mcPath = path.join(root, "mc.json");
  claudePath = path.join(root, "claude.json");
  botPath = path.join(root, "bot.json");
  await writeFile(
    mcPath,
    JSON.stringify({
      version: "1.0",
      agent_id: "mc",
      name: "mc",
      purpose: "operator",
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
  await writeFile(
    claudePath,
    JSON.stringify({
      version: "1.0",
      agent_id: "claude",
      name: "claude",
      purpose: "code",
      issued_by: "mc",
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
  await writeFile(
    botPath,
    JSON.stringify({
      version: "1.0",
      agent_id: "ci-bot",
      name: "ci-bot",
      purpose: "auto",
      autonomous: true,
      core_commitments: [],
      value_anchors: [],
      competencies: [],
      limits: [],
      learned_blocks: [],
      metadata: { created_at: "2026-05-15T08:00:00.000Z", session_count: 0 },
    }),
  );
});

afterEach(async () => {
  if (started) {
    await new Promise<void>((resolve, reject) =>
      started?.server.close((error) => (error ? reject(error) : resolve())),
    );
    started = undefined;
  }
  await rm(root, { recursive: true, force: true });
});

async function postAs(url: string, passportId: string, space: string, content: string): Promise<unknown> {
  const response = await fetch(`${url}/spaces/${encodeURIComponent(space)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seedrop-passport": passportId },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error(`POST ${space}/messages → ${response.status}`);
  return response.json();
}

async function joinAs(url: string, passportId: string, space: string): Promise<unknown> {
  const response = await fetch(`${url}/spaces/${encodeURIComponent(space)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seedrop-passport": passportId },
    body: "{}",
  });
  if (!response.ok) throw new Error(`POST ${space}/join → ${response.status}`);
  return response.json();
}

describe("principal_chain over HTTP", () => {
  it("attaches issued_by chain to messages from an agent under an operator", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, botPath],
      port: 0,
    });
    await joinAs(started.url, "claude", "team");
    const posted = (await postAs(started.url, "claude", "team", "hi")) as { message: { principal_chain?: string[] } };
    expect(posted.message.principal_chain).toEqual(["claude", "mc"]);
  });

  it("marks autonomous principals and stops the chain there", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, botPath],
      port: 0,
    });
    await joinAs(started.url, "ci-bot", "team");
    const posted = (await postAs(started.url, "ci-bot", "team", "auto-tick")) as {
      message: { principal_chain?: string[]; author_autonomous?: boolean };
    };
    expect(posted.message.principal_chain).toEqual(["ci-bot"]);
    expect(posted.message.author_autonomous).toBe(true);
  });

  it("operator-only posts have a single-entry chain", async () => {
    started = await startSpaceServer({
      root,
      passportPaths: [mcPath, claudePath, botPath],
      port: 0,
    });
    await joinAs(started.url, "mc", "team");
    const posted = (await postAs(started.url, "mc", "team", "from operator")) as { message: { principal_chain?: string[] } };
    expect(posted.message.principal_chain).toEqual(["mc"]);
  });
});
