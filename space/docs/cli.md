# Seedrop CLI Shape

The long-term CLI should be a single top-level `seed` binary.

```bash
seed <domain> <command> [options]
```

The CLI is a routing and ergonomics layer. Package APIs remain the source of truth.

## Namespaces

### `seed id`

Identity and passport operations.

Intended shape:

```bash
seed id validate ./passport.json
seed id status ./passport.json
seed id repair ./passport.json
seed id session start ./passport.json
seed id session commit ./passport.json
seed id audit ./passport.json
```

Owned by `@seedrop/id` or a future top-level CLI adapter that calls it.

### `seed space`

Coordination rooms, presence, and notifications.

Intended shape:

```bash
seed space join seedrop-team --passport alpha
seed space post seedrop-team "message" --passport alpha
seed space messages seedrop-team
seed space presence
seed space notify beta --ref space:seedrop-team/message-1
seed space notifications --passport beta
seed space ack notification-id --passport beta
seed space smoke
```

Owned by `@seedrop/space`.

### `seed view`

Per-project orientation and handoff.

Intended shape:

```bash
seed view init
seed view sync
seed view context
seed view audit
seed view claim src/space.ts "Implement Slice 4 notifications"
seed view release --id claim-id
seed view log --mission "Slice 4" --summary "Notifications landed"
```

`seed view brief`, `seed view context`, and `seed view preflight` report a View success level:
`L0 Missing`, `L1 Present`, `L2 Useful`, `L3 Active`, or `L4 Handoff-Ready`.
Repositories can set `required_success_level`, `freshness_ttl_hours`, `ignore`, and `path_purposes` in `.seedrop/view/policy.json`.

Backed by the experimental `@seedrop/space/view` subpath for now.

## Current Transitional CLI

Until `@seedrop/cli` exists, `@seedrop/space` exposes:

```bash
seed-space view <command>
```

Example:

```bash
seed-space view sync
seed-space view context
seed-space view audit
```

Flat alpha aliases like `seed-space sync` may exist temporarily, but docs should prefer the namespaced form.

`@seedrop/id` exposes:

```bash
seed-id status --passport ./passport.json
seed-id repair --passport ./passport.json
```

## CLI Principles

- Prefer one stable noun before the verb: `seed view sync`, not `seed sync-view`.
- Keep commands thin over package APIs.
- Avoid hidden background mutation.
- Default to JSON output for agent-facing commands when practical.
- Human-readable output is fine for smoke and status commands.
- The CLI must not introduce a broader API surface than the package supports.
- If a command cannot be explained as `id`, `space`, or `view`, it probably belongs elsewhere.

## CI Commands

The current production-grade gate for `@seedrop/space` should stay sequential:

```bash
npm run typecheck
npm test
npm run smoke
npm run smoke:http
npm run build && npm pack --dry-run
npx vitest run --coverage
```

`npm pack --dry-run` must run after `npm run build`, because build cleans `dist`.
