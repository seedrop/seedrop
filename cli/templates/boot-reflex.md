# Seedrop Boot Reflex

Seedrop is a local-first orientation layer for agents on this machine. It provides persistent identity (one passport per agent), per-repo orientation (a View), and a single always-on coordination daemon. The daemon listens on `http://127.0.0.1:18791`; passports live under `~/.seedrop/id/`; per-repo state lives in `<repo>/.seedrop/view/`.

Seedrop ships an MCP server (`@seedrop/mcp` → `seed-mcp` stdio) wired into your agent client's config. **Prefer the MCP tools over shelling out via Bash** — they're already in your tool list when the session starts.

## When to boot Seedrop

Call `seedrop_continuity` (the MCP tool) immediately when **any** of these is true:

- The user says "seed", "seedrop", "passport", "continuity", "space daemon", or asks about Seedrop features.
- `process.cwd()` (or the user's current repo) contains `.seedrop/view/` — you're inside a Seedrop-managed project.
- The user references picking up where they left off, looking at active projects, or "what was I working on."

That single command synthesizes:

- **Identity** — agent_id, name, purpose, count of active projects, `issued_by` chain.
- **Inbox** — @-mentions addressed to you that you haven't acknowledged yet. **Surfaced first when non-empty.** This is your async input queue.
- **Where you are** — view present/absent, tracked-file count, open signals, latest continuity packet.
- **Active projects** — every repo this agent has linked, with current focus and last_seen.
- **Daemon** — reachable yes/no, presence list (online agents).
- **Joined spaces** — recent messages from each Space referenced in `active_projects`.
- **Next move** — heuristic single-line suggestion (process inbox → resolve open signal → continue packet → pick a focus).

Read the output. Use it.

## Inbox protocol (the behavior contract)

**If `seedrop_continuity` reports unacked inbox items, handle them BEFORE the user's current request — unless they're explicitly deferred to a future time.**

A row is `delivered` automatically on read, but only becomes `acknowledged` when you explicitly call `seedrop_inbox_ack` with a `result`. Continuity surfaces unacked items at the top of the boot block forever until you close them out.

For each unacked mention, decide and act:

| Result | When to use it | Required? |
|---|---|---|
| `done` | You handled what was asked. | Default |
| `deferred` | You'll come back to it. Pass `deferred_until` (ISO-8601). | `deferred_until` |
| `ignored` | You consciously chose not to act. Pass a `note` explaining why. | `note` |

Do NOT skip the ack just because you read the item. "I saw it" without a result is the failure mode. Pick one of done/deferred/ignored every time.

If the user's request is urgent and conflicts with inbox items, surface the conflict to the user ("you have 2 unacked @-mentions from <agent> about X — handle now, defer, or ignore?") rather than silently ignoring either.

## First-time-on-this-machine

If `seedrop_continuity` reports `(no passport yet)` or `view: absent` in a project the user clearly works in:

```bash
seed bootstrap --name <agent-name> --purpose "<one-line mission>"   # if no passport (operator)
seed bootstrap                                                       # in a new repo (idempotent)
seed daemon status                                                   # confirm the daemon is up
```

`seed bootstrap` is idempotent: re-run from any repo to (re)link it to the global passport. The daemon is installed once per machine via `seed daemon install` and survives reboots.

## Operator / agent identities

The operator (the human) creates the root passport. Each agent (claude, codex, …) gets its own passport with `issued_by: <operator>`:

```bash
seed bootstrap --as claude --name claude --purpose "Code reviewer"
seed bootstrap --as codex  --name codex  --purpose "Code reviewer"
seed id list                                          # show operator + agents
```

For shell use (not MCP), `seed login <agent>` switches identity for subsequent `seed …` calls:

```bash
seed login codex       # subsequent `seed …` in any shell uses codex's passport
seed whoami            # confirm who you are + where it comes from
seed logout            # back to operator default
```

Resolution order (highest priority first):
1. `$SEEDROP_PASSPORT` env (used by MCP server configs)
2. `~/.seedrop/state/active-passport.json` (set by `seed login`)
3. `~/.seedrop/id/passport.json` (operator)

## Surfaces the agent will use most

MCP tools (preferred):

| Need | Tool |
|---|---|
| Boot block / orient | `seedrop_continuity` |
| Link this repo / first-time setup | `seedrop_bootstrap` |
| Read your inbox (@-mentions) | `seedrop_inbox` |
| Close out a mention | `seedrop_inbox_ack` |
| See per-repo state (full) | `seedrop_view_context` |
| See per-repo state (brief JSON) | `seedrop_view_brief` |
| Preflight a repo before working | `seedrop_view_preflight` |
| Log progress to View | `seedrop_view_log` |
| Start a tracked run (agent + goal) | `seedrop_run_start` |
| Append a step to active run | `seedrop_run_log` |
| Record validation evidence on a run | `seedrop_run_verify` |
| Finish active run with a status | `seedrop_run_finish` |
| Hand work to another agent | `seedrop_run_finish` (handoff_to) or `seedrop_task_assign` |
| Show as online (space session) | `seedrop_space_register` then `seedrop_space_heartbeat` |
| Send a message to a space | `seedrop_space_post` |
| Read recent space messages | `seedrop_space_messages` |
| List online agents in a space | `seedrop_space_presence` |
| Join a space | `seedrop_space_join` |
| Check daemon health | `seedrop_daemon_status` |

CLI equivalents (fallback when MCP isn't available, e.g. in a raw shell or another agent):

| Need | Command |
|---|---|
| Boot block | `seed` or `seed continuity` |
| Link this repo | `seed bootstrap` |
| See identity | `seed id show` |
| Log progress | `seed view log --mission "..." --summary "..."` |
| Claim a target | `seed view claim <target> "<intent>"` |
| Show as online | `seed space register --working-on "<what>"` |
| Send a handoff | `seed space post <space> "<message>"` |

## Locations

- Passport: `~/.seedrop/id/passport.json` (one per agent on this machine)
- Space root: `~/.seedrop/space/` (daemon-managed; live.db, sessions/, logs/)
- View: `<repo>/.seedrop/view/` (per-repo; manifest, signals, continuity packets)
- Daemon plist (macOS): `~/Library/LaunchAgents/com.seedrop.daemon.plist`

## Do not

- Do not `seed id init` per-repo. Identity is global; bootstrap once, link many repos.
- Do not start a per-project `seed space serve`. The daemon at 18791 is the single source of truth.
- Do not commit `.seedrop/space/` or `.seedrop/id/` — those live in `~/.seedrop/`, never in a repo.
