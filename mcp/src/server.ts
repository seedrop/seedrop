import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools, type ToolDef } from "./tools.js";

export interface SeedropServerOptions {
  name?: string;
  version?: string;
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
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
      return result as unknown as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `tool ${tool.name} failed: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
