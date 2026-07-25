import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEPRECATED_CAPABILITY_ALIASES } from "./coverage.js";
import { tools, type ToolDef } from "./tools.js";

export interface SeedropServerOptions {
  name?: string;
  version?: string;
}

const SERVER_LOADED_AT_MS = Date.now();
const SERVER_MODULE_PATH = fileURLToPath(import.meta.url);

export interface McpServerStaleness {
  stale: boolean;
  loaded_at: string;
  dist_mtime: string;
  minutes?: number;
}

export function computeStaleness(input: { loadedAtMs: number; distMTimeMs: number }): McpServerStaleness {
  const base = {
    stale: false,
    loaded_at: new Date(input.loadedAtMs).toISOString(),
    dist_mtime: new Date(input.distMTimeMs).toISOString(),
  };
  if (input.distMTimeMs > input.loadedAtMs + 1000) {
    return {
      ...base,
      stale: true,
      minutes: Math.round((input.distMTimeMs - input.loadedAtMs) / 60_000),
    };
  }
  return base;
}

function detectStaleness(): McpServerStaleness {
  try {
    return computeStaleness({ loadedAtMs: SERVER_LOADED_AT_MS, distMTimeMs: statSync(SERVER_MODULE_PATH).mtimeMs });
  } catch {
    return computeStaleness({ loadedAtMs: SERVER_LOADED_AT_MS, distMTimeMs: SERVER_LOADED_AT_MS });
  }
}

export function formatStalenessWarning(staleness: McpServerStaleness, context: "unknown_tool" | "tool_call" | "tool_error"): string {
  const action = context === "unknown_tool"
    ? "reload the current tool definitions"
    : context === "tool_error"
      ? "rule out stale code"
      : "pick up the rebuilt server";
  return [
    `⚠ Seedrop MCP server is stale: loaded_at=${staleness.loaded_at}, dist_mtime=${staleness.dist_mtime}, dist is ~${staleness.minutes ?? 0}m newer.`,
    `Restart the MCP client to ${action} (Codex: restart Codex; Claude Code/Desktop: restart Claude).`,
    "",
    "",
  ].join("\n");
}

function prependStalenessWarning(result: Record<string, unknown>, staleness: McpServerStaleness, context: "unknown_tool" | "tool_call" | "tool_error"): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    ...result,
    content: [{ type: "text", text: formatStalenessWarning(staleness, context) }, ...content],
  };
}

export function unknownToolMessage(name: string): string {
  const deprecated = DEPRECATED_CAPABILITY_ALIASES.find((alias) => alias.alias === name);
  if (deprecated) {
    return `${name} was removed; use ${deprecated.replacement}. ${deprecated.reason}`;
  }
  return `Unknown tool: ${name}. Call seedrop_capabilities to see the current tool catalog.`;
}

export function createServer(opts: SeedropServerOptions = {}): Server {
  const server = new Server(
    {
      name: opts.name ?? "seedrop",
      version: opts.version ?? "0.1.0-alpha.1",
    },
    { capabilities: { tools: {} } },
  );

  const byName = new Map<string, ToolDef>();
  for (const tool of tools) byName.set(tool.name, tool);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<Record<string, unknown>> => {
    const tool = byName.get(request.params.name);
    const staleness = detectStaleness();
    if (!tool) {
      const result: Record<string, unknown> = {
        content: [{ type: "text", text: unknownToolMessage(request.params.name) }],
        isError: true,
      };
      return staleness.stale
        ? prependStalenessWarning(result, staleness, "unknown_tool")
        : result;
    }
    try {
      const result = (await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>)) as unknown as Record<string, unknown>;
      return staleness.stale
        ? prependStalenessWarning(result, staleness, "tool_call")
        : result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: Record<string, unknown> = {
        content: [{ type: "text", text: `tool ${tool.name} failed: ${message}` }],
        isError: true,
      };
      return staleness.stale
        ? prependStalenessWarning(result, staleness, "tool_error")
        : result;
    }
  });

  return server;
}
