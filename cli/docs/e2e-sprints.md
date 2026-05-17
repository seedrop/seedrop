# Seedrop E2E Flow Plan

This plan turns Seedrop from three working packages into one usable local agent environment.

The rule for every sprint: a flow is not done until it works through the top-level `seed` CLI in a local smoke test. Package APIs may land first, but the user-facing flow is only complete when the CLI path is green.

## Target E2E

A fresh local user should be able to run:

```bash
seed id init --name codex --purpose "Help build Seedrop"
seed id validate .seedrop/id/passport.json
seed view init --passport .seedrop/id/passport.json
seed view sync
seed view context
seed space serve --root . --passport .seedrop/id/passport.json
seed space join seedrop-team --passport codex
seed space post seedrop-team "I am online and ready to coordinate" --passport codex
seed space messages seedrop-team --passport codex
```

That is the minimum launch loop: create identity, orient to a project, start coordination, join a room, write/read a durable message.

## Current State

Working today:

- `@seedrop/id`
  - passport schema, load/save, sessions
  - audited `commitSession({ write: true })`
  - repair journal
  - `seed-id init/validate/show/audit`
  - `seed-id project link`
  - `seed-id status`
  - `seed-id repair`
- `@seedrop/space`
  - TypeScript APIs for `Space`, `Presence`, `Notification`
  - HTTP wrapper with identity resolver injection
  - experimental `WorkspaceView`
  - `seed-space serve ...`
  - `seed-space join/post/messages/presence/notify/notifications/ack/end`
  - `seed-space view ...`
- `@seedrop/cli`
  - `seed id ...` delegates to `seed-id`
  - `seed view init --passport ...` initializes view and links the passport active project
  - `seed space serve ...` delegates to passport-bound `seed-space serve`
  - `seed view ...` delegates to `seed-space view ...`
  - `seed space view ...` delegates to `seed-space view ...`
  - composition smoke across built local binaries

Missing:

- release/readiness sweep for the next alpha tags

## Sprint 1 — Identity First Run

Goal: a new agent can create, inspect, and repair its passport from `seed`.

### Commands

```bash
seed id init --name codex --purpose "Help build Seedrop"
seed id validate .seedrop/id/passport.json
seed id show .seedrop/id/passport.json
seed id status .seedrop/id/passport.json
seed id repair .seedrop/id/passport.json
```

### Package Work

`@seedrop/id`

- Add `seed-id init`.
- Add `seed-id validate`.
- Add `seed-id show`.
- Add `seed-id audit`.
- Keep `seed-id status/repair`.
- Create `.seedrop/id/passport.json` by default.
- Support `--out <path>` for custom passport path.
- Refuse overwrite unless `--force` is passed.
- Generate stable minimal passport:
  - `version`
  - `agent_id`
  - `name`
  - `purpose`
  - `core_commitments`
  - `value_anchors`
  - `competencies`
  - `limits`
  - `learned_blocks`
  - `active_projects`
  - `credential_refs`
  - `continuity`
  - `metadata.created_at`
  - `metadata.session_count`

`@seedrop/cli`

- Route `seed id init|validate|show|audit`.
- Keep positional normalization:
  - `seed id validate passport.json` -> `seed-id validate --passport passport.json`
  - `seed id show passport.json` -> `seed-id show --passport passport.json`
  - `seed id audit passport.json` -> `seed-id audit --passport passport.json`

### Acceptance

Local smoke creates a temp project and proves:

```bash
seed id init --name codex --purpose "Test agent" --out <temp>/.seedrop/id/passport.json
seed id validate <temp>/.seedrop/id/passport.json
seed id show <temp>/.seedrop/id/passport.json --json
seed id status <temp>/.seedrop/id/passport.json
seed id repair <temp>/.seedrop/id/passport.json
```

Required gates:

```bash
cd /Users/mc/Projects/seedrop/id
npm run typecheck
npm test
npm run build && npm pack --dry-run

cd /Users/mc/Projects/seedrop/cli
npm run typecheck
npm test
npm run build
npm run smoke
npm pack --dry-run
```

## Sprint 2 — Project Orientation And Space Serve

Goal: a passport can attach to a project view, and the top-level CLI can start the coordination server with identity binding.

### Commands

```bash
seed view init --passport .seedrop/id/passport.json
seed view sync
seed view context
seed view audit
seed space serve --root . --passport .seedrop/id/passport.json
```

### Package Work

`@seedrop/id`

- Add helper to add/update one `active_projects` entry.
- Ensure the update goes through audited write semantics.
- Preserve repair journal behavior.

`@seedrop/space`

- Add package-local server CLI or exported server runner:
  - `seed-space serve --root . --passport <path> --port <port>`
- Use `createServer({ identity })`.
- Identity resolver should:
  - validate the configured passport file
  - accept `X-Seedrop-Passport` values matching passport `agent_id`, passport `name`, or explicit `--passport-id`

`@seedrop/cli`

- Route:
  - `seed space serve ...` -> package-local server command
  - `seed view init --passport ...` -> view init plus passport active project update

### Acceptance

Local smoke proves:

```bash
seed id init --name codex --purpose "Test agent" --out <temp>/.seedrop/id/passport.json
seed view init --root <temp> --passport <temp>/.seedrop/id/passport.json
seed view sync --root <temp>
seed view context --root <temp>
seed space serve --root <temp> --passport <temp>/.seedrop/id/passport.json --port 0
```

Server smoke must verify:

- server starts on an available port
- `/sessions` accepts the configured passport
- `/sessions` rejects an unknown passport
- `live.db` can be wiped without losing view or space files through the existing `@seedrop/space` smoke

Required gates:

```bash
cd /Users/mc/Projects/seedrop/id
npm run typecheck
npm test
npm run build && npm pack --dry-run

cd /Users/mc/Projects/seedrop/space
npm run typecheck
npm test
npm run smoke
npm run smoke:http
npm run build && npm pack --dry-run

cd /Users/mc/Projects/seedrop/cli
npm run typecheck
npm test
npm run build
npm run smoke
npm pack --dry-run
```

## Sprint 3 — Collaboration Commands

Goal: the collaboration loop works through `seed space ...`, not only through TypeScript or HTTP internals.

### Commands

```bash
seed space join seedrop-team --passport .seedrop/id/passport.json
seed space post seedrop-team "message" --passport .seedrop/id/passport.json
seed space messages seedrop-team --passport .seedrop/id/passport.json
seed space presence --passport .seedrop/id/passport.json
seed space notify --to claude --pointer space-message:<message-id> --passport .seedrop/id/passport.json
seed space notifications --passport .seedrop/id/claude.passport.json
seed space ack <notification-id> --passport .seedrop/id/claude.passport.json
seed space end seedrop-team --passport .seedrop/id/passport.json
```

### Package Work

`@seedrop/space`

- Add package-local CLI commands over either:
- HTTP client against `seed space serve`.
- Add `--json` output for agent-facing commands.
- Keep human-readable output concise by default.

`@seedrop/cli`

- Route `seed space join|post|messages|presence|notify|notifications|ack|end`.
- Add composition smoke over the real package-local commands.

### Acceptance

One local smoke must prove the full loop:

```bash
seed id init --name codex --purpose "Test agent" --out <temp>/codex.passport.json
seed id init --name claude --purpose "Test agent" --out <temp>/claude.passport.json
seed view init --root <temp> --passport <temp>/codex.passport.json
seed view sync --root <temp>
seed space serve --root <temp> --passport <temp>/codex.passport.json --passport <temp>/claude.passport.json --port 0
seed space join seedrop-team --url <server> --passport <temp>/codex.passport.json
seed space join seedrop-team --url <server> --passport <temp>/claude.passport.json
seed space post seedrop-team "hello claude" --url <server> --passport <temp>/codex.passport.json
seed space messages seedrop-team --url <server> --passport <temp>/claude.passport.json
seed space notify --to claude --pointer space-message:<message-id> --url <server> --passport <temp>/codex.passport.json
seed space notifications --url <server> --passport <temp>/claude.passport.json
seed space ack <notification-id> --url <server> --passport <temp>/claude.passport.json
seed space end seedrop-team --url <server> --passport <temp>/codex.passport.json
```

The smoke must assert:

- both passports validate
- view context exists
- space message is durable
- notification appears for `claude`
- ack removes it from active notification list
- ended space still replays messages
- wiping `.seedrop/space/live.db` loses no durable content

## Deferred Until After These Sprints

- Legacy Memo importer:

```bash
seed migrate memo --from /Users/mc/Projects/memo --to .
```

Reason: useful, but not needed for the first local launch loop and it touches real legacy data.

- Rich `seed context` command that combines:
  - passport summary
  - active project refs
  - view context
  - space/presence pointers
  - latest handoff

Reason: easier to design after Sprints 1-3 prove the underlying flows.

## Launch Definition

The local alpha is launchable when:

- Sprint 1 smoke passes.
- Sprint 2 smoke passes.
- Sprint 3 smoke passes.
- All three package gates pass.
- README examples only show commands that actually exist.
- No feature requires editing JSON by hand for the happy path.
