import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { SpaceAuthError, SpaceError, SpaceMentionDeliveryError, SpaceNotFoundError, SpaceParseError, SpaceValidationError } from "./errors.js";
import { Mentions } from "./mentions.js";
import { extractMentions } from "./mention-parser.js";
import { Notification } from "./notification.js";
import { Presence } from "./presence.js";
import { Space } from "./space.js";

const SPACE_VERSION = "0.1.0-alpha.2";

export interface ResolvedIdentity {
  passportId: string;
  agentId?: string;
  name?: string;
  issuedBy?: string;
  autonomous?: boolean;
}

export interface IdentityResolver {
  resolve(passportId: string): ResolvedIdentity | null | Promise<ResolvedIdentity | null>;
}

export interface CreateServerOptions {
  root?: string;
  dataDir?: string;
  now?: () => Date;
  ttlMs?: number;
  identity?: IdentityResolver;
  /** Lookup an identity's parent issued_by → ResolvedIdentity. Used to walk principal chains. */
  chainResolver?: (passportId: string) => string[];
  /** List of known agent_ids on this daemon (used to filter @-mentions). */
  knownAgentIds?: readonly string[];
  health?: HealthMetadata;
}

export interface HealthPassportMetadata {
  passportId: string;
  agentId: string;
  path?: string;
}

export interface HealthMetadata {
  service?: string;
  startedAt?: string;
  version?: string;
  buildHash?: string;
  host?: string;
  port?: number;
  registeredPassports?: readonly HealthPassportMetadata[];
  knownAgentIds?: readonly string[];
}

const PASSPORT_HEADER = "x-seedrop-passport";

const SessionBody = z
  .object({
    spaceId: z.string().min(1).optional(),
    workingOn: z.string().min(1).optional(),
  })
  .strict();

const HeartbeatBody = z
  .object({
    sessionId: z.string().min(1),
    workingOn: z.string().min(1).optional(),
  })
  .strict();

const PostMessageBody = z
  .object({
    content: z.string().min(1),
    role: z.enum(["agent", "human", "system"]).optional(),
    replaces: z.string().min(1).optional(),
    tombstone: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const SendNotificationBody = z
  .object({
    recipientPassportId: z.string().min(1),
    pointer: z.object({ kind: z.string().min(1), ref: z.string().min(1) }).strict(),
    ttlMs: z.number().int().positive().optional(),
  })
  .strict();

export function createServer(options: CreateServerOptions = {}): Server {
  const startedAt = options.health?.startedAt ?? new Date().toISOString();
  const normalizedOptions: CreateServerOptions = {
    ...options,
    health: {
      service: options.health?.service ?? "seed-space",
      startedAt,
      version: options.health?.version ?? SPACE_VERSION,
      buildHash: options.health?.buildHash ?? "unknown",
      host: options.health?.host ?? "127.0.0.1",
      port: options.health?.port ?? 18791,
      registeredPassports: options.health?.registeredPassports ?? [],
      knownAgentIds: options.health?.knownAgentIds ?? options.knownAgentIds ?? [],
    },
  };
  return createNodeServer(async (req, res) => {
    try {
      await route(req, res, normalizedOptions);
    } catch (error) {
      writeError(res, error);
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, options: CreateServerOptions): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  const segments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);

  if (method === "GET" && match(segments, ["health"])) {
    return handleHealth(res, options);
  }
  if (method === "POST" && match(segments, ["sessions"])) {
    return handleSessions(req, res, url, options);
  }
  if (method === "POST" && match(segments, ["presence", "heartbeat"])) {
    return handleHeartbeat(req, res, options);
  }
  if (method === "GET" && match(segments, ["presence"])) {
    return handlePresenceList(res, url, options);
  }
  if (method === "POST" && match(segments, ["spaces", "*", "join"])) {
    return handleSpaceJoin(req, res, decodeURIComponent(segments[1] as string), options);
  }
  if (method === "GET" && match(segments, ["spaces", "*", "messages"])) {
    return handleMessagesList(req, res, decodeURIComponent(segments[1] as string), options);
  }
  if (method === "POST" && match(segments, ["spaces", "*", "messages"])) {
    return handleMessagesPost(req, res, decodeURIComponent(segments[1] as string), options);
  }
  if (method === "POST" && match(segments, ["spaces", "*", "end"])) {
    return handleSpaceEnd(req, res, decodeURIComponent(segments[1] as string), options);
  }
  if (method === "GET" && match(segments, ["notifications"])) {
    return handleNotificationsList(req, res, options);
  }
  if (method === "POST" && match(segments, ["notifications"])) {
    return handleNotificationSend(req, res, options);
  }
  if (method === "POST" && match(segments, ["notifications", "*", "ack"])) {
    return handleNotificationAck(req, res, decodeURIComponent(segments[1] as string), options);
  }
  if (method === "GET" && match(segments, ["inbox", "*"])) {
    return handleInboxList(req, res, url, decodeURIComponent(segments[1] as string), options);
  }
  if (method === "POST" && match(segments, ["inbox", "*", "*", "ack"])) {
    return handleInboxAck(
      req,
      res,
      decodeURIComponent(segments[1] as string),
      decodeURIComponent(segments[2] as string),
      options,
    );
  }

  writeJson(res, 404, errorEnvelope({
    code: "seedrop.http.not_found",
    message: `Route not found: ${url.pathname}`,
    class: "not_found",
    details: { path: url.pathname },
  }));
}

async function handleHealth(res: ServerResponse, options: CreateServerOptions): Promise<void> {
  const health = options.health;
  const startedAt = health?.startedAt ?? new Date().toISOString();
  const uptimeMs = Math.max(0, Date.now() - Date.parse(startedAt));
  writeJson(res, 200, {
    schema_version: "1.0",
    service: health?.service ?? "seed-space",
    ok: true,
    version: health?.version ?? SPACE_VERSION,
    build_hash: health?.buildHash ?? "unknown",
    started_at: startedAt,
    uptime_ms: uptimeMs,
    root: options.root,
    host: health?.host ?? "127.0.0.1",
    port: health?.port ?? 18791,
    registered_passports: (health?.registeredPassports ?? []).map((passport) => ({
      passport_id: passport.passportId,
      agent_id: passport.agentId,
      path: passport.path,
    })),
    known_agent_ids: [...(health?.knownAgentIds ?? options.knownAgentIds ?? [])],
  });
}

async function handleSessions(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  const body = SessionBody.parse(await readBody(req));
  const session = await Presence.register({
    ...options,
    passportId,
    spaceId: body.spaceId,
    workingOn: body.workingOn,
  });
  writeJson(res, 201, { session });
  void url;
}

async function handleHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateServerOptions,
): Promise<void> {
  const body = HeartbeatBody.parse(await readBody(req));
  const session = await Presence.heartbeat({ ...options, sessionId: body.sessionId, workingOn: body.workingOn });
  writeJson(res, 200, { session });
}

async function handlePresenceList(res: ServerResponse, url: URL, options: CreateServerOptions): Promise<void> {
  const spaceId = url.searchParams.get("spaceId") ?? undefined;
  const passportId = url.searchParams.get("passportId") ?? undefined;
  const ttlMsParam = url.searchParams.get("ttlMs");
  const ttlMs = ttlMsParam ? Number(ttlMsParam) : undefined;
  if (ttlMs !== undefined && !Number.isFinite(ttlMs)) {
    throw new SpaceValidationError([{ code: "custom", path: ["ttlMs"], message: "must be a finite number" }], "query");
  }
  const presence = await Presence.list({ ...options, spaceId, passportId, ttlMs });
  writeJson(res, 200, { presence });
}

async function handleSpaceJoin(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  const space = await Space.join(name, { ...options, passportId });
  writeJson(res, 200, { space: space.meta });
}

async function handleMessagesList(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  const space = await Space.load(name, { ...options, passportId });
  const messages = await space.messages();
  writeJson(res, 200, { messages });
}

async function handleMessagesPost(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  const body = PostMessageBody.parse(await readBody(req));
  const space = await Space.load(name, { ...options, passportId });
  const resolved = options.identity ? await options.identity.resolve(passportId) : null;
  const principalChain = options.chainResolver?.(passportId);
  const message = await space.post({
    content: body.content,
    role: body.role,
    replaces: body.replaces,
    tombstone: body.tombstone,
    metadata: body.metadata,
    principalChain,
    authorAutonomous: resolved?.autonomous,
  });

  // Parse @-mentions and persist inbox rows for known recipients.
  // Self-mentions are allowed (scratchpad pattern); unknown agent_ids are reported as warnings.
  const mentions = extractMentions(body.content);
  let unknown_mentions: string[] = [];
  let delivered_mentions: string[] = [];
  if (mentions.length > 0 && options.knownAgentIds && options.knownAgentIds.length > 0) {
    const known = new Set(options.knownAgentIds.map((id) => id.toLowerCase()));
    const recipients = mentions.filter((id) => known.has(id));
    unknown_mentions = mentions.filter((id) => !known.has(id));
    if (recipients.length > 0) {
      try {
        await Mentions.insertMany(
          recipients.map((recipient) => ({
            messageId: message.id,
            spaceId: space.meta.id,
            spaceName: space.meta.name,
            recipientPassportId: recipient,
            senderPassportId: passportId,
            senderPrincipalChain: principalChain,
            content: body.content,
            createdAt: message.created_at,
          })),
          options,
        );
        delivered_mentions = recipients;
      } catch (error) {
        throw new SpaceMentionDeliveryError(message.id, recipients, { cause: error });
      }
    }
  } else if (mentions.length > 0) {
    unknown_mentions = mentions;
  }

  writeJson(res, 201, {
    message,
    mention_delivery: {
      delivered: delivered_mentions,
      unknown: unknown_mentions,
    },
  });
}

async function handleSpaceEnd(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  const space = await Space.load(name, { ...options, passportId });
  await space.end();
  writeJson(res, 200, { space: space.meta });
}

async function handleNotificationsList(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  const notifications = await Notification.list({ ...options, recipientPassportId: passportId });
  writeJson(res, 200, { notifications });
}

async function handleNotificationSend(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateServerOptions,
): Promise<void> {
  const senderPassportId = await requirePassport(req, options);
  const body = SendNotificationBody.parse(await readBody(req));
  const notification = await Notification.send({
    ...options,
    senderPassportId,
    recipientPassportId: body.recipientPassportId,
    pointer: body.pointer,
    ttlMs: body.ttlMs,
  });
  writeJson(res, 201, { notification });
}

async function handleNotificationAck(
  req: IncomingMessage,
  res: ServerResponse,
  notificationId: string,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  const notification = await Notification.ack({ ...options, recipientPassportId: passportId, notificationId });
  writeJson(res, 200, { notification });
}

const InboxAckBody = z
  .object({
    result: z.enum(["done", "deferred", "ignored"]),
    note: z.string().min(1).optional(),
    deferred_until: z.string().min(1).optional(),
  })
  .strict();

async function handleInboxList(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  recipientFromPath: string,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  if (passportId !== recipientFromPath) {
    throw new SpaceAuthError(`Inbox can only be read by its owner; passport=${passportId}, path=${recipientFromPath}`, 403);
  }
  const unackedOnly = url.searchParams.get("unacked_only") === "true";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(Number(limitParam) || 50, 500)) : undefined;
  const mentions = await Mentions.list({
    ...options,
    recipientPassportId: passportId,
    unackedOnly,
    limit,
  });
  writeJson(res, 200, { mentions });
}

async function handleInboxAck(
  req: IncomingMessage,
  res: ServerResponse,
  recipientFromPath: string,
  itemId: string,
  options: CreateServerOptions,
): Promise<void> {
  const passportId = await requirePassport(req, options);
  if (passportId !== recipientFromPath) {
    throw new SpaceAuthError(`Only the recipient may ack; passport=${passportId}, path=${recipientFromPath}`, 403);
  }
  const body = InboxAckBody.parse(await readBody(req));
  const mention = await Mentions.ack({
    ...options,
    id: itemId,
    recipientPassportId: passportId,
    result: body.result,
    note: body.note,
    deferredUntil: body.deferred_until,
  });
  writeJson(res, 200, { mention });
}

async function requirePassport(req: IncomingMessage, options: CreateServerOptions): Promise<string> {
  const raw = req.headers[PASSPORT_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) {
    throw new SpaceValidationError(
      [{ code: "custom", path: [PASSPORT_HEADER], message: "X-Seedrop-Passport header is required" }],
      "request",
    );
  }
  if (options.identity) {
    const resolved = await options.identity.resolve(value);
    if (!resolved) {
      throw new SpaceAuthError(`Passport is not authorized: ${value}`, 401);
    }
    if (resolved.passportId !== value) {
      throw new SpaceAuthError(`Resolved identity does not match passport header: ${value}`, 403);
    }
  }
  // Auto-refresh: any authenticated request bumps existing sessions for this
  // passport. No-op if the passport hasn't registered. This keeps active
  // agents "online" without requiring an explicit heartbeat loop.
  void Presence.refreshByPassport({ ...options, passportId: value }).catch(() => {
    // Best-effort; never block the request on refresh failures.
  });
  return value;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SpaceValidationError(
      [
        {
          code: "custom",
          path: ["body"],
          message: `request body is not valid JSON: ${(error as Error).message}`,
        },
      ],
      "request",
    );
  }
}

function match(segments: string[], pattern: string[]): boolean {
  if (segments.length !== pattern.length) {
    return false;
  }
  return pattern.every((p, i) => p === "*" || p === segments[i]);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof z.ZodError) {
    writeJson(res, 400, errorEnvelope({
      code: "seedrop.validation.failed",
      message: "Request validation failed",
      class: "validation",
      details: { issues: error.issues },
    }));
    return;
  }
  if (error instanceof SpaceValidationError) {
    writeJson(res, 400, errorEnvelope({
      code: "seedrop.validation.failed",
      message: error.message,
      class: "validation",
      details: { issues: error.issues, path: error.path },
    }));
    return;
  }
  if (error instanceof SpaceAuthError) {
    writeJson(res, error.statusCode, errorEnvelope({
      code: error.statusCode === 401 ? "seedrop.auth.unauthorized" : "seedrop.auth.forbidden",
      message: error.message,
      class: "auth",
    }));
    return;
  }
  if (error instanceof SpaceNotFoundError) {
    writeJson(res, 404, errorEnvelope({
      code: "seedrop.space.not_found",
      message: error.message,
      class: "not_found",
      details: { id_or_name: error.idOrName },
    }));
    return;
  }
  if (error instanceof SpaceParseError) {
    writeJson(res, 500, errorEnvelope({
      code: "seedrop.space.parse_failed",
      message: error.message,
      class: "io",
      details: { path: error.path },
    }));
    return;
  }
  if (error instanceof SpaceMentionDeliveryError) {
    writeJson(res, 500, errorEnvelope({
      code: "seedrop.space.mention_delivery_failed",
      message: error.message,
      class: "io",
      retryable: true,
      details: { message_id: error.messageId, recipients: error.recipients },
    }));
    return;
  }
  if (error instanceof SpaceError) {
    writeJson(res, 500, errorEnvelope({
      code: "seedrop.space.failed",
      message: error.message,
      class: "internal",
    }));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, 500, errorEnvelope({
    code: "seedrop.internal",
    message,
    class: "internal",
  }));
}

type ErrorClass = "config" | "validation" | "auth" | "not_found" | "conflict" | "io" | "internal";

function errorEnvelope(input: {
  code: string;
  message: string;
  class: ErrorClass;
  retryable?: boolean;
  next_command?: string;
  details?: Record<string, unknown>;
}): { error: { code: string; message: string; class: ErrorClass; retryable: boolean; next_command?: string; details: Record<string, unknown> } } {
  return {
    error: {
      code: input.code,
      message: input.message,
      class: input.class,
      retryable: input.retryable ?? false,
      next_command: input.next_command,
      details: input.details ?? {},
    },
  };
}
