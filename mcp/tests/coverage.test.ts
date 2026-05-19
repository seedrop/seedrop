import { describe, expect, it } from "vitest";
import { CLI_COMMAND_SURFACE, MCP_CLI_COVERAGE, MCP_ONLY_COMMANDS } from "../src/coverage.js";
import { tools } from "../src/index.js";

describe("MCP/CLI coverage policy", () => {
  it("declares an explicit coverage status for every known CLI command", () => {
    const policyCommands = new Set(MCP_CLI_COVERAGE.map((entry) => entry.command));
    for (const command of CLI_COMMAND_SURFACE) {
      expect(policyCommands.has(command), `missing coverage policy for ${command}`).toBe(true);
    }
  });

  it("does not keep stale policy entries for removed CLI commands", () => {
    const allowedCommands = new Set<string>([...CLI_COMMAND_SURFACE, ...MCP_ONLY_COMMANDS]);
    for (const entry of MCP_CLI_COVERAGE) {
      expect(allowedCommands.has(entry.command), `stale coverage policy for ${entry.command}`).toBe(true);
    }
  });

  it("keeps policy entries unique and justified", () => {
    const seen = new Set<string>();
    for (const entry of MCP_CLI_COVERAGE) {
      expect(seen.has(entry.command), `duplicate coverage policy for ${entry.command}`).toBe(false);
      seen.add(entry.command);
      expect(["covered", "partial", "cli_only", "todo", "mcp_only"]).toContain(entry.status);
      expect(entry.reason.length, `missing reason for ${entry.command}`).toBeGreaterThan(20);
      if (entry.status === "covered" || entry.status === "partial" || entry.status === "mcp_only") {
        expect(entry.tools?.length, `missing MCP tool mapping for ${entry.command}`).toBeGreaterThan(0);
      }
    }
  });

  it("maps covered/partial/mcp_only policy entries to exposed MCP tools", () => {
    const exposed = new Set(tools.map((tool) => tool.name));
    for (const entry of MCP_CLI_COVERAGE) {
      for (const tool of entry.tools ?? []) {
        expect(exposed.has(tool), `${entry.command} references missing MCP tool ${tool}`).toBe(true);
      }
    }
  });

  it("assigns every exposed MCP tool to at least one policy entry", () => {
    const mappedTools = new Set(MCP_CLI_COVERAGE.flatMap((entry) => entry.tools ?? []));
    for (const tool of tools) {
      expect(mappedTools.has(tool.name), `missing coverage policy entry for MCP tool ${tool.name}`).toBe(true);
    }
  });

  it("maps task commands to the MCP task surface", () => {
    const taskEntries = MCP_CLI_COVERAGE.filter((entry) => entry.command.startsWith("seed task "));
    expect(taskEntries.length).toBeGreaterThan(0);
    for (const entry of taskEntries) {
      expect(entry.status, `${entry.command} should be exposed through MCP`).toBe("covered");
      expect(entry.tools?.[0], `${entry.command} should map to a task tool`).toMatch(/^seedrop_task_/);
    }
  });
});
