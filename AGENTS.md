# Seedrop Agent Onboarding

> Identity is persistent and per-agent. View is persistent and per-repo. Space is a single always-on daemon. New project = `seed view init`. New machine = `seed bootstrap`.

## What Seedrop is today

A local-first orientation layer for repos worked on by agents. Today's surface is **macOS + Node 20+**, with **MCP** for agent clients (Claude Code, Codex, Kilo, …) and **launchctl** managing the always-on daemon. Cross-platform support (Linux, Windows) and non-MCP integrations are on the roadmap, not in the current release.

It is the layer that lets an agent say:

- who it is (one passport per agent on this machine)
- which projects it is working on (linked from the passport)
- what orientation already exists for a project (per-repo View)
- where other agents left the work (durable workspace messages)
- what should happen next (continuity pointers, claims, signals)

## Concepts

### Key Abstractions

| Concept | Location | Lifecycle | When to use it |
|---------|----------|-----------|----------------|
| ID      | `~/.seedrop/id/passport.json` | One per agent, machine-wide | Identity, active projects, continuity, credential refs |
| View    | `<repo>/.seedrop/view/`       | One per repo                | Orientation, claims, locks, validation log            |
| Space   | `~/.seedrop/space/` (daemon)  | One daemon, machine-wide    | Multi-agent chat, presence, notifications             |
| CLI     | `@seedrop/cli` (`seed`)   | —                           | Single command surface for all three                  |

The defaults make the boundaries strict: **identity does not live in a repo**, and **space data does not live in a repo**. Only the View belongs in the repo, where humans can commit it for handoff.

### Defaults

| Env var              | Default                                  |
|----------------------|------------------------------------------|
| `SEEDROP_PASSPORT`     | `~/.seedrop/id/passport.json`              |
| `SEEDROP_SPACE_ROOT`   | `~/.seedrop/space`                         |
| `SEEDROP_SPACE_URL`    | `http://127.0.0.1:18791`                 |

## Boot Ritual

### Getting the `seed` CLI on PATH

Until packages are published, install from this workspace:

```bash
git clone <repo> && cd seedrop
npm install
npm run link            # symlinks `seed` + `seed-mcp` + `seed-id` into your global bin
seed help               # confirm it's on PATH
```

`npm run unlink` reverses the symlinks. Once published to npm, this section becomes `npm install -g @seedrop/cli`.

### Dev loop — source-first

`seed`, `seed-mcp`, and `seed-id` are launched via `tsx` from their workspace's `src/`. Edits to `cli/src/*` or `mcp/src/*` are reflected immediately on the next invocation — no build step required.

Edits to `space/src/*` or `id/src/*` (the libraries consumed by cli/mcp via `@seedrop/space` and `@seedrop/id`) **do** require a rebuild of those workspaces, because cross-workspace imports still resolve through each workspace's `dist/` entrypoint:

```bash
npm run build -w space   # after editing space/src/*
npm run build -w id      # after editing id/src/*
```

Startup overhead from tsx is ~60ms vs running compiled dist directly, measured cold. `npm run build -ws` still produces dist artifacts for release tarballs.

### First time on this machine

```bash
seed bootstrap --name claude --purpose "Build Seedrop"
seed daemon install     # writes ~/Library/LaunchAgents/com.seedrop.daemon.plist and starts it
seed daemon status      # confirm state=running
```

This creates `~/.seedrop/id/passport.json`, ensures `~/.seedrop/space/` exists, links the current repo (if not `$HOME`), and starts the always-on daemon.

### Every new repo

```bash
cd <repo>
seed bootstrap          # idempotent — re-links cwd, no name/purpose needed
```

Equivalent shorter form when you only need orientation (no daemon, no identity creation):

```bash
seed view init          # uses default passport, creates .seedrop/view in cwd
seed view context
```

### Every session

```bash
seed id show            # confirm identity + active_projects count
seed view context       # confirm where you left off in this repo
seed space messages seedrop-team   # catch up on any handoffs
```

No `id init` per repo. No `space serve` per repo. The daemon is already running.

## What To Record Where

**ID** (`~/.seedrop/id/passport.json`) — durable self-state:
- agent name and stable passport id
- active projects (one entry per repo you've linked)
- current focus
- references to credentials or local resources
- continuity pointers that help the same agent resume later

Do not store raw secrets in the passport. Store references to where credentials are managed.

**View** (`<repo>/.seedrop/view/`) — durable project orientation:
- mission summaries
- assumptions, decisions
- open threads
- changed paths
- validation commands and results
- claims and locks for files or work areas

**Space** (`~/.seedrop/space/` via the daemon) — live coordination:
- workspace chat (durable)
- live presence (TTL'd)
- direct pointer notifications
- multi-agent handoffs

## Core Flows

Project orientation:

```bash
seed view init --role builder --current-focus "<mission>"
seed view log --mission "<mission>" --summary "<what changed>" --validation-status passed --validation-command "<command>"
```

Collision avoidance:

```bash
seed view claim <target> "<intent>"
seed view signals
seed view release --target <target>
```

Space coordination (daemon must be running):

```bash
seed space join seedrop-team
seed space post seedrop-team "<message>"
seed space messages seedrop-team
```

Notifications:

```bash
seed space notify --to <passport-id> --pointer space-message:<message-id>
seed space notifications
seed space ack <notification-id>
```

Presence (live sessions, TTL'd) is separate from membership (durable). To appear in `seed space presence`, register a session and keep it warm:

```bash
seed space register --working-on "<what you are doing>"   # cached at ~/.seedrop/space/sessions/<passport>.json
seed space heartbeat --working-on "<update>"              # before TTL (60s by default)
seed space presence                                        # see online agents
```

Membership comes from `seed space join` and persists; presence is the live signal layered on top.

## Daemon Management

```bash
seed daemon install     # write plist + launchctl bootstrap
seed daemon status      # state, pid
seed daemon uninstall   # launchctl bootout + remove plist
tail -f ~/.seedrop/space/logs/{out,err}.log
```

The daemon binds to `127.0.0.1:18791` by default, reads passports from `~/.seedrop/id/passport.json`, and stores live coordination state in `~/.seedrop/space/`.

## Production Hygiene

Before handoff, make source state, view state, and space state agree.

1. Check git status in the package repo you touched.
2. Run the relevant package gates.
3. Record validation in View (`seed view log`).
4. Post a concise handoff to Space if another agent is involved.
5. Commit package changes when the slice is coherent.

Package gates:

```bash
cd id    && npm run typecheck && npm test && npm run build
cd space && npm run typecheck && npm test && npm run smoke && npm run smoke:http && npm run build
cd cli   && npm run typecheck && npm test && npm run smoke && npm run smoke:install && npm run build
```

Generated local state under `<repo>/.seedrop/view/` is the only Seed artifact that belongs in the repo. Everything else lives in `~/.seedrop/`.
