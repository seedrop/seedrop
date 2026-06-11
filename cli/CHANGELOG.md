# Changelog

All notable changes to `@seedrop/cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0-alpha.4] — 2026-06-11

### Changed
- Release alignment with the 0.2.0-alpha.4 docs-final sweep (no code changes).

## [0.2.0-alpha.3] — 2026-06-11

### Changed
- Release alignment with the 0.2.0-alpha.3 docs sweep (no code changes).

## [0.2.0-alpha.2] — 2026-06-10
_Supersedes 0.2.0-alpha.1 (first public cut; undocumented)._

### Changed
- **ADR 0001 orientation tiers.** `seed boot` is the canonical cold-start Situation packet; `seed continuity` and `seed view brief` stay CLI-only renders.
- `next_move` consumes the unclaimed task queue and escalates aging items instead of reporting "no queued work" while tasks exist.
### Added
- `--budget <bytes>` on `seed boot --json`, `seed continuity --json`, and `seed view context` for byte-bounded deep surfaces.
- `seed run finish --handoff-to <agent>` (handoffs are assigned tasks).
- npm metadata: `repository`, `homepage`, `bugs`; README install switched to the published-npm flow.


### Added
- `seed continuity` (and bare `seed`) synthesizes identity + per-repo View + daemon presence + recent Space messages into a single boot block (`--json` for machine reading). Bare `seed` falls back to help when no passport exists.
- `seed bootstrap` orchestrates first-time-on-machine setup and per-repo linking; idempotent on re-run.
- `seed daemon install|uninstall|status` writes a launchd plist at `~/Library/LaunchAgents/com.seedrop.daemon.plist` and manages the always-on Space server (macOS only for now).
- New `smoke:install` script: packs all three workspaces and exercises the cli through `npm install`'d tarballs with no PATH shims, proving the published install path.
- `seed install <agent> --to <client>` and `seed init` now drop the Seedrop skill *and* boot reflex per detected/wired client in one shot:
  - Claude Code / Claude Desktop → `~/.claude/skills/seedrop.md` (flat layout)
  - Codex CLI → `~/.codex/skills/seedrop/SKILL.md` (folder layout)
  - Boot reflex appended to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` inside a managed `<!-- seedrop:boot-reflex:start --> ... :end -->` marker block. Re-runs replace inside the markers; hand-edits are backed up to `<file>.bak.<ms>`.
  - Per-client wiring is driven by `skill` and `instructions_path` fields in `clients.json` — other clients opt in by adding their own metadata.
- Templates ship under `cli/templates/skills/<client>/` and `cli/templates/boot-reflex.md`; canonical skill content remains `seedrop_manual`.
- Tests for `runBootstrap` orchestration, `continuity` rendering (no passport, no daemon, no view), default path helpers, bootstrap/daemon/continuity dispatch, and the new skill + boot-reflex install flow (flat/folder layouts, marker idempotency, hand-edit backup).

### Changed
- `@seedrop/id` and `@seedrop/space` are now runtime `dependencies` (previously optional peers). The cli is fully self-sufficient after `npm install`.
- Spawn dispatch resolves sub-binaries via `import.meta.resolve` instead of relying on PATH; falls back to PATH for the dev smoke shim path.
- `seed view init` defaults `--passport` to `$SEEDROP_PASSPORT` or `~/.seedrop/id/passport.json`.
- Help text and examples updated to match the new persistent-identity ritual.

### Fixed
- `process.argv[1]` script-detection guard in `cli.ts` no longer breaks when invoked through the npm `.bin/` symlink (the guard was removed; the file is only ever executed).

---

## [0.1.0-alpha.2] — 2026-05-15

### Added
- E2E sprint plan covering identity first-run, project orientation, space serve, collaboration commands, and local smoke acceptance gates.
- Top-level `seed id init|validate|show|audit` flow coverage through router normalization and composition smoke.
- `seed view init --passport ...` composition: initializes workspace view and records the project in the passport via `seed-id project link`.
- Composition smoke coverage for `seed space serve --passport ...`, including accepted and rejected `/sessions` calls.
- Composition smoke now proves the two-passport collaboration loop through top-level `seed space join/post/messages/presence/notify/notifications/ack/end`.

### Changed
- Positional passport normalization now covers `validate`, `show`, and `audit` in addition to `status` and `repair`.
- Composition smoke now verifies that `seed view init --passport ...` writes an `active_projects` entry.
- Delegated long-running commands now receive SIGINT/SIGTERM from the top-level `seed` wrapper.

---

## [0.1.0-alpha.1] — 2026-05-14

### Added
- Initial top-level `seed` CLI router for `id`, `space`, and `view` namespaces.
- Thin delegation to package-local CLIs:
  - `seed id ...` -> `seed-id ...`
  - `seed space ...` -> `seed-space ...`
  - `seed view ...` -> `seed-space view ...`
- Composition smoke script that runs the built `seed` router against local built `seed-id` and `seed-space` shims.
- Positional passport normalization for `seed id status <passport>` and `seed id repair <passport>`.

### Changed
- README and help examples now reflect the current implemented `seed-space` CLI surface: `view` commands only for now.

---

## [0.1.0-alpha.0] — 2026-05-14

### Added
- Initial package scaffold.
