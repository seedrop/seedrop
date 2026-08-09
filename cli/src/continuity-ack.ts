import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { continuityStatePath } from "./continuity-state.js";

const ACK_SCHEMA_VERSION = "2.0" as const;
const PAGE_SCHEMA_VERSION = "2.0" as const;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const MAX_ACKNOWLEDGED_PAGES = 128;

export interface ContinuityPage {
  schema_version: "2.0";
  page_id: string;
  prior_watermark: string | null;
  high_watermark: string;
  observation_digest: string;
  complete: boolean;
  acknowledgeable: boolean;
  blockers: string[];
  ack_token?: string;
  ack_command?: string;
}

interface ContinuityPageToken {
  schema_version: "2.0";
  page_id: string;
  agent_id: string;
  prior_watermark: string | null;
  high_watermark: string;
  observation_digest: string;
  complete: boolean;
  acknowledgeable: boolean;
  presence_session_id: string;
}

export interface ContinuityAcknowledgementState {
  schema_version: "2.0";
  agent_id: string;
  last_seen_at?: string;
  last_page_id?: string;
  ack_count: number;
  acknowledged_pages: Array<{ page_id: string; high_watermark: string }>;
  updated_at: string;
}

export interface ContinuityAcknowledgementResult {
  page_id: string;
  high_watermark: string;
  acknowledged: true;
  idempotent: boolean;
  presence_committed: boolean;
  state: ContinuityAcknowledgementState;
}

export class ContinuityAcknowledgementError extends Error {
  constructor(
    readonly code: "invalid_token" | "incomplete_page" | "wrong_agent" | "watermark_conflict" | "state_invalid" | "lock_timeout",
    message: string,
  ) {
    super(message);
    this.name = "ContinuityAcknowledgementError";
  }
}

export function continuityAcknowledgementStatePath(agentId: string): string {
  const slug = slugAgent(agentId);
  return join(homedir(), ".seedrop", "state", `continuity-${slug}.v2.json`);
}

export async function readContinuityAcknowledgementState(agentId: string): Promise<ContinuityAcknowledgementState | null> {
  const path = continuityAcknowledgementStatePath(agentId);
  try {
    return parseAcknowledgementState(await readFile(path, "utf8"), agentId, path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function readEffectiveContinuityWatermark(agentId: string): Promise<string | undefined> {
  const current = await readContinuityAcknowledgementState(agentId);
  if (current) return current.last_seen_at;
  return readLegacyWatermarkStrict(agentId);
}

export function createContinuityPage(input: {
  agentId: string;
  priorWatermark?: string;
  highWatermark: string;
  complete: boolean;
  acknowledgeable: boolean;
  presenceSessionId?: string;
  blockers: readonly string[];
  observation: unknown;
}): ContinuityPage {
  assertIsoTimestamp(input.highWatermark, "high watermark");
  if (input.priorWatermark) assertIsoTimestamp(input.priorWatermark, "prior watermark");
  const observationDigest = sha256(canonicalJson(input.observation));
  const identity = {
    schema_version: PAGE_SCHEMA_VERSION,
    agent_id: input.agentId,
    prior_watermark: input.priorWatermark ?? null,
    high_watermark: input.highWatermark,
    observation_digest: observationDigest,
    complete: input.complete,
    acknowledgeable: input.acknowledgeable && input.complete,
    presence_session_id: input.presenceSessionId ?? stablePresenceSessionId(input.agentId),
  };
  const pageId = sha256(canonicalJson(identity));
  const token: ContinuityPageToken = { ...identity, page_id: pageId };
  const encoded = Buffer.from(canonicalJson(token), "utf8").toString("base64url");
  const checksum = sha256(encoded);
  const ackToken = `${encoded}.${checksum}`;
  return {
    schema_version: PAGE_SCHEMA_VERSION,
    page_id: pageId,
    prior_watermark: input.priorWatermark ?? null,
    high_watermark: input.highWatermark,
    observation_digest: observationDigest,
    complete: input.complete,
    acknowledgeable: token.acknowledgeable,
    blockers: [...input.blockers],
    ...(token.acknowledgeable
      ? {
        ack_token: ackToken,
        ack_command: `seed continuity ack --token ${ackToken}`,
      }
      : {}),
  };
}

export async function acknowledgeContinuityPage(input: {
  agentId: string;
  token: string;
  commitPresence?: (sessionId: string, observedAt: string) => Promise<void>;
  now?: () => Date;
}): Promise<ContinuityAcknowledgementResult> {
  const page = decodeContinuityPageToken(input.token);
  if (page.agent_id !== input.agentId) {
    throw new ContinuityAcknowledgementError("wrong_agent", `Continuity page ${page.page_id} belongs to ${page.agent_id}, not ${input.agentId}.`);
  }
  if (!page.complete || !page.acknowledgeable) {
    throw new ContinuityAcknowledgementError("incomplete_page", `Continuity page ${page.page_id} is incomplete and cannot advance the watermark.`);
  }

  const release = await acquireLock(`${continuityAcknowledgementStatePath(input.agentId)}.lock`);
  try {
    const existing = await readContinuityAcknowledgementState(input.agentId);
    const priorAck = existing?.acknowledged_pages.find(
      (entry) => entry.page_id === page.page_id && entry.high_watermark === page.high_watermark,
    );
    if (existing && priorAck) {
      return {
        page_id: page.page_id,
        high_watermark: page.high_watermark,
        acknowledged: true,
        idempotent: true,
        presence_committed: false,
        state: existing,
      };
    }

    const currentWatermark = existing?.last_seen_at ?? await readLegacyWatermarkStrict(input.agentId);
    if ((currentWatermark ?? null) !== page.prior_watermark) {
      throw new ContinuityAcknowledgementError(
        "watermark_conflict",
        `Continuity page ${page.page_id} started at ${page.prior_watermark ?? "<first page>"}, but the committed watermark is ${currentWatermark ?? "<first page>"}. Fetch a fresh page before acknowledging.`,
      );
    }

    if (!input.commitPresence) {
      throw new ContinuityAcknowledgementError("state_invalid", "Continuity acknowledgement requires a presence transport.");
    }
    await input.commitPresence(page.presence_session_id, page.high_watermark);

    const acknowledgedPages = [
      ...(existing?.acknowledged_pages ?? []),
      { page_id: page.page_id, high_watermark: page.high_watermark },
    ].slice(-MAX_ACKNOWLEDGED_PAGES);
    const state: ContinuityAcknowledgementState = {
      schema_version: ACK_SCHEMA_VERSION,
      agent_id: input.agentId,
      last_seen_at: page.high_watermark,
      last_page_id: page.page_id,
      ack_count: (existing?.ack_count ?? 0) + 1,
      acknowledged_pages: acknowledgedPages,
      updated_at: (input.now ?? (() => new Date()))().toISOString(),
    };
    await writeStateAtomic(continuityAcknowledgementStatePath(input.agentId), state);
    return {
      page_id: page.page_id,
      high_watermark: page.high_watermark,
      acknowledged: true,
      idempotent: false,
      presence_committed: true,
      state,
    };
  } finally {
    await release();
  }
}

export function stablePresenceSessionId(agentId: string): string {
  const hex = sha256(`seedrop-continuity-presence:${agentId}`).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function decodeContinuityPageToken(token: string): ContinuityPageToken {
  try {
    const [encoded, checksum, extra] = token.split(".");
    if (!encoded || !checksum || extra || sha256(encoded) !== checksum) throw new Error("checksum mismatch");
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      parsed.schema_version !== PAGE_SCHEMA_VERSION ||
      typeof parsed.page_id !== "string" || !isSha256(parsed.page_id) ||
      typeof parsed.agent_id !== "string" || parsed.agent_id.length === 0 ||
      (parsed.prior_watermark !== null && typeof parsed.prior_watermark !== "string") ||
      typeof parsed.high_watermark !== "string" ||
      typeof parsed.observation_digest !== "string" || !isSha256(parsed.observation_digest) ||
      typeof parsed.complete !== "boolean" ||
      typeof parsed.acknowledgeable !== "boolean" ||
      typeof parsed.presence_session_id !== "string" || !isUuid(parsed.presence_session_id)
    ) throw new Error("invalid payload");
    assertIsoTimestamp(parsed.high_watermark, "high watermark");
    if (parsed.prior_watermark) assertIsoTimestamp(parsed.prior_watermark, "prior watermark");
    const { page_id: pageId, ...identity } = parsed;
    if (sha256(canonicalJson(identity)) !== pageId) throw new Error("page identity mismatch");
    return parsed as unknown as ContinuityPageToken;
  } catch (error) {
    if (error instanceof ContinuityAcknowledgementError) throw error;
    throw new ContinuityAcknowledgementError("invalid_token", `Invalid continuity acknowledgement token: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

async function readLegacyWatermarkStrict(agentId: string): Promise<string | undefined> {
  const path = continuityStatePath(agentId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (parsed.schema_version !== "1.0" || (parsed.last_seen_at !== undefined && typeof parsed.last_seen_at !== "string")) {
      throw new Error("unsupported or malformed legacy state");
    }
    if (parsed.last_seen_at) assertIsoTimestamp(parsed.last_seen_at, "legacy watermark");
    return parsed.last_seen_at as string | undefined;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw new ContinuityAcknowledgementError("state_invalid", `Cannot trust legacy continuity state at ${path}: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function parseAcknowledgementState(raw: string, agentId: string, path: string): ContinuityAcknowledgementState {
  try {
    const parsed = JSON.parse(raw) as Partial<ContinuityAcknowledgementState>;
    if (
      parsed.schema_version !== ACK_SCHEMA_VERSION ||
      parsed.agent_id !== agentId || agentId.length === 0 ||
      typeof parsed.ack_count !== "number" ||
      !Number.isSafeInteger(parsed.ack_count) ||
      parsed.ack_count < 0 ||
      !Array.isArray(parsed.acknowledged_pages) ||
      typeof parsed.updated_at !== "string" ||
      (parsed.last_seen_at !== undefined && typeof parsed.last_seen_at !== "string") ||
      (parsed.last_page_id !== undefined && (typeof parsed.last_page_id !== "string" || !isSha256(parsed.last_page_id))) ||
      parsed.acknowledged_pages.some((entry) => !entry || typeof entry.page_id !== "string" || !isSha256(entry.page_id) || typeof entry.high_watermark !== "string")
    ) throw new Error("unsupported or malformed acknowledgement state");
    if (parsed.ack_count < parsed.acknowledged_pages.length) throw new Error("ack count is smaller than retained page history");
    if (parsed.ack_count === 0 && (parsed.acknowledged_pages.length > 0 || parsed.last_seen_at || parsed.last_page_id)) {
      throw new Error("empty acknowledgement state has committed page fields");
    }
    if (parsed.ack_count > 0) {
      const last = parsed.acknowledged_pages.at(-1);
      if (!last || last.page_id !== parsed.last_page_id || last.high_watermark !== parsed.last_seen_at) {
        throw new Error("last committed page does not match retained history");
      }
    }
    const uniquePages = new Set(parsed.acknowledged_pages.map((entry) => `${entry.page_id}:${entry.high_watermark}`));
    if (uniquePages.size !== parsed.acknowledged_pages.length) throw new Error("duplicate acknowledged page history");
    if (parsed.last_seen_at) assertIsoTimestamp(parsed.last_seen_at, "committed watermark");
    assertIsoTimestamp(parsed.updated_at, "state update time");
    for (const entry of parsed.acknowledged_pages) assertIsoTimestamp(entry.high_watermark, "acknowledged high watermark");
    return parsed as ContinuityAcknowledgementState;
  } catch (error) {
    throw new ContinuityAcknowledgementError("state_invalid", `Cannot trust continuity acknowledgement state at ${path}: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

async function writeStateAtomic(path: string, state: ContinuityAcknowledgementState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
  try {
    await rename(temp, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const ownerToken = randomUUID();
      handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: ownerToken, created_at: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
      const heldLock = handle;
      return async () => {
        try {
          await heldLock.close();
        } finally {
          await releaseOwnedLock(path, ownerToken);
        }
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await rm(path, { force: true });
        throw error;
      }
      if (!isCode(error, "EEXIST")) throw error;
      if (await reapStaleLock(path)) continue;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new ContinuityAcknowledgementError("lock_timeout", `Timed out waiting for continuity acknowledgement lock ${path}.`);
}

async function reapStaleLock(path: string): Promise<boolean> {
  const reaperPath = `${path}.reap`;
  let reaper: Awaited<ReturnType<typeof open>>;
  try {
    reaper = await open(reaperPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await reaper.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
    await reaper.sync();
    if (!(await lockIsStale(path))) return false;
    await rm(path, { force: true });
    return true;
  } finally {
    await reaper.close().catch(() => {});
    await rm(reaperPath, { force: true }).catch(() => {});
  }
}

async function lockIsStale(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: number; created_at?: string };
    const age = parsed.created_at ? Date.now() - Date.parse(parsed.created_at) : Number.POSITIVE_INFINITY;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return age > LOCK_STALE_MS;
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch (error) {
      return isCode(error, "ESRCH") || age > LOCK_STALE_MS;
    }
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    return false;
  }
}

async function releaseOwnedLock(path: string, ownerToken: string): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { token?: string };
    if (parsed.token === ownerToken) await rm(path, { force: true });
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!isIsoTimestamp(value)) throw new ContinuityAcknowledgementError("invalid_token", `Invalid ${label}: ${value}`);
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function slugAgent(agentId: string): string {
  return agentId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || agentId;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
