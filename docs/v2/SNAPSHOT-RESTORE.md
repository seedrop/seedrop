# Seedrop v2 migration snapshot and restore

This is the containment runbook for `DC-02`. It captures the complete known migration corpus before any v2 schema or storage cutover:

- the entire identity directory, including operator and agent passports, audit logs, and pending commit journals;
- the daemon directory, including durable Space JSON/JSONL, session metadata, logs, and the live SQLite store;
- machine-local active-passport and continuity-watermark state;
- every `.seedrop/view/` discovered from all readable passports, plus the current repository View.

The database experiment in `/seedrop_db` is not part of this corpus or the v2 dependency graph.

## Safety and consistency contract

`scripts/v2-snapshot.mjs` creates a content-addressed snapshot outside the repository by default:

```bash
node scripts/v2-snapshot.mjs create
```

The default location is `$HOME/.seedrop/backups/v2-preflight/<UTC timestamp>`. The backup parent, snapshot, object directories, manifest, receipt, and restore instructions are permission-restricted to the current user (`0700` directories and `0600` files).

The tool never prints or embeds passport contents, credential references, messages, or View records in the manifest. The restricted local manifest does contain source paths, object hashes, original permission modes, byte counts, and logical record counts. JSONL files are captured only after a stable-read check. SQLite databases are captured through SQLite's online backup operation and must pass `PRAGMA integrity_check` before becoming objects.

Every distinct payload is stored once under `objects/<sha256>`. `manifest.json` maps source-relative paths to those objects. `receipt.json` binds the manifest hash and canonical corpus hash and records the isolated restore drill.

## Verification

```bash
node scripts/v2-snapshot.mjs verify <snapshot-directory>
node scripts/v2-snapshot.mjs restore-test <snapshot-directory>
```

`verify` checks the receipt, canonical corpus hash, every content object, and restrictive backup permissions. `restore-test` reconstructs a temporary isolated copy, checks every file hash, size, original permission mode, symlink identity, SQLite integrity, per-file logical record count, and aggregate record count, then removes only that temporary copy.

## Recovery without overwriting live state

Reconstruct into a path that does not exist:

```bash
node scripts/v2-snapshot.mjs restore <snapshot-directory> --target <new-path>
```

The result is organized under `<new-path>/sources/<source-id>/`, with a protected `restore-map.json` that maps each source to its original location. The command refuses an existing target and never restores directly over live sources.

For disaster recovery:

1. Stop the Seedrop daemon.
2. Verify and restore-test the backup.
3. Reconstruct into a new empty path.
4. Inspect `restore-map.json` and confirm every intended destination.
5. Move damaged live state aside; copy the verified reconstruction into place while preserving modes.
6. Restart the daemon and run `seed daemon status`, `seed boot --json`, and View audit/preflight checks.
7. Retain displaced state until hashes, counts, and product-level behavior all pass.

Never use the tool to overwrite `$HOME`, the live `$HOME/.seedrop` tree, a repository root, or an existing backup.

## DC-02 execution proof — 2026-08-08

The pre-v2 machine corpus was captured at `$HOME/.seedrop/backups/v2-preflight/20260808T172609182Z`.

| Evidence | Result |
| --- | --- |
| Captured sources | 21: 18 Views, identity, daemon, and machine state |
| Files / directories / symlinks | 2,851 / 149 / 0 |
| Logical records | 2,993 |
| Payload bytes | 34,160,565 |
| Unique content objects | 2,834 |
| SQLite online backups | 1; integrity check passed |
| Passport parse failures | 0 |
| Registered roots without a View | 6; recorded as missing, not treated as empty Views |
| Canonical corpus SHA-256 | `1c3905fdd58a2ede69facb1d39116d6a2b0169574c1f6fc5a0162b55b0c7aaeb` |
| Backup permissions | directories `0700`; control and object files `0600` |
| Isolated restore drill | passed; 2,851 file hashes and 2,993 record counts reproduced |

The backup is deliberately outside Git. Its restricted `manifest.json`, `receipt.json`, and `RESTORE.md` are the authoritative local evidence; this table is the non-sensitive execution receipt.
