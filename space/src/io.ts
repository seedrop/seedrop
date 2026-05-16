import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { SpaceParseError, SpaceValidationError } from "./errors.js";
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

async function serializeWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const stored = next.then(() => undefined, () => undefined);
  writeQueues.set(key, stored);
  try {
    await next;
  } finally {
    if (writeQueues.get(key) === stored) {
      writeQueues.delete(key);
    }
  }
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
