import { describe, expect, it } from "vitest";
import {
  CLI_COMMAND_SURFACE,
  MCP_CLI_COVERAGE,
  buildCapabilities,
  renderCapabilities,
} from "../src/capabilities.js";
import { resolveCommand } from "../src/router.js";

describe("capabilities map", () => {
  it("resolves `seed capabilities` to the in-process command", () => {
    expect(resolveCommand(["capabilities"])).toBe("capabilities");
    expect(resolveCommand(["capabilities", "--json"])).toBe("capabilities");
  });

  it("builds a catalog covering every coverage entry, grouped by domain", () => {
    const catalog = buildCapabilities();
    expect(catalog.total).toBe(MCP_CLI_COVERAGE.length);
    const flat = Object.values(catalog.groups).flat();
    expect(flat).toHaveLength(MCP_CLI_COVERAGE.length);
    // every CLI command in the surface appears somewhere in the catalog
    const commands = new Set(flat.map((entry) => entry.command));
    for (const command of CLI_COMMAND_SURFACE) {
      expect(commands.has(command), `missing ${command} in capability catalog`).toBe(true);
    }
  });

  it("partitions counts cleanly: cli_commands = via_mcp + cli_only, total = cli_commands + mcp_only", () => {
    const catalog = buildCapabilities();
    const flat = Object.values(catalog.groups).flat();
    expect(catalog.mcp_only).toBe(flat.filter((e) => e.status === "mcp_only").length);
    expect(catalog.cli_only).toBe(flat.filter((e) => e.status === "cli_only").length);
    expect(catalog.via_mcp).toBe(flat.filter((e) => e.status === "covered" || e.status === "partial").length);
    // every CLI command is either also-via-mcp or cli-only — no overlap, no gap
    expect(catalog.cli_commands).toBe(catalog.via_mcp + catalog.cli_only);
    expect(catalog.total).toBe(catalog.cli_commands + catalog.mcp_only);
  });

  it("exposes seed capabilities itself through seedrop_capabilities", () => {
    const entry = MCP_CLI_COVERAGE.find((e) => e.command === "seed capabilities");
    expect(entry?.tools).toEqual(["seedrop_capabilities"]);
  });

  it("renders a grouped human view with the command -> tool mapping", () => {
    const out = renderCapabilities();
    expect(out).toContain("Seedrop capabilities");
    expect(out).toContain("VIEW");
    expect(out).toContain("seed view threads");
    expect(out).toContain("-> seedrop_view_threads");
    expect(out).toContain("(CLI only)");
  });
});
