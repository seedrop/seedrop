import { describe, expect, it } from "vitest";
import {
  MessageSchema,
  NotificationSchema,
  SessionSchema,
  SpaceMetaSchema,
  type Message,
  type Notification,
  type Session,
  type SpaceMeta,
} from "../src/index.js";
import { WorkspaceManifestSchema } from "../src/schema.js";

const now = "2026-05-14T10:00:00.000Z";

function validSpace(overrides: Partial<SpaceMeta> = {}): SpaceMeta {
  return {
    schema_version: "1.0",
    id: "space-1",
    name: "Demo Room",
    lifecycle: "open",
    members: [{ passport_id: "alpha", joined_at: now }],
    created_at: now,
    ended_at: null,
    archived_at: null,
    ...overrides,
  };
}

function validMessage(overrides: Partial<Message> = {}): Message {
  return {
    schema_version: "1.0",
    id: "message-1",
    space_id: "space-1",
    author_passport_id: "alpha",
    role: "agent",
    created_at: now,
    content: "Hello.",
    ...overrides,
  };
}

function validNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    schema_version: "1.0",
    id: "notification-1",
    recipient_passport_id: "beta",
    sender_passport_id: "alpha",
    created_at: now,
    expires_at: "2026-05-14T11:00:00.000Z",
    pointer: { kind: "space-message", ref: "space-1/message-1" },
    acked_at: null,
    ...overrides,
  };
}

function validSession(overrides: Partial<Session> = {}): Session {
  return {
    schema_version: "1.0",
    id: "session-1",
    passport_id: "alpha",
    created_at: now,
    last_seen_at: now,
    ...overrides,
  };
}

describe("core space schemas", () => {
  it("accepts valid space metadata", () => {
    expect(SpaceMetaSchema.safeParse(validSpace()).success).toBe(true);
  });

  it("rejects an ended space without ended_at", () => {
    const result = SpaceMetaSchema.safeParse(validSpace({ lifecycle: "ended", ended_at: null }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("ended_at"))).toBe(true);
    }
  });

  it("rejects an archived space without archived_at", () => {
    const result = SpaceMetaSchema.safeParse(validSpace({ lifecycle: "archived", ended_at: now, archived_at: null }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("archived_at"))).toBe(true);
    }
  });

  it("rejects unknown space fields", () => {
    const result = SpaceMetaSchema.safeParse({ ...validSpace(), extra: true });
    expect(result.success).toBe(false);
  });

  it("accepts valid messages", () => {
    expect(MessageSchema.safeParse(validMessage()).success).toBe(true);
  });

  it("rejects invalid message roles", () => {
    const result = MessageSchema.safeParse(validMessage({ role: "robot" as never }));
    expect(result.success).toBe(false);
  });

  it("accepts valid notifications", () => {
    expect(NotificationSchema.safeParse(validNotification()).success).toBe(true);
  });

  it("rejects notification pointers without refs", () => {
    const result = NotificationSchema.safeParse(validNotification({ pointer: { kind: "space-message", ref: "" } }));
    expect(result.success).toBe(false);
  });

  it("accepts valid sessions", () => {
    expect(SessionSchema.safeParse(validSession()).success).toBe(true);
  });

  it("rejects malformed session timestamps", () => {
    const result = SessionSchema.safeParse(validSession({ last_seen_at: "yesterday" }));
    expect(result.success).toBe(false);
  });

  it("rejects workspace manifests with duplicate file paths", () => {
    const result = WorkspaceManifestSchema.safeParse({
      schema_version: "1.0",
      workspace_id: "demo",
      root: ".",
      updated_at: now,
      files: [
        {
          path: "src/a.ts",
          kind: "source",
          size_bytes: 1,
          hash: "0".repeat(64),
        },
        {
          path: "src/a.ts",
          kind: "source",
          size_bytes: 1,
          hash: "0".repeat(64),
        },
      ],
      recommended_reads: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("unique"))).toBe(true);
    }
  });
});
