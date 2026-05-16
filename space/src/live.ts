import { mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface LiveStoreOptions {
  root?: string;
  dataDir?: string;
  filename?: string;
}

export interface LiveStorePaths {
  root: string;
  dataDir: string;
  liveDb: string;
}

const DEFAULT_DATA_DIR = ".seedrop/space";
const DEFAULT_FILENAME = "live.db";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     passport_id TEXT NOT NULL,
     space_id TEXT,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     working_on TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS sessions_passport ON sessions(passport_id)",
  "CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_at)",
  `CREATE TABLE IF NOT EXISTS mentions (
     id TEXT PRIMARY KEY,
     message_id TEXT NOT NULL,
     space_id TEXT NOT NULL,
     space_name TEXT,
     recipient_passport_id TEXT NOT NULL,
     sender_passport_id TEXT NOT NULL,
     sender_principal_chain TEXT,
     content TEXT NOT NULL,
     created_at TEXT NOT NULL,
     delivered_at TEXT,
     acked_at TEXT,
     ack_result TEXT,
     ack_note TEXT,
     deferred_until TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS mentions_recipient ON mentions(recipient_passport_id, acked_at, created_at)",
  "CREATE INDEX IF NOT EXISTS mentions_message ON mentions(message_id)",
];

export class LiveStore {
  readonly paths: LiveStorePaths;
  private db: DatabaseType | null = null;

  private constructor(paths: LiveStorePaths) {
    this.paths = paths;
  }

  static open(options: LiveStoreOptions = {}): LiveStore {
    const root = path.resolve(options.root ?? process.cwd());
    const dataDir = path.isAbsolute(options.dataDir ?? "")
      ? options.dataDir ?? DEFAULT_DATA_DIR
      : path.join(root, options.dataDir ?? DEFAULT_DATA_DIR);
    const filename = options.filename ?? DEFAULT_FILENAME;

    return new LiveStore({
      root,
      dataDir,
      liveDb: path.join(dataDir, filename),
    });
  }

  async connection(): Promise<DatabaseType> {
    if (this.db) {
      return this.db;
    }

    await mkdir(this.paths.dataDir, { recursive: true });
    const db = new Database(this.paths.liveDb);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }

    this.db = db;
    return db;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
