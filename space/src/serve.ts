import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { z } from "zod";
import { createServer, type CreateServerOptions, type IdentityResolver, type ResolvedIdentity } from "./http.js";

const PassportIdentitySchema = z
  .object({
    agent_id: z.string().min(1),
    name: z.string().min(1).optional(),
    issued_by: z.string().min(1).optional(),
    autonomous: z.boolean().optional(),
  })
  .passthrough();

export interface PassportIdentity {
  passportId: string;
  agentId: string;
  name?: string;
  issuedBy?: string;
  autonomous?: boolean;
  path?: string;
}

export interface PassportIdentityResolverOptions {
  passportPath?: string;
  passportPaths?: readonly string[];
  passportId?: string;
  passportIds?: readonly string[];
  /**
   * Directories containing per-agent passport JSON files (typically
   * `~/.seedrop/id/agents/`). Every `*.json` is loaded as a passport in
   * addition to those passed via passportPath(s). Drops the launchctl
   * plist's hardcoded passport list as a maintenance burden.
   */
  agentsDirs?: readonly string[];
  /**
   * When true (default false), the resolver watches each agentsDir for new
   * passport files and admits them without a daemon restart. Existing
   * snapshot fields (health.registeredPassports, chainResolver) stay frozen
   * to the startup set; auth and DM delivery for new agents work immediately.
   */
  watchAgentsDirs?: boolean;
  /**
   * Safety-net poll interval (ms) for agentsDirs when watching. Defaults to
   * 2000. fs.watch drops events outright on some platforms, so this bounds how
   * long a new passport can stay unadmitted.
   */
  agentsDirsPollMs?: number;
}

export interface ServeOptions extends PassportIdentityResolverOptions {
  root?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  startedAt?: string;
  version?: string;
  buildHash?: string;
  runtimeProfile?: string;
  runtimeRoot?: string;
  runtimeSourceHash?: string;
  postOutboxFault?: CreateServerOptions["postOutboxFault"];
  postOutboxMaxAttempts?: number;
}

export interface StartedSpaceServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  identity: PassportIdentity;
  identities: PassportIdentity[];
}

export interface PassportIdentityResolverResult {
  identity: PassportIdentity;
  identities: PassportIdentity[];
  resolver: IdentityResolver;
  /** Re-read passports from agentsDirs and admit any new ones. No-op if no dirs configured. */
  refresh: () => Promise<PassportIdentity[]>;
  /** Stop fs.watch handles started by watchAgentsDirs. Called on server close. */
  stopWatching: () => void;
}

export async function createPassportIdentityResolver(
  options: PassportIdentityResolverOptions,
): Promise<PassportIdentityResolverResult> {
  const allowedPassportIds = new Map<string, PassportIdentity>();
  let identities: PassportIdentity[] = [];

  function indexIdentities(next: PassportIdentity[]): void {
    allowedPassportIds.clear();
    for (const identity of next) {
      for (const value of [identity.passportId, identity.agentId, identity.name]) {
        if (value) allowedPassportIds.set(value, identity);
      }
    }
    identities = next;
  }

  identities = await readPassportIdentities(options);
  indexIdentities(identities);

  const watchers: FSWatcher[] = [];
  let refreshTimer: NodeJS.Timeout | null = null;
  let refreshInFlight = false;
  let refreshQueued = false;
  let pollTimer: NodeJS.Timeout | null = null;

  async function refresh(): Promise<PassportIdentity[]> {
    if (refreshInFlight) {
      // Coalesce rather than drop. A passport written *during* an in-flight
      // read may land after the directory listing and be missed by that pass;
      // returning early here used to discard the follow-up request with nothing
      // left to reschedule it, so the new agent stayed invisible until the next
      // unrelated event. Small window, but it is why the watcher test flaked
      // only under parallel load.
      refreshQueued = true;
      return identities;
    }
    refreshInFlight = true;
    try {
      let next = await readPassportIdentities(options);
      indexIdentities(next);
      while (refreshQueued) {
        refreshQueued = false;
        next = await readPassportIdentities(options);
        indexIdentities(next);
      }
      return next;
    } finally {
      refreshInFlight = false;
      refreshQueued = false;
    }
  }

  if (options.watchAgentsDirs && options.agentsDirs && options.agentsDirs.length > 0) {
    for (const dir of options.agentsDirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (typeof filename === "string" && !filename.endsWith(".json")) return;
          if (refreshTimer) return;
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void refresh().catch(() => {
              // ignore — refresh errors are non-fatal; next call picks up
            });
          }, 100); // 100ms debounce — passport writes are atomic but multi-step
        });
        watchers.push(watcher);
      } catch {
        // fs.watch can fail on unsupported filesystems; degrade silently
      }
    }

    // Safety net. fs.watch is best-effort, and measured on macOS it is either
    // fast or absent: 19 of 20 trials delivered in ~150ms, and the twentieth
    // never fired at all, even after 5s. A dropped event means a new agent's
    // passport is never admitted and its requests fail auth until the daemon
    // restarts — so the watcher cannot be the only path. Polling a handful of
    // small JSON files on this interval is negligible next to that failure.
    pollTimer = setInterval(() => {
      void refresh().catch(() => {
        // non-fatal; the next tick retries
      });
    }, options.agentsDirsPollMs ?? 2_000);
    // Never hold the process open on this timer's account.
    pollTimer.unref?.();
  }

  return {
    identity: identities[0]!,
    identities,
    resolver: {
      resolve(passportId: string): ResolvedIdentity | null {
        const identity = allowedPassportIds.get(passportId);
        if (!identity) {
          return null;
        }
        return {
          passportId,
          agentId: identity.agentId,
          name: identity.name,
          issuedBy: identity.issuedBy,
          autonomous: identity.autonomous,
        };
      },
    },
    refresh,
    stopWatching: () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
      watchers.length = 0;
    },
  };
}

/**
 * Walk the principal chain from a starting passport upward through issued_by.
 * Returns [author, parent, grandparent, ..., root]. Stops at the first
 * principal that has no issued_by (root) or autonomous=true. Caps depth at 16
 * to bound any accidental cycles.
 */
export function resolvePrincipalChain(
  startPassportId: string,
  identities: readonly PassportIdentity[],
): string[] {
  const byId = new Map<string, PassportIdentity>();
  for (const id of identities) {
    for (const key of [id.passportId, id.agentId, id.name]) {
      if (key) byId.set(key, id);
    }
  }

  const chain: string[] = [];
  let current = byId.get(startPassportId);
  if (!current) return [startPassportId];
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (!current || seen.has(current.agentId)) break;
    seen.add(current.agentId);
    chain.push(current.agentId);
    if (current.autonomous) break;
    if (!current.issuedBy) break;
    current = byId.get(current.issuedBy);
    if (!current) {
      // Parent isn't a known passport on this server; still record the link.
      chain.push(chain.length > 0 ? (byId.get(chain[chain.length - 1]!)?.issuedBy ?? "") : "");
      // Filter trailing empties below.
      break;
    }
  }
  return chain.filter((s) => s.length > 0);
}

export async function startSpaceServer(options: ServeOptions): Promise<StartedSpaceServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18791;
  const { identity, identities, resolver, stopWatching } = await createPassportIdentityResolver(options);
  const server = createServer({
    root: options.root,
    dataDir: options.dataDir,
    identity: resolver,
    chainResolver: (passportId: string) => resolvePrincipalChain(passportId, identities),
    knownAgentIds: identities.map((id) => id.agentId),
    postOutboxFault: options.postOutboxFault,
    postOutboxMaxAttempts: options.postOutboxMaxAttempts,
    health: {
      service: "seed-space",
      startedAt: options.startedAt,
      version: options.version,
      buildHash: options.buildHash,
      runtimeProfile: options.runtimeProfile,
      runtimeRoot: options.runtimeRoot,
      runtimeSourceHash: options.runtimeSourceHash,
      host,
      port,
      registeredPassports: identities.map((identity) => ({
        passportId: identity.passportId,
        agentId: identity.agentId,
        path: identity.path,
      })),
      knownAgentIds: identities.map((id) => id.agentId),
    },
  });
  server.once("close", () => stopWatching());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    identity,
    identities,
  };
}

export async function readPassportIdentity(options: { passportPath: string; passportId?: string }): Promise<PassportIdentity> {
  const raw = await readFile(options.passportPath, "utf8");
  const parsed = PassportIdentitySchema.parse(JSON.parse(raw));
  return {
    passportId: options.passportId ?? parsed.agent_id,
    agentId: parsed.agent_id,
    name: parsed.name,
    issuedBy: parsed.issued_by,
    autonomous: parsed.autonomous,
    path: options.passportPath,
  };
}

async function readPassportIdentities(options: PassportIdentityResolverOptions): Promise<PassportIdentity[]> {
  const explicit = options.passportPaths ?? (options.passportPath ? [options.passportPath] : []);
  const fromDirs = await collectPassportPathsFromDirs(options.agentsDirs ?? []);
  // Combine explicit paths (operator + any --passport flags) with
  // auto-discovered agent passports. Deduplicate by absolute path.
  const seen = new Set<string>();
  const passportPaths: string[] = [];
  for (const p of [...explicit, ...fromDirs]) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    passportPaths.push(p);
  }
  if (passportPaths.length === 0) {
    throw new Error("At least one passport path or agents-dir is required");
  }
  const passportIds = options.passportIds ?? (options.passportId ? [options.passportId] : []);
  const results = await Promise.allSettled(
    passportPaths.map((passportPath, index) =>
      readPassportIdentity({
        passportPath,
        passportId: passportIds[index],
      }),
    ),
  );
  // Skip unreadable / invalid passport files instead of failing the entire
  // resolver — agent passport files can briefly be in inconsistent states
  // during atomic writes from `seed bootstrap --as <agent>`.
  return results
    .filter((r): r is PromiseFulfilledResult<PassportIdentity> => r.status === "fulfilled")
    .map((r) => r.value);
}

async function collectPassportPathsFromDirs(dirs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        out.push(path.join(dir, entry.name));
      }
    } catch {
      // ignore — dir might be unreadable; treat as empty
    }
  }
  return out;
}
