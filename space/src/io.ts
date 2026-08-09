import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { SpaceParseError, SpaceRequestConflictError, SpaceValidationError } from "./errors.js";
import { MessageSchema, NotificationSchema, SpaceMetaSchema } from "./schema.js";
import type { Message, Notification, SpaceMeta } from "./schema.js";

export interface SpaceStoreOptions {
  root?: string;
  dataDir?: string;
}

export interface SpaceStorePaths {
  root: string;
  dataDir: string;
  spacesDir: string;
  notificationsDir: string;
}

export interface AppendMessageOnceResult {
  message: Message;
  replayed: boolean;
}

const DEFAULT_DATA_DIR = ".seedrop/space";
const writeQueues = new Map<string, Promise<void>>();

export class SpaceStore {
  readonly paths: SpaceStorePaths;

  private constructor(paths: SpaceStorePaths) {
    this.paths = paths;
  }

  static open(options: SpaceStoreOptions = {}): SpaceStore {
    const root = path.resolve(options.root ?? process.cwd());
    const dataDir = path.isAbsolute(options.dataDir ?? "")
      ? options.dataDir ?? DEFAULT_DATA_DIR
      : path.join(root, options.dataDir ?? DEFAULT_DATA_DIR);

    return new SpaceStore({
      root,
      dataDir,
      spacesDir: path.join(dataDir, "spaces"),
      notificationsDir: path.join(dataDir, "notifications"),
    });
  }

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.spacesDir, { recursive: true }),
      mkdir(this.paths.notificationsDir, { recursive: true }),
    ]);
  }

  spaceDir(spaceId: string): string {
    return path.join(this.paths.spacesDir, safeSegment(spaceId));
  }

  spaceMetaPath(spaceId: string): string {
    return path.join(this.spaceDir(spaceId), "meta.json");
  }

  messagesPath(spaceId: string): string {
    return path.join(this.spaceDir(spaceId), "messages.jsonl");
  }

  notificationsPath(passportId: string): string {
    return path.join(this.paths.notificationsDir, `${safeSegment(passportId)}.jsonl`);
  }

  async writeSpaceMeta(meta: SpaceMeta): Promise<void> {
    await this.ensure();
    await mkdir(this.spaceDir(meta.id), { recursive: true });
    await writeJson(this.spaceMetaPath(meta.id), validateValue(meta, SpaceMetaSchema, this.spaceMetaPath(meta.id)));
  }

  async readSpaceMeta(spaceId: string): Promise<SpaceMeta> {
    return readJson(this.spaceMetaPath(spaceId), SpaceMetaSchema);
  }

  async listSpaceMetas(): Promise<SpaceMeta[]> {
    await this.ensure();
    const entries = await readdir(this.paths.spacesDir, { withFileTypes: true });
    const metas: SpaceMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        metas.push(await this.readSpaceMeta(entry.name));
      } catch {
        continue;
      }
    }

    return metas.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  async appendMessage(message: Message): Promise<void> {
    await this.ensure();
    await mkdir(this.spaceDir(message.space_id), { recursive: true });
    await appendJsonLine(this.messagesPath(message.space_id), validateValue(message, MessageSchema, this.messagesPath(message.space_id)));
  }

  async appendMessageOnce(message: Message, requestId: string): Promise<AppendMessageOnceResult> {
    await this.ensure();
    await mkdir(this.spaceDir(message.space_id), { recursive: true });
    const filePath = this.messagesPath(message.space_id);
    return serializeWrite(filePath, async () => {
      const prior = await readJsonLines(filePath, MessageSchema);
      const existing = prior.find(
        (candidate) => candidate.author_passport_id === message.author_passport_id
          && candidate.metadata?.seedrop_request_id === requestId,
      );
      if (existing) {
        if (!sameLogicalMessage(existing, message)) {
          throw new SpaceRequestConflictError(requestId, existing.id);
        }
        return { message: existing, replayed: true };
      }
      const validated = validateValue(message, MessageSchema, filePath);
      await writeFile(filePath, `${JSON.stringify(validated)}\n`, { encoding: "utf8", flag: "a" });
      return { message: validated, replayed: false };
    });
  }

  async readMessages(spaceId: string): Promise<Message[]> {
    return readJsonLines(this.messagesPath(spaceId), MessageSchema);
  }

  async appendNotification(notification: Notification): Promise<void> {
    await this.ensure();
    await appendJsonLine(
      this.notificationsPath(notification.recipient_passport_id),
      validateValue(notification, NotificationSchema, this.notificationsPath(notification.recipient_passport_id)),
    );
  }

  async readNotifications(passportId: string): Promise<Notification[]> {
    return readJsonLines(this.notificationsPath(passportId), NotificationSchema);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await serializeWrite(filePath, async () => {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  });
}

function validateValue<T>(value: unknown, schema: ZodType<T>, filePath: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SpaceValidationError(result.error.issues, filePath);
  }
  return result.data;
}

async function readJson<T>(filePath: string, schema: ZodType<T>): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new SpaceParseError(filePath, error instanceof Error ? error : new Error(String(error)));
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new SpaceValidationError(result.error.issues, filePath);
  }
  return result.data;
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await serializeWrite(filePath, async () => {
    await writeFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
  });
}

async function readJsonLines<T>(filePath: string, schema: ZodType<T>): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SpaceParseError(filePath, error instanceof Error ? error : new Error(String(error)));
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const records: T[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      void error;
      continue;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      continue;
    }
    records.push(result.data);
  }
  return records;
}

async function serializeWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const stored = next.then(() => undefined, () => undefined);
  writeQueues.set(key, stored);
  try {
    return await next;
  } finally {
    if (writeQueues.get(key) === stored) {
      writeQueues.delete(key);
    }
  }
}

function sameLogicalMessage(left: Message, right: Message): boolean {
  return left.space_id === right.space_id
    && left.author_passport_id === right.author_passport_id
    && left.role === right.role
    && left.content === right.content
    && left.replaces === right.replaces
    && left.tombstone === right.tombstone
    && stableJson(withoutRequestId(left.metadata)) === stableJson(withoutRequestId(right.metadata));
}

function withoutRequestId(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const { seedrop_request_id: _requestId, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function safeSegment(input: string): string {
  if (!input || input.includes("/") || input.includes("\\") || input === "." || input === "..") {
    throw new SpaceValidationError(
      [
        {
          code: "custom",
          path: [],
          message: "path segment must be non-empty and may not contain path separators",
        },
      ],
      input,
    );
  }
  return input;
}
