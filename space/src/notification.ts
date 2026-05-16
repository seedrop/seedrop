import { randomUUID } from "node:crypto";
import { SpaceNotFoundError, SpaceParseError, SpaceValidationError } from "./errors.js";
import { SpaceStore, type SpaceStoreOptions } from "./io.js";
import type { Notification as NotificationRecord, NotificationPointer } from "./schema.js";

export interface NotificationOptions extends SpaceStoreOptions {
  now?: () => Date;
}

export interface NotificationSendInput extends NotificationOptions {
  recipientPassportId: string;
  senderPassportId: string;
  pointer: NotificationPointer;
  ttlMs?: number;
}

export interface NotificationListInput extends NotificationOptions {
  recipientPassportId: string;
}

export interface NotificationAckInput extends NotificationOptions {
  recipientPassportId: string;
  notificationId: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class Notification {
  static async send(input: NotificationSendInput): Promise<NotificationRecord> {
    if (!input.recipientPassportId) {
      throw required("recipientPassportId", "NotificationSendInput");
    }
    if (!input.senderPassportId) {
      throw required("senderPassportId", "NotificationSendInput");
    }

    const now = (input.now ?? defaultNow)();
    const notification: NotificationRecord = {
      schema_version: "1.0",
      id: randomUUID(),
      recipient_passport_id: input.recipientPassportId,
      sender_passport_id: input.senderPassportId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
      pointer: input.pointer,
      acked_at: null,
    };

    await SpaceStore.open(input).appendNotification(notification);
    return notification;
  }

  static async list(input: NotificationListInput): Promise<NotificationRecord[]> {
    if (!input.recipientPassportId) {
      throw required("recipientPassportId", "NotificationListInput");
    }

    const now = (input.now ?? defaultNow)().getTime();
    const latest = await replayLatest(input.recipientPassportId, input);

    return [...latest.values()]
      .filter((notification) => notification.acked_at === null)
      .filter((notification) => Date.parse(notification.expires_at) > now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  static async ack(input: NotificationAckInput): Promise<NotificationRecord> {
    if (!input.recipientPassportId) {
      throw required("recipientPassportId", "NotificationAckInput");
    }
    if (!input.notificationId) {
      throw required("notificationId", "NotificationAckInput");
    }

    const latest = await replayLatest(input.recipientPassportId, input);
    const current = latest.get(input.notificationId);
    if (!current) {
      throw new SpaceNotFoundError(input.notificationId);
    }

    const acked: NotificationRecord = {
      ...current,
      acked_at: (input.now ?? defaultNow)().toISOString(),
    };
    await SpaceStore.open(input).appendNotification(acked);
    return acked;
  }
}

async function replayLatest(
  recipientPassportId: string,
  options: SpaceStoreOptions,
): Promise<Map<string, NotificationRecord>> {
  try {
    const records = await SpaceStore.open(options).readNotifications(recipientPassportId);
    return new Map(records.map((notification) => [notification.id, notification]));
  } catch (error) {
    if (error instanceof SpaceParseError && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

function required(field: string, path: string): SpaceValidationError {
  return new SpaceValidationError([{ code: "custom", path: [field], message: `${field} is required` }], path);
}

function defaultNow(): Date {
  return new Date();
}
