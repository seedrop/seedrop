# Changelog

All notable changes to `@seedrop/mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
