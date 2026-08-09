import { randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { SpaceValidationError, SpaceNotFoundError } from "./errors.js";
import { LiveStore, type LiveStoreOptions } from "./live.js";

export type MentionAckResult = "done" | "deferred" | "ignored";

export interface MentionRecord {
  id: string;
  message_id: string;
  space_id: string;
  space_name?: string;
  recipient_passport_id: string;
  sender_passport_id: string;
  sender_principal_chain?: string[];
  content: string;
  created_at: string;
  delivered_at?: string;
  acked_at?: string;
  ack_result?: MentionAckResult;
  ack_note?: string;
  deferred_until?: string;
}

export interface MentionInsertInput {
  messageId: string;
  spaceId: string;
  spaceName?: string;
  recipientPassportId: string;
  senderPassportId: string;
  senderPrincipalChain?: string[];
  content: string;
  createdAt: string;
}

export interface MentionListInput extends LiveStoreOptions {
  recipientPassportId: string;
  unackedOnly?: boolean;
  /** Maximum number of rows to return (default 50). Older rows are returned first when not unacked-only. */
  limit?: number;
  /** Mark fetched rows as delivered_at = now if not already set. Default true. */
  markDelivered?: boolean;
  now?: () => Date;
}

export interface MentionAckInput extends LiveStoreOptions {
  id: string;
  recipientPassportId: string;
  result: MentionAckResult;
  note?: string;
  deferredUntil?: string;
  now?: () => Date;
}

interface MentionRow {
  id: string;
  message_id: string;
  space_id: string;
  space_name: string | null;
  recipient_passport_id: string;
  sender_passport_id: string;
  sender_principal_chain: string | null;
  content: string;
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  ack_result: string | null;
  ack_note: string | null;
  deferred_until: string | null;
}

const ACK_RESULTS: ReadonlyArray<MentionAckResult> = ["done", "deferred", "ignored"];

export class Mentions {
  static async insertMany(
    inputs: readonly MentionInsertInput[],
    options: LiveStoreOptions = {},
  ): Promise<MentionRecord[]> {
    if (inputs.length === 0) return [];
    const live = LiveStore.open(options);
    try {
      const db = await live.connection();
      return db.transaction(() => Mentions.insertManyInTransaction(db, inputs))();
    } finally {
      live.close();
    }
  }

  static insertManyInTransaction(
    db: DatabaseType,
    inputs: readonly MentionInsertInput[],
  ): MentionRecord[] {
    const stmt = db.prepare(
      `INSERT INTO mentions (
         id, message_id, space_id, space_name, recipient_passport_id,
         sender_passport_id, sender_principal_chain, content, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const existingStmt = db.prepare(
      `SELECT id, message_id, space_id, space_name, recipient_passport_id,
              sender_passport_id, sender_principal_chain, content, created_at,
              delivered_at, acked_at, ack_result, ack_note, deferred_until
         FROM mentions
        WHERE message_id = ? AND recipient_passport_id = ?
     ORDER BY created_at ASC
        LIMIT 1`,
    );
    const inserted: MentionRecord[] = [];
    for (const input of inputs) {
      const existing = existingStmt.get(input.messageId, input.recipientPassportId) as MentionRow | undefined;
      if (existing) {
        inserted.push(rowToRecord(existing));
        continue;
      }
      const id = randomUUID();
      stmt.run(
        id,
        input.messageId,
        input.spaceId,
        input.spaceName ?? null,
        input.recipientPassportId,
        input.senderPassportId,
        input.senderPrincipalChain ? JSON.stringify(input.senderPrincipalChain) : null,
        input.content,
        input.createdAt,
      );
      inserted.push({
        id,
        message_id: input.messageId,
        space_id: input.spaceId,
        space_name: input.spaceName,
        recipient_passport_id: input.recipientPassportId,
        sender_passport_id: input.senderPassportId,
        sender_principal_chain: input.senderPrincipalChain,
        content: input.content,
        created_at: input.createdAt,
      });
    }
    return inserted;
  }

  static async list(input: MentionListInput): Promise<MentionRecord[]> {
    if (!input.recipientPassportId) {
      throw new SpaceValidationError(
        [{ code: "custom", path: ["recipientPassportId"], message: "recipientPassportId is required" }],
        "MentionListInput",
      );
    }
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    const live = LiveStore.open(input);
    try {
      const db = await live.connection();
      const where = ["recipient_passport_id = ?"];
      const params: unknown[] = [input.recipientPassportId];
      if (input.unackedOnly) {
        where.push("acked_at IS NULL");
      }
      const rows = db
        .prepare(
          `SELECT id, message_id, space_id, space_name, recipient_passport_id,
                  sender_passport_id, sender_principal_chain, content, created_at,
                  delivered_at, acked_at, ack_result, ack_note, deferred_until
             FROM mentions
            WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC
            LIMIT ?`,
        )
        .all(...params, limit) as MentionRow[];

      if (input.markDelivered !== false && rows.length > 0) {
        const now = (input.now ?? defaultNow)().toISOString();
        const stmt = db.prepare("UPDATE mentions SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
        const tx = db.transaction(() => {
          for (const row of rows) {
            if (!row.delivered_at) {
              stmt.run(now, row.id);
              row.delivered_at = now;
            }
          }
        });
        tx();
      }

      return rows.map(rowToRecord);
    } finally {
      live.close();
    }
  }

  static async ack(input: MentionAckInput): Promise<MentionRecord> {
    if (!ACK_RESULTS.includes(input.result)) {
      throw new SpaceValidationError(
        [{ code: "custom", path: ["result"], message: `result must be one of ${ACK_RESULTS.join("|")}` }],
        "MentionAckInput",
      );
    }
    const now = (input.now ?? defaultNow)().toISOString();
    const live = LiveStore.open(input);
    try {
      const db = await live.connection();
      const mentionId = resolveMentionId(db, input.id, input.recipientPassportId);
      const row = db
        .prepare(
          `UPDATE mentions
              SET acked_at = COALESCE(acked_at, ?),
                  ack_result = ?,
                  ack_note = COALESCE(?, ack_note),
                  deferred_until = COALESCE(?, deferred_until)
            WHERE id = ? AND recipient_passport_id = ?
        RETURNING id, message_id, space_id, space_name, recipient_passport_id,
                  sender_passport_id, sender_principal_chain, content, created_at,
                  delivered_at, acked_at, ack_result, ack_note, deferred_until`,
        )
        .get(now, input.result, input.note ?? null, input.deferredUntil ?? null, mentionId, input.recipientPassportId) as
        | MentionRow
        | undefined;

      if (!row) {
        throw new SpaceNotFoundError(mentionId);
      }
      return rowToRecord(row);
    } finally {
      live.close();
    }
  }

  static async countUnacked(
    recipientPassportId: string,
    options: LiveStoreOptions = {},
  ): Promise<number> {
    const live = LiveStore.open(options);
    try {
      const db = await live.connection();
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM mentions WHERE recipient_passport_id = ? AND acked_at IS NULL")
        .get(recipientPassportId) as { n: number };
      return row.n;
    } finally {
      live.close();
    }
  }
}

function resolveMentionId(db: DatabaseType, prefixOrFullId: string, recipientPassportId: string): string {
  const trimmed = prefixOrFullId.trim();
  if (trimmed.length === 0) throw new SpaceNotFoundError("(empty)");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.length < 4) {
    throw new SpaceValidationError(
      [{ code: "custom", path: ["id"], message: "mention id prefix too short; need at least 4 characters" }],
      "MentionAckInput",
    );
  }
  const rows = db
    .prepare(
      `SELECT id
         FROM mentions
        WHERE recipient_passport_id = ?
          AND id LIKE ?
     ORDER BY created_at ASC`,
    )
    .all(recipientPassportId, `${trimmed}%`) as Array<{ id: string }>;
  if (rows.length === 0) throw new SpaceNotFoundError(prefixOrFullId);
  if (rows.length > 1) {
    const sample = rows.slice(0, 3).map((row) => row.id.slice(0, 12)).join(", ");
    throw new SpaceValidationError(
      [{ code: "custom", path: ["id"], message: `mention id prefix is ambiguous; matches ${rows.length}: ${sample}` }],
      "MentionAckInput",
    );
  }
  return rows[0]!.id;
}

function rowToRecord(row: MentionRow): MentionRecord {
  const record: MentionRecord = {
    id: row.id,
    message_id: row.message_id,
    space_id: row.space_id,
    recipient_passport_id: row.recipient_passport_id,
    sender_passport_id: row.sender_passport_id,
    content: row.content,
    created_at: row.created_at,
  };
  if (row.space_name) record.space_name = row.space_name;
  if (row.sender_principal_chain) {
    try {
      record.sender_principal_chain = JSON.parse(row.sender_principal_chain) as string[];
    } catch {
      // ignore malformed
    }
  }
  if (row.delivered_at) record.delivered_at = row.delivered_at;
  if (row.acked_at) record.acked_at = row.acked_at;
  if (row.ack_result && ACK_RESULTS.includes(row.ack_result as MentionAckResult)) {
    record.ack_result = row.ack_result as MentionAckResult;
  }
  if (row.ack_note) record.ack_note = row.ack_note;
  if (row.deferred_until) record.deferred_until = row.deferred_until;
  return record;
}

function defaultNow(): Date {
  return new Date();
}
