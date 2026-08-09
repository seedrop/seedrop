import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";

// better-sqlite3 is a native module and an *optional* dependency: it backs only
// the live Space store (sessions/presence/mentions), i.e. the daemon. The CLI
// core (identity, View, bootstrap, `seed`) never opens a LiveStore, so it must
// not pay a top-level native import — that would crash the whole CLI on any
// platform where better-sqlite3 isn't built (e.g. Linux without build tools or
// a prebuilt binary). We load it lazily, only when a connection is actually
// opened, and surface an actionable error if it's missing.
type DatabaseCtor = new (filename: string) => DatabaseType;
let cachedDatabase: DatabaseCtor | null = null;

const MISSING_MODULE_ADVICE =
  "The Seedrop Space live store requires the native module 'better-sqlite3', which is not installed. "
  + "It is an optional dependency: the CLI and per-repo View work without it, but the always-on Space daemon "
  + "(presence, mentions, inbox) does not. To enable it, ensure build tools are present and run "
  + "`npm rebuild better-sqlite3` (Linux: install python3/make/g++ first).";

/**
 * Turn a native-module load failure into the specific remedy for that failure.
 *
 * These two cases need different fixes and used to share one message. The ABI
 * mismatch is by far the more common of the two in practice — it fires whenever
 * a developer switches Node versions (nvm, a new release, a rebuilt image)
 * against an existing node_modules, and it presents as the Space daemon
 * returning opaque 500s rather than as anything resembling an install problem.
 */
export function describeNativeLoadFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version|ERR_DLOPEN_FAILED/i.test(message)) {
    const versions = message.match(/NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/);
    const detail = versions
      ? ` The installed binary targets Node ABI ${versions[1]}; this Node needs ABI ${versions[2]}.`
      : "";
    return (
      "'better-sqlite3' is installed but was compiled for a different Node.js version, so the Seedrop Space "
      + `live store (presence, mentions, inbox) cannot start.${detail} `
      + "This usually means the Node version changed after `npm install` — switching via nvm is the common cause. "
      + "Fix it with `npm rebuild better-sqlite3`, or reinstall dependencies under the current Node."
    );
  }
  return MISSING_MODULE_ADVICE;
}

async function loadDatabaseCtor(): Promise<DatabaseCtor> {
  if (cachedDatabase) return cachedDatabase;
  try {
    const mod = (await import("better-sqlite3")) as unknown as { default: DatabaseCtor };
    cachedDatabase = mod.default;
    return cachedDatabase;
  } catch (cause) {
    throw new Error(describeNativeLoadFailure(cause), { cause });
  }
}

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
  `CREATE TABLE IF NOT EXISTS post_outbox_v2 (
     schema_version TEXT NOT NULL CHECK (schema_version = '2.0'),
     request_id TEXT NOT NULL,
     space_id TEXT NOT NULL,
     space_name TEXT NOT NULL,
     author_passport_id TEXT NOT NULL,
     command_hash TEXT NOT NULL,
     message_id TEXT NOT NULL,
     message_json TEXT NOT NULL,
     recipients_json TEXT NOT NULL,
     unknown_recipients_json TEXT NOT NULL,
     effect_keys_json TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'completed', 'dead_letter')),
     attempt_count INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     lease_owner_pid INTEGER,
     lease_until TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     completed_at TEXT,
     PRIMARY KEY (space_id, author_passport_id, request_id)
   )`,
  "CREATE INDEX IF NOT EXISTS post_outbox_v2_author_state ON post_outbox_v2(author_passport_id, state, updated_at)",
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
    const Database = await loadDatabaseCtor();
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
