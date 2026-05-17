import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools, type ToolDef } from "./tools.js";

export interface SeedropServerOptions {
  name?: string;
  version?: string;
}

const SERVER_LOADED_AT_MS = Date.now();
const SERVER_MODULE_PATH = fileURLToPath(import.meta.url);

export function computeStaleness(input: { loadedAtMs: number; distMTimeMs: number }): { stale: boolean; minutes?: number } {
  if (input.distMTimeMs > input.loadedAtMs + 1000) {
    return { stale: true, minutes: Math.round((input.distMTimeMs - input.loadedAtMs) / 60_000) };
  }
  return { stale: false };
}

function detectStaleness(): { stale: boolean; minutes?: number } {
  try {
    return computeStaleness({ loadedAtMs: SERVER_LOADED_AT_MS, distMTimeMs: statSync(SERVER_MODULE_PATH).mtimeMs });
  } catch {
    return { stale: false };
  }
}

function prependStalenessWarning(result: Record<string, unknown>, warning: string): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    ...result,
    content: [{ type: "text", text: warning }, ...content],
  };
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
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
      return staleness.stale
        ? prependStalenessWarning(result, `⚠ MCP server is ~${staleness.minutes}m older than dist on disk. Restart Claude Code to reload the new tool definitions.\n\n`)
        : result;
    }
    try {
      const result = (await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>)) as unknown as Record<string, unknown>;
      return staleness.stale
        ? prependStalenessWarning(result, `⚠ MCP server is ~${staleness.minutes}m older than dist on disk. Tool call dispatched to the loaded version; restart Claude Code to pick up changes.\n\n`)
        : result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: Record<string, unknown> = {
        content: [{ type: "text", text: `tool ${tool.name} failed: ${message}` }],
        isError: true,
      };
      return staleness.stale
        ? prependStalenessWarning(result, `⚠ MCP server is ~${staleness.minutes}m older than dist on disk. Restart Claude Code if this failure looks like stale code.\n\n`)
        : result;
    }
  });

  return server;
}
