import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { collectBenchState, defaultSpaceUrl, type BenchStateOptions } from "./state.js";
import { renderBenchShell } from "./shell.js";

export interface BenchServerOptions {
  passportPath: string;
  spaceUrl?: string | null;
  preferredRoot?: string;
  host?: string;
  port?: number;
  selectedProjectId?: string;
  title?: string;
  now?: BenchStateOptions["now"];
  fetch?: BenchStateOptions["fetch"];
}

export interface StartedBenchServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startBenchServer(options: BenchServerOptions): Promise<StartedBenchServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18792;
  const server = createServer((req, res) => {
    void handleBenchRequest(req, res, options);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${resolvedPort}/`;
  return {
    server,
    host,
    port: resolvedPort,
    url,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleBenchRequest(req: IncomingMessage, res: ServerResponse, options: BenchServerOptions): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method !== "GET") {
    write(res, 405, "text/plain; charset=utf-8", "method not allowed");
    return;
  }
  if (url.pathname === "/health") {
    writeJson(res, 200, { ok: true, service: "seedrop-bench" });
    return;
  }
  if (url.pathname !== "/" && url.pathname !== "/state.json") {
    write(res, 404, "text/plain; charset=utf-8", "not found");
    return;
  }

  try {
    const state = await collectBenchState({
      passportPath: options.passportPath,
      preferredRoot: options.preferredRoot,
      spaceUrl: options.spaceUrl === undefined ? defaultSpaceUrl() : options.spaceUrl,
      now: options.now,
      fetch: options.fetch,
    });
    if (url.pathname === "/state.json") {
      writeJson(res, 200, state);
      return;
    }
    const selectedProjectId = url.searchParams.get("project") ?? options.selectedProjectId;
    write(res, 200, "text/html; charset=utf-8", renderBenchShell(state, {
      selectedProjectId,
      title: options.title,
    }));
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  write(res, status, "application/json; charset=utf-8", `${JSON.stringify(payload, null, 2)}\n`);
}

function write(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}
