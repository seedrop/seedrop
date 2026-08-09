import { randomUUID } from "node:crypto";
import { SpaceAuthError, SpaceNotFoundError, SpaceValidationError } from "./errors.js";
import { LiveStore, type LiveStoreOptions } from "./live.js";
import type { PresenceRecord, Session } from "./schema.js";

const DEFAULT_TTL_MS = 60_000;

export interface PresenceOptions extends LiveStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

export interface PresenceRegisterInput extends PresenceOptions {
  passportId: string;
  spaceId?: string;
  workingOn?: string;
}

export interface PresenceHeartbeatInput extends PresenceOptions {
  sessionId: string;
  passportId: string;
  workingOn?: string;
}

export interface PresenceListInput extends PresenceOptions {
  spaceId?: string;
  passportId?: string;
}

export interface PresenceEndInput extends PresenceOptions {
  sessionId: string;
}

interface SessionRow {
  id: string;
  passport_id: string;
  space_id: string | null;
  created_at: string;
  last_seen_at: string;
  working_on: string | null;
}

export class Presence {
  static async register(input: PresenceRegisterInput): Promise<Session> {
    if (!input.passportId) {
      throw new SpaceValidationError(
        [{ code: "custom", path: ["passportId"], message: "passportId is required" }],
        "PresenceRegisterInput",
      );
    }

    const now = (input.now ?? defaultNow)().toISOString();
    const id = randomUUID();
    const live = LiveStore.open(input);

    try {
      const db = await live.connection();
      db.prepare(
        `INSERT INTO sessions (id, passport_id, space_id, created_at, last_seen_at, working_on)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.passportId, input.spaceId ?? null, now, now, input.workingOn ?? null);

      return toSession({
        id,
        passport_id: input.passportId,
        space_id: input.spaceId ?? null,
        created_at: now,
        last_seen_at: now,
        working_on: input.workingOn ?? null,
      });
    } finally {
      live.close();
    }
  }

  static async heartbeat(input: PresenceHeartbeatInput): Promise<Session> {
    const now = (input.now ?? defaultNow)().toISOString();
    const live = LiveStore.open(input);

    try {
      const db = await live.connection();
      const existing = db
        .prepare("SELECT passport_id FROM sessions WHERE id = ?")
        .get(input.sessionId) as { passport_id: string } | undefined;
      if (!existing) {
        throw new SpaceNotFoundError(input.sessionId);
      }
      if (existing.passport_id !== input.passportId) {
        throw new SpaceAuthError(
          `Session ${input.sessionId} belongs to another passport.`,
          403,
        );
      }
      const row = db
        .prepare(
          `UPDATE sessions
              SET last_seen_at = ?,
                  working_on = ?
            WHERE id = ?
        RETURNING id, passport_id, space_id, created_at, last_seen_at, working_on`,
        )
        .get(now, input.workingOn ?? null, input.sessionId) as SessionRow | undefined;

      if (!row) {
        throw new SpaceNotFoundError(input.sessionId);
      }

      return toSession(row);
    } finally {
      live.close();
    }
  }

  /**
   * Bump `last_seen_at` on all existing sessions for the given passport.
   * No-op if the passport has no registered session. Used by the HTTP layer
   * to auto-refresh presence on any authenticated activity.
   */
  static async refreshByPassport(input: { passportId: string } & LiveStoreOptions & { now?: () => Date }): Promise<number> {
    const now = (input.now ?? defaultNow)().toISOString();
    const live = LiveStore.open(input);
    try {
      const db = await live.connection();
      const result = db
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE passport_id = ?")
        .run(now, input.passportId);
      return Number(result.changes ?? 0);
    } finally {
      live.close();
    }
  }

  static async list(input: PresenceListInput = {}): Promise<PresenceRecord[]> {
    const now = (input.now ?? defaultNow)().getTime();
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const live = LiveStore.open(input);

    try {
      const db = await live.connection();
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (input.spaceId) {
        clauses.push("space_id = ?");
        params.push(input.spaceId);
      }
      if (input.passportId) {
        clauses.push("passport_id = ?");
        params.push(input.passportId);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(
          `SELECT id, passport_id, space_id, created_at, last_seen_at, working_on
             FROM sessions
             ${where}
         ORDER BY last_seen_at DESC, id ASC`,
        )
        .all(...params) as SessionRow[];

      const records = rows.map((row) => ({
        ...toSession(row),
        online: now - new Date(row.last_seen_at).getTime() <= ttlMs,
      }));

      // Duplicate identity must be obvious (60733578 part 5): two live
      // sessions for one passport look like normal independent presence
      // otherwise. Flag every online record whose passport has >1 online row.
      const onlineCounts = new Map<string, number>();
      for (const record of records) {
        if (record.online) onlineCounts.set(record.passport_id, (onlineCounts.get(record.passport_id) ?? 0) + 1);
      }
      return records.map((record) => {
        const count = onlineCounts.get(record.passport_id) ?? 0;
        return record.online && count > 1 ? { ...record, duplicate_sessions: count } : record;
      });
    } finally {
      live.close();
    }
  }

  static async end(input: PresenceEndInput): Promise<void> {
    const live = LiveStore.open(input);
    try {
      const db = await live.connection();
      const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(input.sessionId);
      if (result.changes === 0) {
        throw new SpaceNotFoundError(input.sessionId);
      }
    } finally {
      live.close();
    }
  }
}

function toSession(row: {
  id: string;
  passport_id: string;
  space_id: string | null;
  created_at: string;
  last_seen_at: string;
  working_on: string | null;
}): Session {
  const session: Session = {
    schema_version: "1.0",
    id: row.id,
    passport_id: row.passport_id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
  if (row.space_id) {
    session.space_id = row.space_id;
  }
  if (row.working_on) {
    session.working_on = row.working_on;
  }
  return session;
}

function defaultNow(): Date {
  return new Date();
}
