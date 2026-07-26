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

describe("the poll safety net covers dropped fs.watch events", () => {
  it("admits a new passport faster than the watcher debounce could", async () => {
    const agentsDir = path.join(root, "agents");
    await writePassport(path.join(agentsDir, "claude.json"), "claude");

    // The watcher path cannot resolve sooner than its 100ms debounce, which
    // only starts once an event arrives. A 10ms poll therefore wins every race
    // it is in — so an admission observed well inside that debounce window is
    // attributable to the poll and nothing else. This is what rescues the ~1-in-20
    // write where fs.watch never fires at all.
    const { resolver, stopWatching } = await createPassportIdentityResolver({
      agentsDirs: [agentsDir],
      watchAgentsDirs: true,
      agentsDirsPollMs: 10,
    });
    try {
      expect(resolver.resolve("kimi")).toBeNull();

      const startedAt = Date.now();
      await writePassport(path.join(agentsDir, "kimi.json"), "kimi");
      for (let i = 0; i < 200; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
        if (resolver.resolve("kimi")) break;
      }
      const elapsed = Date.now() - startedAt;

      expect(resolver.resolve("kimi")?.agentId).toBe("kimi");
      expect(elapsed).toBeLessThan(100);
    } finally {
      stopWatching();
    }
  });

  it("stops polling once stopWatching is called", async () => {
    const agentsDir = path.join(root, "agents");
    await writePassport(path.join(agentsDir, "claude.json"), "claude");
    const { resolver, stopWatching } = await createPassportIdentityResolver({
      agentsDirs: [agentsDir],
      watchAgentsDirs: true,
      agentsDirsPollMs: 10,
    });
    stopWatching();

    await writePassport(path.join(agentsDir, "kimi.json"), "kimi");
    await new Promise((r) => setTimeout(r, 120));
    expect(resolver.resolve("kimi")).toBeNull();
  });
});
