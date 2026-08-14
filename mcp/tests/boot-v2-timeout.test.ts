import { beforeEach, describe, expect, it, vi } from "vitest";

const runSeed = vi.fn();

vi.mock("../src/run.js", () => ({
  runSeed: (...args: unknown[]) => runSeed(...args),
}));

import { tools, V2_SITUATION_BOOT_TIMEOUT_MS } from "../src/index.js";

describe("MCP live Situation boot timeout", () => {
  beforeEach(() => {
    runSeed.mockReset();
    runSeed.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0 });
  });

  it("passes a timeout at least as large as the 15s default when v2 Situation is on", async () => {
    const tool = tools.find((item) => item.name === "seedrop_boot")!;
    await tool.handler({ v2_situation: true, json: true, peek: true });
    expect(runSeed).toHaveBeenCalledTimes(1);
    const opts = runSeed.mock.calls[0]![1] as { timeoutMs?: number };
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(15_000);
    expect(opts.timeoutMs).toBe(V2_SITUATION_BOOT_TIMEOUT_MS);
  });

  it("does not raise the spawn timeout when v2 Situation is off", async () => {
    const tool = tools.find((item) => item.name === "seedrop_boot")!;
    await tool.handler({ json: true, peek: true });
    expect((runSeed.mock.calls[0]![1] as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });
});
