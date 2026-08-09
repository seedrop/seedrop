import { createHash } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { z } from "zod";
import { SpacePostOutboxError, SpaceRequestConflictError, SpaceValidationError } from "./errors.js";
import { LiveStore, type LiveStoreOptions } from "./live.js";
import { Mentions, type MentionInsertInput, type MentionRecord } from "./mentions.js";
import { MessageSchema, type Message } from "./schema.js";

export type PostOutboxState = "pending" | "processing" | "completed" | "dead_letter";
export type PostOutboxFaultPhase = "before_message" | "after_message" | "before_effects" | "after_effects";

export interface PostOutboxRecord {
  schema_version: "2.0";
  request_id: string;
  space_id: string;
  space_name: string;
  author_passport_id: string;
  command_hash: string;
  message_id: string;
  message: Message;
  recipients: string[];
  unknown_recipients: string[];
  effect_keys: string[];
  state: PostOutboxState;
  attempt_count: number;
  last_error?: string;
  lease_owner_pid?: number;
  lease_until?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface PreparePostOutboxInput extends LiveStoreOptions {
  requestId: string;
  spaceId: string;
  spaceName: string;
  authorPassportId: string;
  command: unknown;
  message: Message;
  recipients: readonly string[];
  unknownRecipients: readonly string[];
  now?: () => Date;
}

export interface DispatchPostOutboxInput extends LiveStoreOptions {
  record: PostOutboxRecord;
  persistMessage: (message: Message, requestId: string) => Promise<{ message: Message; replayed: boolean }>;
  fault?: (phase: PostOutboxFaultPhase, record: PostOutboxRecord) => void;
  now?: () => Date;
  maxAttempts?: number;
  leaseMs?: number;
}

export interface DispatchPostOutboxResult {
  record: PostOutboxRecord;
  message: Message;
  replayed: boolean;
  mentions: MentionRecord[];
}

interface PostOutboxRow {
  schema_version: string;
  request_id: string;
  space_id: string;
  space_name: string;
  author_passport_id: string;
  command_hash: string;
  message_id: string;
  message_json: string;
  recipients_json: string;
  unknown_recipients_json: string;
  effect_keys_json: string;
  state: string;
  attempt_count: number;
  last_error: string | null;
  lease_owner_pid: number | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const StateSchema = z.enum(["pending", "processing", "completed", "dead_letter"]);
const StringArraySchema = z.array(z.string().min(1));
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 30_000;
const OUTBOX_COLUMNS = `schema_version, request_id, space_id, space_name, author_passport_id,
  command_hash, message_id, message_json, recipients_json, unknown_recipients_json,
  effect_keys_json, state, attempt_count, last_error, lease_owner_pid, lease_until,
  created_at, updated_at, completed_at`;

export class PostOutbox {
  static async prepare(input: PreparePostOutboxInput): Promise<{ record: PostOutboxRecord; created: boolean }> {
    const now = (input.now ?? defaultNow)().toISOString();
    const message = MessageSchema.parse(input.message);
    const commandHash = hashCommand(input.command);
    const recipients = unique(input.recipients);
    const unknownRecipients = unique(input.unknownRecipients);
    const effectKeys = recipients.map((recipient) => `mention:${message.id}:${recipient}`);
    const live = LiveStore.open(input);
    try {
      const db = await live.connection();
      return db.transaction(() => {
        const existing = selectRecord(db, input.spaceId, input.authorPassportId, input.requestId);
        if (existing) {
          if (existing.command_hash !== commandHash) {
            throw new SpaceRequestConflictError(input.requestId, existing.message_id);
          }
          return { record: existing, created: false };
        }
        db.prepare(
          `INSERT INTO post_outbox_v2 (
             schema_version, request_id, space_id, space_name, author_passport_id,
             command_hash, message_id, message_json, recipients_json, unknown_recipients_json,
             effect_keys_json, state, attempt_count, created_at, updated_at
           ) VALUES ('2.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        ).run(
          input.requestId,
          input.spaceId,
          input.spaceName,
          input.authorPassportId,
          commandHash,
          message.id,
          JSON.stringify(message),
          JSON.stringify(recipients),
          JSON.stringify(unknownRecipients),
          JSON.stringify(effectKeys),
          now,
          now,
        );
        return {
          record: requiredRecord(db, input.spaceId, input.authorPassportId, input.requestId),
          created: true,
        };
      })();
    } finally {
      live.close();
    }
  }

  static async dispatch(input: DispatchPostOutboxInput): Promise<DispatchPostOutboxResult> {
    const nowFn = input.now ?? defaultNow;
    const claimed = await claimRecord(input.record, input, nowFn);
    if (claimed.state === "completed") {
      return { record: claimed, message: claimed.message, replayed: true, mentions: [] };
    }

    try {
      input.fault?.("before_message", claimed);
      const persisted = await input.persistMessage(claimed.message, claimed.request_id);
      input.fault?.("after_message", claimed);
      const completed = await completeEffects(claimed, input, nowFn);
      return {
        record: completed.record,
        message: persisted.message,
        replayed: persisted.replayed || input.record.state !== "pending" || input.record.attempt_count > 0,
        mentions: completed.mentions,
      };
    } catch (error) {
      const failed = await failRecord(claimed, error, input, nowFn);
      throw new SpacePostOutboxError(
        failed.request_id,
        failed.message_id,
        failed.space_name,
        failed.state === "dead_letter" ? "dead_letter" : "pending",
        failed.attempt_count,
        failed.state !== "dead_letter",
        `Post ${failed.message_id} has unresolved post effects in outbox state ${failed.state}.`,
        { cause: error },
      );
    }
  }

  static async list(input: LiveStoreOptions & { authorPassportId: string; spaceId?: string; state?: PostOutboxState }): Promise<PostOutboxRecord[]> {
    const live = LiveStore.open(input);
    try {
      const db = await live.connection();
      const where = ["author_passport_id = ?"];
      const params: unknown[] = [input.authorPassportId];
      if (input.spaceId) {
        where.push("space_id = ?");
        params.push(input.spaceId);
      }
      if (input.state) {
        where.push("state = ?");
        params.push(input.state);
      }
      const rows = db.prepare(
        `SELECT ${OUTBOX_COLUMNS} FROM post_outbox_v2 WHERE ${where.join(" AND ")} ORDER BY created_at`,
      ).all(...params);
      return (rows as PostOutboxRow[]).map(rowToRecord);
    } finally {
      live.close();
    }
  }

  static async repair(
    input: LiveStoreOptions & { authorPassportId: string; spaceId: string; requestId: string; now?: () => Date },
  ): Promise<PostOutboxRecord> {
    const now = (input.now ?? defaultNow)().toISOString();
    const live = LiveStore.open(input);
    try {
      const db = await live.connection();
      return db.transaction(() => {
        const current = selectRecord(db, input.spaceId, input.authorPassportId, input.requestId);
        if (!current) {
          throw new SpaceValidationError(
            [{ code: "custom", path: ["requestId"], message: "outbox command not found for this author" }],
            "PostOutbox.repair",
          );
        }
        if (
          current.state === "processing"
          && current.lease_until
          && Date.parse(current.lease_until) > Date.parse(now)
          && current.lease_owner_pid
          && pidIsAlive(current.lease_owner_pid)
        ) {
          throw outboxStateError(current, true);
        }
        if (current.state === "completed") return current;
        db.prepare(
          `UPDATE post_outbox_v2
              SET state = 'pending', attempt_count = 0, last_error = NULL,
                  lease_owner_pid = NULL, lease_until = NULL, updated_at = ?
            WHERE space_id = ? AND author_passport_id = ? AND request_id = ?`,
        ).run(now, input.spaceId, input.authorPassportId, input.requestId);
        return requiredRecord(db, input.spaceId, input.authorPassportId, input.requestId);
      })();
    } finally {
      live.close();
    }
  }
}

async function claimRecord(
  record: PostOutboxRecord,
  options: LiveStoreOptions & { maxAttempts?: number; leaseMs?: number },
  nowFn: () => Date,
): Promise<PostOutboxRecord> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = nowFn();
  const live = LiveStore.open(options);
  let outcome: { record: PostOutboxRecord; blocked?: "busy" | "dead" };
  try {
    const db = await live.connection();
    outcome = db.transaction(() => {
      const current = requiredRecord(db, record.space_id, record.author_passport_id, record.request_id);
      if (current.state === "completed") return { record: current };
      if (current.state === "dead_letter") return { record: current, blocked: "dead" as const };
      if (
        current.state === "processing"
        && current.lease_until
        && Date.parse(current.lease_until) > now.getTime()
        && current.lease_owner_pid
        && pidIsAlive(current.lease_owner_pid)
      ) {
        return { record: current, blocked: "busy" as const };
      }
      const attemptCount = current.attempt_count + 1;
      db.prepare(
        `UPDATE post_outbox_v2
            SET state = 'processing', attempt_count = ?, last_error = NULL,
                lease_owner_pid = ?, lease_until = ?, updated_at = ?
          WHERE space_id = ? AND author_passport_id = ? AND request_id = ?`,
      ).run(
        attemptCount,
        process.pid,
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        current.space_id,
        current.author_passport_id,
        current.request_id,
      );
      if (attemptCount > maxAttempts) {
        db.prepare(
          `UPDATE post_outbox_v2
              SET state = 'dead_letter', lease_owner_pid = NULL, lease_until = NULL,
                  last_error = 'retry budget exhausted', updated_at = ?
            WHERE space_id = ? AND author_passport_id = ? AND request_id = ?`,
        ).run(now.toISOString(), current.space_id, current.author_passport_id, current.request_id);
        return {
          record: requiredRecord(db, current.space_id, current.author_passport_id, current.request_id),
          blocked: "dead" as const,
        };
      }
      return { record: requiredRecord(db, current.space_id, current.author_passport_id, current.request_id) };
    })();
  } finally {
    live.close();
  }
  if (outcome.blocked) throw outboxStateError(outcome.record, outcome.blocked === "busy");
  return outcome.record;
}

async function completeEffects(
  record: PostOutboxRecord,
  options: DispatchPostOutboxInput,
  nowFn: () => Date,
): Promise<{ record: PostOutboxRecord; mentions: MentionRecord[] }> {
  const now = nowFn().toISOString();
  const live = LiveStore.open(options);
  try {
    const db = await live.connection();
    return db.transaction(() => {
      options.fault?.("before_effects", record);
      const mentions = Mentions.insertManyInTransaction(db, mentionInputs(record));
      options.fault?.("after_effects", record);
      db.prepare(
        `UPDATE post_outbox_v2
            SET state = 'completed', last_error = NULL, lease_owner_pid = NULL,
                lease_until = NULL, updated_at = ?, completed_at = ?
          WHERE space_id = ? AND author_passport_id = ? AND request_id = ?`,
      ).run(now, now, record.space_id, record.author_passport_id, record.request_id);
      return {
        record: requiredRecord(db, record.space_id, record.author_passport_id, record.request_id),
        mentions,
      };
    })();
  } finally {
    live.close();
  }
}

async function failRecord(
  record: PostOutboxRecord,
  error: unknown,
  options: LiveStoreOptions & { maxAttempts?: number },
  nowFn: () => Date,
): Promise<PostOutboxRecord> {
  const now = nowFn().toISOString();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const state: PostOutboxState = record.attempt_count >= maxAttempts ? "dead_letter" : "pending";
  const message = error instanceof Error ? error.message : String(error);
  const live = LiveStore.open(options);
  try {
    const db = await live.connection();
    db.prepare(
      `UPDATE post_outbox_v2
          SET state = ?, last_error = ?, lease_owner_pid = NULL, lease_until = NULL, updated_at = ?
        WHERE space_id = ? AND author_passport_id = ? AND request_id = ?`,
    ).run(state, message.slice(0, 2_000), now, record.space_id, record.author_passport_id, record.request_id);
    return requiredRecord(db, record.space_id, record.author_passport_id, record.request_id);
  } finally {
    live.close();
  }
}

function mentionInputs(record: PostOutboxRecord): MentionInsertInput[] {
  return record.recipients.map((recipient) => ({
    messageId: record.message.id,
    spaceId: record.space_id,
    spaceName: record.space_name,
    recipientPassportId: recipient,
    senderPassportId: record.author_passport_id,
    senderPrincipalChain: record.message.principal_chain,
    content: record.message.content,
    createdAt: record.message.created_at,
  }));
}

function selectRecord(
  db: DatabaseType,
  spaceId: string,
  authorPassportId: string,
  requestId: string,
): PostOutboxRecord | undefined {
  const row = db.prepare(
    `SELECT ${OUTBOX_COLUMNS} FROM post_outbox_v2
      WHERE space_id = ? AND author_passport_id = ? AND request_id = ?`,
  ).get(spaceId, authorPassportId, requestId) as PostOutboxRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

function requiredRecord(db: DatabaseType, spaceId: string, authorPassportId: string, requestId: string): PostOutboxRecord {
  const record = selectRecord(db, spaceId, authorPassportId, requestId);
  if (!record) throw new Error(`Post outbox command disappeared: ${requestId}`);
  return record;
}

function rowToRecord(row: PostOutboxRow): PostOutboxRecord {
  try {
    const state = StateSchema.parse(row.state);
    const record: PostOutboxRecord = {
      schema_version: z.literal("2.0").parse(row.schema_version),
      request_id: row.request_id,
      space_id: row.space_id,
      space_name: row.space_name,
      author_passport_id: row.author_passport_id,
      command_hash: row.command_hash,
      message_id: row.message_id,
      message: MessageSchema.parse(JSON.parse(row.message_json)),
      recipients: StringArraySchema.parse(JSON.parse(row.recipients_json)),
      unknown_recipients: StringArraySchema.parse(JSON.parse(row.unknown_recipients_json)),
      effect_keys: StringArraySchema.parse(JSON.parse(row.effect_keys_json)),
      state,
      attempt_count: row.attempt_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (row.last_error) record.last_error = row.last_error;
    if (row.lease_owner_pid) record.lease_owner_pid = row.lease_owner_pid;
    if (row.lease_until) record.lease_until = row.lease_until;
    if (row.completed_at) record.completed_at = row.completed_at;
    return record;
  } catch (error) {
    throw new SpaceValidationError(
      [{ code: "custom", path: ["post_outbox_v2", row.request_id], message: error instanceof Error ? error.message : String(error) }],
      "live.db",
    );
  }
}

function outboxStateError(record: PostOutboxRecord, retryable: boolean): SpacePostOutboxError {
  return new SpacePostOutboxError(
    record.request_id,
    record.message_id,
    record.space_name,
    record.state === "dead_letter" ? "dead_letter" : "processing",
    record.attempt_count,
    retryable,
    `Post outbox command ${record.request_id} is ${record.state}.`,
  );
}

function hashCommand(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function defaultNow(): Date {
  return new Date();
}
