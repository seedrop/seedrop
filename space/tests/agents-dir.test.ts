import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPassportIdentityResolver } from "../src/serve.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "seedrop-agents-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePassport(filePath: string, agentId: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ agent_id: agentId, name: agentId }));
}

describe("createPassportIdentityResolver with agentsDirs", () => {
  it("auto-discovers passports from agentsDirs at startup", async () => {
    const operatorPath = path.join(root, "passport.json");
    const agentsDir = path.join(root, "agents");
    await writePassport(operatorPath, "mc");
    await writePassport(path.join(agentsDir, "claude.json"), "claude");
    await writePassport(path.join(agentsDir, "codex.json"), "codex");

    const { identities, resolver, stopWatching } = await createPassportIdentityResolver({
      passportPaths: [operatorPath],
      agentsDirs: [agentsDir],
    });
    try {
      expect(identities.map((i) => i.agentId).sort()).toEqual(["claude", "codex", "mc"]);
      expect(resolver.resolve("claude")?.agentId).toBe("claude");
      expect(resolver.resolve("codex")?.agentId).toBe("codex");
      expect(resolver.resolve("unknown")).toBeNull();
    } finally {
      stopWatching();
    }
  });

  it("deduplicates passports that appear in both --passport and agentsDirs", async () => {
    const agentsDir = path.join(root, "agents");
    const claudePath = path.join(agentsDir, "claude.json");
    await writePassport(claudePath, "claude");

    const { identities, stopWatching } = await createPassportIdentityResolver({
      passportPaths: [claudePath],
      agentsDirs: [agentsDir],
    });
    try {
      expect(identities.map((i) => i.agentId)).toEqual(["claude"]);
    } finally {
      stopWatching();
    }
  });

  it("skips unreadable or invalid passport files", async () => {
    const agentsDir = path.join(root, "agents");
    await writePassport(path.join(agentsDir, "claude.json"), "claude");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, "broken.json"), "{not-json");

    const { identities, stopWatching } = await createPassportIdentityResolver({
      agentsDirs: [agentsDir],
    });
    try {
      expect(identities.map((i) => i.agentId)).toEqual(["claude"]);
    } finally {
      stopWatching();
    }
  });

  it("refresh() picks up a passport added after startup", async () => {
    const agentsDir = path.join(root, "agents");
    await writePassport(path.join(agentsDir, "claude.json"), "claude");

    const { resolver, refresh, stopWatching } = await createPassportIdentityResolver({
      agentsDirs: [agentsDir],
    });
    try {
      expect(resolver.resolve("kimi")).toBeNull();

      await writePassport(path.join(agentsDir, "kimi.json"), "kimi");
      const next = await refresh();

      expect(next.map((i) => i.agentId).sort()).toEqual(["claude", "kimi"]);
      expect(resolver.resolve("kimi")?.agentId).toBe("kimi");
    } finally {
      stopWatching();
    }
  });

  it("watchAgentsDirs admits a new passport without a manual refresh call", async () => {
    const agentsDir = path.join(root, "agents");
    await writePassport(path.join(agentsDir, "claude.json"), "claude");

    const { resolver, stopWatching } = await createPassportIdentityResolver({
      agentsDirs: [agentsDir],
      watchAgentsDirs: true,
    });
    try {
      expect(resolver.resolve("kimi")).toBeNull();

      await writePassport(path.join(agentsDir, "kimi.json"), "kimi");
      // Watcher debounce is 100ms; macOS FSEvents can be slower.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (resolver.resolve("kimi")) break;
      }

      expect(resolver.resolve("kimi")?.agentId).toBe("kimi");
    } finally {
      stopWatching();
    }
  });

  it("stopWatching is idempotent and cleans up", async () => {
    const agentsDir = path.join(root, "agents");
    await writePassport(path.join(agentsDir, "claude.json"), "claude");

    const { stopWatching } = await createPassportIdentityResolver({
      agentsDirs: [agentsDir],
      watchAgentsDirs: true,
    });
    stopWatching();
    stopWatching(); // should not throw
  });
});
