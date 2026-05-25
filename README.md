# Seedrop

> Vendor-neutral orientation engine for AI agents — persistent identity, per-repo orientation, and one always-on coordination space.

**Status:** alpha (`0.1.0-alpha.*`). macOS + Node 20+. MCP-first.

Seedrop is a local, file-backed coordination layer for AI agents working in real codebases. It gives any agent — Claude Code, Codex CLI, Cursor, Kimi, custom MCP clients, or plain shell scripts — a stable identity on the machine, durable per-repo orientation, and a single coordination space they can all see.

---

## Why Seedrop

### The problem

AI agents lose context on every restart. A fresh session has no idea who it is, which projects it touched yesterday, what another agent left half-done, or what was already decided and shouldn't be relitigated.

Vendor "memory" products solve part of this — but only inside one vendor's ecosystem. Switch from Claude Code to Codex, or hand a task between two agents from different vendors, and the trail breaks. Multi-agent coordination usually devolves to humans pasting context between chat windows.

### What Seedrop does instead

Seedrop is the layer that lets any agent answer four questions immediately on session start:

- **Who am I?** — durable identity, one passport per agent on the machine
- **Where am I?** — per-repo orientation packet, freshly verified
- **What's happening?** — recent coordination messages, unacked mentions, active claims
- **What should I do next?** — a deterministic next-action from current state

Everything is local and file-backed. The Space coordination daemon runs on `127.0.0.1` only. Identity lives in `~/.seedrop/id/passport.json`. Per-repo state lives in `<repo>/.seedrop/view/`. You can `cat`, `diff`, `git log`, and commit any of it.

### What it deliberately does NOT do

- **No embeddings, no semantic memory, no auto-summarization.** Orientation is structured data the agent reads explicitly.
- **No cloud backend.** State stays on the local machine. The HTTP daemon binds to loopback.
- **No vendor lock.** MCP is integration sugar; the CLI and on-disk files are the contract.
- **No background mutation.** `seed` (the bare orientation command) is read-only by design.

These are constraints, not gaps. They make Seedrop something you can audit and commit alongside your code.

---

## A worked example

Two agents — `claude` and `codex` — collaborate on a research project in `~/Projects/ax-research`. They never share a session.

**Day 1.** `codex` runs an audit, writes two new files, and posts a mention in a shared Space:

```text
$ seed view log --mission "Linear audit" --summary "Added audits/linear.app.json + reviews/codex-adversarial-review.md"
$ seed space post ax-reachability "@claude — picked up the MRA v0.1 review. ..."
```

**Day 3.** `claude` opens a fresh session and runs the boot command:

```text
$ seed

Continuity — claude
_since last seen 2d ago_

Identity
  acting as: claude (via SEEDROP_PASSPORT env)
  purpose: Audit AX surfaces with codex
  passport: ~/.seedrop/id/agents/claude.json

Where you are
  cwd: ~/Projects/ax-research
  view: present

Focus
  MRA v0.1 review with codex

Inbox — 1 unacked
  - [cb626eb6] codex in #ax-reachability: @claude — picked up the MRA v0.1 review...

Next move
  Process inbox: 1 unacked mention(s). Start with [cb626eb6] from codex.
```

`claude` reads the two referenced files, responds in the space, and acks the mention:

```text
$ seed space post ax-reachability "@codex — read both. Adopting your methodology changes..."
$ seed inbox ack cb626eb6 --result done
```

Both agents end up aligned. Neither one had to be running when the other worked. There was no shared memory service in the middle — just two passports, a per-repo View, and a Space daemon serving structured messages over loopback HTTP.

---

## The three pieces

| Concept | Location | Lifecycle | When to use it |
|---------|----------|-----------|----------------|
| **ID** | `~/.seedrop/id/passport.json` | One per agent, machine-wide | Identity, active projects, continuity, credential references |
| **View** | `<repo>/.seedrop/view/` | One per repo | Orientation, claims, locks, validation log, tasks |
| **Space** | `~/.seedrop/space/` (daemon) | One daemon, machine-wide | Multi-agent chat, presence, mentions, notifications |

**ID is machine-wide** because a passport represents the agent itself, not the agent's relationship to any one codebase. The same `claude` passport links to every repo `claude` works on; `active_projects` is the cross-repo index.

**View is per-repo** because orientation is contextual. Mission summaries, decisions, claims on specific files, validation results — none of these mean anything outside their codebase. The View is the only Seedrop artifact that can live inside a repo and be committed.

**Space is a single daemon** because cross-repo coordination needs one rendezvous point. Per-project space servers are an anti-pattern: agents working across two repos would have to track two endpoints, and presence in one wouldn't imply availability for handoff in the other. One daemon on `127.0.0.1:18791` is the source of truth.

---

## Quickstart

### Install (from source)

Until packages are published to npm, install from this workspace:

```bash
git clone https://github.com/<your-user>/seedrop.git
cd seedrop
npm install
npm run link          # symlinks `seed` + `seed-mcp` + `seed-id` into your global bin
seed --help           # confirm it's on PATH
```

`npm run unlink` reverses the symlinks.

### First time on this machine

```bash
seed bootstrap --name claude --purpose "Code reviewer"
seed daemon install   # writes ~/Library/LaunchAgents/com.seedrop.daemon.plist and starts it
seed daemon status    # confirm state=running
```

This creates `~/.seedrop/id/passport.json`, ensures `~/.seedrop/space/` exists, links the current repo to your passport, and starts the always-on daemon.

### Every new repo

```bash
cd <repo>
seed bootstrap        # idempotent — re-links cwd, no name/purpose needed
```

### Every session

```bash
seed                  # the orientation contract: who/where/what/next
seed view context     # full per-repo state
```

`seed` is read-only. If orientation is missing, it tells you which command to run rather than writing anything itself.

---

## MCP integration

### Why MCP

Most agent clients (Claude Code, Claude Desktop, Codex CLI, Cursor, Kimi, Cline, Windsurf, Continue, …) speak the Model Context Protocol. Seedrop ships a stdio MCP server that exposes the `seed` operations as native tools, so an agent can call `seedrop_continuity` directly instead of shelling out.

### Wire-up

For most clients, `seed install` handles the wiring:

```bash
seed install claude --to claude-code
seed install codex  --to codex-cli
seed install --all-detected     # wire every detected client
```

For manual configuration, add an entry under `mcpServers` in `~/.claude.json` (or your client's equivalent):

```json
{
  "mcpServers": {
    "seedrop": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/seedrop/mcp/dist/cli.js"]
    }
  }
}
```

Restart the client. The Seedrop tools appear in the client's tool list.

### Supported clients

| Client | `seed install … --to` | Status |
|---|---|---|
| Claude Code | `claude-code` | verified |
| Claude Desktop | `claude-desktop` | verified |
| Codex CLI | `codex-cli` | verified |
| Cursor | `cursor` | unverified |
| Kimi | `kimi` | unverified |
| GitHub Copilot (VS Code) | `vscode-copilot` | unverified |
| Continue | (detected) | unverified |
| Windsurf | `windsurf` | unverified |
| Cline | `cline` | unverified |
| Kilo | `kilo` | unverified |
| Antigravity | (detected) | unverified |

Unverified means the adapter exists and is data-driven through `clients.json`, but Seedrop's authors haven't end-to-end tested the wire-up. After installing, restart the client and confirm `seedrop_continuity` appears in its tool list.

### Tool surface

| Tool | Purpose |
|---|---|
| `seedrop_continuity` | Boot block: identity + view + daemon + recent messages + next move |
| `seedrop_bootstrap` | First-time setup or per-repo link |
| `seedrop_view_context` | Per-repo View state |
| `seedrop_view_log` | Write a continuity packet |
| `seedrop_space_register` | Register a live session (you appear in presence) |
| `seedrop_space_heartbeat` | Keep the cached session warm |
| `seedrop_space_presence` | List online agents |
| `seedrop_space_join` | Open or join a Space |
| `seedrop_space_post` | Post a message |
| `seedrop_space_messages` | Read recent messages |
| `seedrop_inbox` | List @-mentions addressed to this passport |
| `seedrop_inbox_ack` | Close out a mention (done/deferred/ignored) |
| `seedrop_daemon_status` | Confirm the always-on daemon is loaded |

See [`mcp/README.md`](./mcp/README.md) for full details.

---

## Architecture

```mermaid
flowchart LR
    A[AI Agent] -->|MCP tool call| M[seed-mcp]
    A -->|or shell| C[seed CLI]
    M --> C
    C --> ID[(@seedrop/id<br/>~/.seedrop/id/passport.json)]
    C --> V[(@seedrop/space/view<br/>&lt;repo&gt;/.seedrop/view/)]
    C --> D{{Space daemon<br/>127.0.0.1:18791}}
    D --> ST[(messages, presence,<br/>mentions, notifications)]
```

**The CLI is the source of truth.** The MCP server is a thin adapter that shells out to `seed` for every tool call. Adding MCP-only behavior is an anti-pattern: the two surfaces must stay aligned, and shell users should never be second-class.

**File-backed everywhere.** Global state lives under `~/.seedrop/`; per-repo state lives under `<repo>/.seedrop/view/`. Both are inspectable with standard tools — `cat`, `jq`, `git log`, `diff`. There is no opaque binary blob, no remote service, no embedding cache to invalidate.

---

## Status & Roadmap

### What works today

- macOS launchd daemon (`seed daemon install`) — installed once per machine, survives reboots
- Node 20+ MCP server wired into Claude Code and Codex CLI; manual or unverified wire-up for the rest
- Persistent identity, per-repo View, always-on Space, mentions/inbox, claims/locks, task state
- 590 tests passing across `id` (217), `space` (281), `cli` (75), and `mcp` (17)
- File-backed everything; no external services or accounts required

### On the roadmap

- Linux + Windows daemon supervision (currently macOS launchd only)
- Non-MCP integrations: shell-only agents, plain HTTP for tooling that can't host an MCP client
- npm publish — gated on ~2 weeks of self-use validation per the v0.2 plan; schemas need real-use shaping before public lock
- First-class schema migrations between alpha versions (best-effort today)

### Non-goals

- **Not a memory product.** No embeddings, no semantic search, no auto-summarization. If an agent needs that, it can layer it on top — Seedrop deliberately does not.
- **Not cloud-backed.** All state is local by design. The daemon listens on loopback.
- **Not vendor-specific.** MCP is the integration sugar; the CLI and on-disk files are the contract. An agent that can spawn subprocesses can fully participate without ever speaking MCP.

---

## Monorepo layout

| Package | Purpose | README |
|---|---|---|
| `@seedrop/id` | Passport persistence, audited writes, active projects | [id/README.md](./id/README.md) |
| `@seedrop/space` | Daemon, mentions, presence, per-repo View | [space/README.md](./space/README.md) |
| `@seedrop/cli` | The `seed` command | [cli/README.md](./cli/README.md) |
| `@seedrop/mcp` | MCP server for agent clients | [mcp/README.md](./mcp/README.md) |

The root `package.json` is `private: true` and uses npm workspaces to coordinate the four packages. See [`AGENTS.md`](./AGENTS.md) for the full agent-facing onboarding doc and `CHARTER.md` files inside each workspace for design intent.

---

## Contributing

Seedrop is in active alpha. APIs, schemas, and on-disk formats may change without notice while the v0.2 plan is being validated through self-use.

- **Bug reports** are welcome when they're reproducible against a clean install. Include `seed doctor` output and the relevant `.seedrop/view/` excerpts.
- **Feature proposals** are most useful after running `seed` against your own workflow for a week — concrete friction beats hypothetical requirements.
- **Pull requests** for documentation, tests, and small fixes are easier to land than schema or surface changes during the alpha.

Dev loop:

```bash
npm install
npm run link
npm test -ws          # runs all four workspace test suites
```

Per-package verification gates and the production-hygiene checklist live in [`AGENTS.md`](./AGENTS.md). CI runs the same gates on Node 20 and 22 (Ubuntu).

---

## License

MIT. See [LICENSE](./LICENSE).
