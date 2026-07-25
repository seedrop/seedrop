import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_COMMAND_SURFACE, DEPRECATED_CAPABILITY_ALIASES, MCP_CLI_COVERAGE, MCP_ONLY_COMMANDS } from "../src/coverage.js";
import { tools } from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACTIVE_AGENT_SURFACES = [
  "README.md",
  "cli/README.md",
  "mcp/README.md",
  "cli/templates/boot-reflex.md",
  "cli/templates/skills/codex-cli/SKILL.md",
  "cli/templates/skills/claude-code/seedrop.md",
  "mcp/scripts/smoke.mjs",
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function seedropToolTokens(content: string): string[] {
  return [...content.matchAll(/\bseedrop_[a-z0-9]+(?:_[a-z0-9]+)*\b/g)].map((match) => match[0]!);
}

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

  it("keeps deprecated aliases out of active docs, templates, and smoke probes", () => {
    for (const file of ACTIVE_AGENT_SURFACES) {
      const content = readRepoFile(file);
      for (const alias of DEPRECATED_CAPABILITY_ALIASES) {
        expect(
          content.includes(alias.alias),
          `${file} still references removed alias ${alias.alias}; use ${alias.replacement} or move the mention to an explicit historical note.`,
        ).toBe(false);
      }
    }
  });

  it("keeps active docs, templates, and smoke probes on exposed MCP tool names", () => {
    const exposed = new Set(tools.map((tool) => tool.name));
    for (const file of ACTIVE_AGENT_SURFACES) {
      const tokens = new Set(seedropToolTokens(readRepoFile(file)));
      for (const token of tokens) {
        expect(
          exposed.has(token),
          `${file} references ${token}, but that tool is not exposed by MCP. Update the surface or add deprecated replacement guidance to capabilities.`,
        ).toBe(true);
      }
    }
  });

  it("points agent-facing docs at the capabilities catalog instead of static guessing", () => {
    for (const file of ["README.md", "mcp/README.md", "cli/templates/skills/codex-cli/SKILL.md"] as const) {
      const content = readRepoFile(file);
      expect(content, `${file} should mention seed capabilities`).toContain("seed capabilities");
      expect(content, `${file} should mention seedrop_capabilities`).toContain("seedrop_capabilities");
    }
  });
});
