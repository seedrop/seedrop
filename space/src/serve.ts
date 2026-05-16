import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { z } from "zod";
import { createServer, type IdentityResolver, type ResolvedIdentity } from "./http.js";

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
}

export interface ServeOptions extends PassportIdentityResolverOptions {
  root?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  startedAt?: string;
  version?: string;
  buildHash?: string;
}

export interface StartedSpaceServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  identity: PassportIdentity;
  identities: PassportIdentity[];
}

export async function createPassportIdentityResolver(
  options: PassportIdentityResolverOptions,
): Promise<{ identity: PassportIdentity; identities: PassportIdentity[]; resolver: IdentityResolver }> {
  const identities = await readPassportIdentities(options);
  const allowedPassportIds = new Map<string, PassportIdentity>();
  for (const identity of identities) {
    for (const value of [identity.passportId, identity.agentId, identity.name]) {
      if (value) allowedPassportIds.set(value, identity);
    }
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
  const { identity, identities, resolver } = await createPassportIdentityResolver(options);
  const server = createServer({
    root: options.root,
    dataDir: options.dataDir,
    identity: resolver,
    chainResolver: (passportId: string) => resolvePrincipalChain(passportId, identities),
    knownAgentIds: identities.map((id) => id.agentId),
    health: {
      service: "seed-space",
      startedAt: options.startedAt,
      version: options.version,
      buildHash: options.buildHash,
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
  const passportPaths = options.passportPaths ?? (options.passportPath ? [options.passportPath] : []);
  if (passportPaths.length === 0) {
    throw new Error("At least one passport path is required");
  }
  const passportIds = options.passportIds ?? (options.passportId ? [options.passportId] : []);
  return Promise.all(
    passportPaths.map((passportPath, index) =>
      readPassportIdentity({
        passportPath,
        passportId: passportIds[index],
      }),
    ),
  );
}
