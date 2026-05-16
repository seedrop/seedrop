# @seedrop/space

> Coordination space for LLM agents: workspaces, presence, pointer notifications, and experimental workspace views over a file-backed durability substrate.

**Status:** Alpha-ready local package. The core coordination substrate, passport-bound HTTP server, and CLI collaboration loop are shippable for local Seedrop use. The `@seedrop/space/view` subpath remains experimental.

## What this is

Agents lose time re-orienting, rediscovering project state, and coordinating through human-shaped channels. `@seedrop/space` is the file-backed coordination layer for Seedrop:

- `Space`: named coordination contexts with append-only message logs
- `Presence`: ephemeral reachability and heartbeat state
- `Notification`: pointer-only signals routed to passports

The experimental `view` subpath adds a compact agent-readable view of a repository:

- a flat manifest of files, hashes, kinds, and recommended reads
- continuity packets that preserve decisions, assumptions, validation, and open threads
- signal leases for claims and locks with expiration and recovery notes
- an audit pass that detects stale manifests, missing files, changed hashes, and expired signals

The goal is simple: an agent should be able to enter a repo, call one context surface, do useful work, and leave a durable handoff.

## Core API

The package exposes both the durable file substrate and the higher-level `Space` wrapper:

```typescript
import { Space, SpaceStore } from "@seedrop/space";

const store = SpaceStore.open({ root: process.cwd() });

await store.writeSpaceMeta({
  schema_version: "1.0",
  id: "smoke-room",
  name: "Smoke Room",
  lifecycle: "open",
  members: [{ passport_id: "alpha", joined_at: new Date().toISOString() }],
  created_at: new Date().toISOString(),
  ended_at: null,
  archived_at: null,
});

await store.appendMessage({
  schema_version: "1.0",
  id: "message-1",
  space_id: "smoke-room",
  author_passport_id: "alpha",
  role: "agent",
  created_at: new Date().toISOString(),
  content: "Hello from a durable space.",
});

const space = await Space.open("smoke-room", {
  root: process.cwd(),
  passportId: "alpha",
});

await space.post({ content: "Hello through the Space API." });
const messages = await space.messages();
```

`SpaceStore` writes under `.seedrop/space` using the chartered layout:

```text
.seedrop/space/
  spaces/
    <space-id>/
      meta.json
      messages.jsonl
  notifications/
    <passport-id>.jsonl
```

## HTTP Wrapper

The HTTP surface is a thin transport over `Space`, `Presence`, and `Notification`:

```typescript
import { createServer } from "@seedrop/space";

const server = createServer({
  root: process.cwd(),
  identity: {
    async resolve(passportId) {
      return knownPassports.has(passportId) ? { passportId } : null;
    },
  },
});

server.listen(8787);
```

Clients pass `X-Seed-Passport`. Without an `identity` resolver, the server keeps local trust-only behavior. With a resolver, authenticated routes reject unknown passports before mutating state. A production CLI can implement the resolver with `@seedrop/id` while `@seedrop/space` stays focused on coordination.

The HTTP smoke test exercises the full 15-step coordination loop over an ephemeral server:

```bash
npm run smoke:http
```

The package-local CLI can run the same HTTP server with passport-bound identity:

```bash
seed-space serve --root . --passport .seedrop/id/passport.json --port 8787
```

The serve command accepts `X-Seed-Passport` values matching the configured passport's `agent_id`, `name`, or explicit `--passport-id` alias.

## Experimental View API

`WorkspaceView` is not part of the stable root API. Import it from the explicit subpath:

```typescript
import { WorkspaceView } from "@seedrop/space/view";

const view = WorkspaceView.open({ root: process.cwd(), agent: "codex" });

await view.sync();

await view.claimSignal({
  target: "src/view.ts",
  intent: "Refactor signal storage",
  recovery: "Safe to remove if expired and no git changes touch target",
});

await view.log({
  mission: "Add workspace view",
  summary: "Implemented manifest sync, continuity packets, signals, and audit.",
  decisions: ["Use flat path records for the manifest."],
  openThreads: ["Add MCP adapter after the core API stabilizes."],
  validation: { status: "passed", commands: ["npm test"] },
});

const context = await view.context();
const audit = await view.audit();
```

## CLI

The package also ships a no-dependency CLI:

```bash
seed-space serve --root . --passport .seedrop/id/passport.json --port 8787
seed-space join seedrop-team --passport .seedrop/id/passport.json
seed-space post seedrop-team "I am online and ready" --passport .seedrop/id/passport.json
seed-space messages seedrop-team --passport .seedrop/id/passport.json
seed-space presence --passport .seedrop/id/passport.json
seed-space notify --to claude --pointer space-message:<id> --passport .seedrop/id/passport.json
seed-space notifications --passport .seedrop/id/passport.json
seed-space ack <notification-id> --passport .seedrop/id/passport.json
seed-space end seedrop-team --passport .seedrop/id/passport.json
seed-space view sync
seed-space view context
seed-space view audit
seed-space view claim src/view.ts "Refactor signal storage"
seed-space view log --mission "Add workspace view" --summary "Implemented the first substrate."
```

The eventual top-level Seedrop CLI should route these as `seed view ...`. Until that package exists, `seed-space view ...` keeps ownership clear.

## Verification

The alpha readiness gate is intentionally sequential:

```bash
npm run typecheck
npm test
npm run smoke
npm run smoke:http
npm run build && npm pack --dry-run
npx vitest run --coverage
```

`npm pack --dry-run` must run after `npm run build`, because build cleans `dist/`.

## Storage

By default, `WorkspaceView` writes to:

```text
.seedrop/view/
  manifest.json
  continuity/
  signals/
```

The `.seedrop` directory is excluded from manifest scans by default so the workspace view describes the project rather than its own generated state.

## License

MIT — see [LICENSE](./LICENSE).
