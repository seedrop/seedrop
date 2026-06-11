# Changelog

All notable changes to `@seedrop/space` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0-alpha.4] — 2026-06-11

### Fixed
- README: `WorkspaceView` is documented as available from the package root (not just `./view`); storage layout updated for ADR 0001 (`tasks/`, `signals-archive.json`; `handoffs/` marked legacy); `seed view ...` routing note corrected now that `@seedrop/cli` exists.

## [0.2.0-alpha.3] — 2026-06-11

### Changed
- Release alignment with the 0.2.0-alpha.3 docs sweep (no code changes).

## [0.2.0-alpha.2] — 2026-06-10
_Supersedes 0.2.0-alpha.1 (first public cut; undocumented)._

### Changed
- **ADR 0001 ontology collapse.** Handoffs are tasks — `finishRun --handoff-to` creates a task assigned to the recipient; legacy pending handoffs fold into assigned tasks on `sync()`. Threads are ownerless tasks — materialized on `run thread` / `view log` and migrated on `sync()`; `view threads` and `thread resolve` removed.
- `context()` always summarizes the manifest (no inline file list) and trims to a byte budget (default 8 KB) with an auditable `budget` record.
### Added
- Signal GC: expired signals archive to `signals-archive.json` on `sync()` after a 24h grace; `finishRun` releases the run's own claims into the archive.
- Presence flags duplicate online sessions per passport (`duplicate_sessions`).
- npm metadata: `repository`, `homepage`, `bugs`.


### Added
- `seed-space register` and `seed-space heartbeat` CLI commands for live presence. `register` calls `POST /sessions` and caches the returned session id at `~/.seedrop/space/sessions/<passportId>.json`; `heartbeat` reads the cached id (or accepts `--session-id`) and calls `POST /presence/heartbeat`.
- `SpaceHttpClient.register()` and `SpaceHttpClient.heartbeat()` public methods.

### Changed
- `seed-space serve` defaults: `--root` → `$SEEDROP_SPACE_ROOT` or `~/.seedrop/space`; `--port` → 18791; `--passport` → `$SEEDROP_PASSPORT` or `~/.seedrop/id/passport.json`.
- `seed-space` client commands default `--url` to `$SEEDROP_SPACE_URL` or `http://127.0.0.1:18791`, and `--passport` to the global passport path.
- `startSpaceServer()` default port changed from 8787 to 18791.

---

## [0.1.0-alpha.2] — 2026-05-15

### Added
- `startSpaceServer()` and `createPassportIdentityResolver()` helpers for passport-bound HTTP server startup.
- `seed-space serve --root <path> --passport <path> --port <port>` for running the coordination HTTP server from the package CLI.
- `SpaceHttpClient` plus package-local HTTP client commands: `join`, `post`, `messages`, `presence`, `notify`, `notifications`, `ack`, and `end`.
- `seed-space serve` can authorize multiple `--passport` files for local multi-agent collaboration.

---

## [0.1.0-alpha.1] — 2026-05-14

### Added
- Slice 6 identity binding for HTTP: `createServer({ identity })` accepts an injected `IdentityResolver`, keeping passport verification outside `@seedrop/space` while letting authenticated routes refuse unknown or forbidden passports before mutation.
- Public `IdentityResolver` and `ResolvedIdentity` types, plus `SpaceAuthError` for resolver-level 401/403 failures.
- Slice 5 HTTP wrapper exposing the bounded coordination surface via the Node `http` module — `createServer({ root, dataDir?, now?, ttlMs? })` returning a stock `http.Server`, with exactly the eight CHARTER routes: `POST /sessions`, `POST /presence/heartbeat`, `GET /presence`, `POST /spaces/:name/join`, `GET /spaces/:name/messages`, `POST /spaces/:name/messages`, `POST /spaces/:name/end`, and the `/notifications` trio (`GET`, `POST`, `POST /:id/ack`).
- `X-Seedrop-Passport` request header threaded as the caller identity, with trust-only behavior when no identity resolver is configured.
- Typed-error → HTTP status mapper: validation → 400, not-found → 404, parse error → 500, fallback → 500.
- `npm run smoke:http` script (`scripts/smoke-http.ts`) replaying the full 15-step CHARTER smoke against the HTTP server on an ephemeral port.
- Slice 4 `Notification` static API (`send`, `list`, `ack`) over append-only per-passport JSONL with same-stream ACK tombstones.
- Full CHARTER smoke script now passes steps 1–15, including pointer notification send/list/ack flow.
- Slice 3 `Presence` static API (`register`, `heartbeat`, `list`, `end`) over a wipeable SQLite `live.db` at `.seedrop/space/live.db`, with TTL-based online/offline rollup.
- `LiveStore` wrapper for opening, schema-bootstrapping (sessions table + indices on `passport_id` and `last_seen_at`), and closing the live database.
- `npm run smoke` first-class CHARTER smoke script (`scripts/smoke.ts`) covering the full 15-step durability and coordination loop.
- `Session` schema extended with optional `space_id` and `working_on`; new `PresenceRecord` schema layering an `online` boolean on top.
- Slice 2 `Space` wrapper with `open`, `join`, `load`, `list`, `post`, `messages`, `members`, `leave`, and `end`.
- Slice 1 core `SpaceMeta`, `Message`, `Notification`, and `Session` schemas with `superRefine` lifecycle invariants.
- `SpaceStore` file I/O for space metadata, append-only message JSONL, per-passport notification JSONL, and a `safeSegment` guard against path traversal.
- Typed `SpaceError`, `SpaceParseError`, `SpaceValidationError`, and `SpaceNotFoundError` errors with multi-issue truncation and `cause` chaining.
- Test surface across `schema`, `io`, `space`, `errors`, `live`, `presence`, and `notification` reaching ≥99% line coverage and ≥90% branch coverage.
- Experimental `@seedrop/space/view` subpath with `WorkspaceView` for manifest-backed orientation, continuity packets, file-backed signal leases, context assembly, and audits.
- `seed-space` CLI for `sync`, `context`, `audit`, `log`, `claim`, `lock`, `signals`, and `release`.
- Zod validation and typed errors for workspace view JSON.

---

## [0.1.0-alpha.0] — 2026-05-14

### Added
- Initial repo scaffold: `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE` (MIT), `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CHARTER.md`.
- Empty `src/` and `tests/` directories.

### Notes
- No application code in this release. Public API is intent only — see `README.md`.
- Source of design: this repo's `CHARTER.md`, drafted 2026-05-14 from the deep-dive on the legacy memo system at `/Users/mc/Projects/memo/`.
- This package is a clean fork of the coordination layer from the legacy memo system. No code is imported; algorithms are re-implemented against the bounded API surface defined in `CHARTER.md`.
