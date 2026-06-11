# Changelog

All notable changes to `@seedrop/mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0-alpha.3] — 2026-06-11

### Fixed
- README: `seed continuity` → `seed boot` in the description; clarified the server is normally launched via `npx` by `seed install`, not installed directly.

## [0.2.0-alpha.2] — 2026-06-10
_Supersedes 0.2.0-alpha.1 (first public cut)._

### Changed
- **ADR 0001 tool-surface reduction (54 → 45).** Handoff and thread tools removed; `seedrop_continuity` and `seedrop_view_brief` removed (use `seedrop_boot`); `seedrop_signal_lock` folded into `seedrop_signal_claim` via a `type` parameter.
### Added
- `budget` arg on `seedrop_view_context` and `seedrop_boot`; `handoff_to`/`handoff_note` on `seedrop_run_finish`.
- npm metadata: `repository`, `homepage`, `bugs`.

---

## [0.1.0-alpha.1] — 2026-05-15

### Added
- Initial stdio MCP server (`seed-mcp`) exposing 11 tools:
  `seedrop_continuity`, `seedrop_bootstrap`, `seedrop_view_context`, `seedrop_view_log`,
  `seedrop_space_register`, `seedrop_space_heartbeat`, `seedrop_space_presence`,
  `seedrop_space_join`, `seedrop_space_post`, `seedrop_space_messages`,
  `seedrop_daemon_status`.
- Tools delegate to the bundled `@seedrop/cli` via spawn, keeping the MCP
  surface and CLI surface in lockstep.
- Unit tests for the tool registry and handler behavior.
- `smoke` script that spawns the server and runs a real `initialize` →
  `tools/list` → `tools/call` JSON-RPC handshake.
