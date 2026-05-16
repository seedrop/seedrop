# Seedrop Architecture

Seedrop is Memo distilled to production grade.

Memo proved that agent coordination, presence, inboxes, continuity, and file-backed knowledge are useful in real work. It also proved that unbounded subsystems, mutating background jobs, payload DMs, and database-backed "memory" become fragile quickly. Seedrop keeps the load-bearing behaviors and removes the mechanisms that made them brittle.

## Product Frame

Seedrop is agent infrastructure, not an agent brain.

It gives agents durable identity, shared coordination rooms, live reachability, pointer notifications, project orientation, and clean handoff surfaces. It does not own cognition, long-term semantic memory, embeddings, background consolidation, or autonomous mutation of durable knowledge.

The product promise:

> Any agent can enter an Seedrop-enabled environment, know who it is, see who else is present, understand the project terrain, coordinate through durable rooms and pointer notifications, and leave a clean handoff.

## Package Boundaries

### `@seedrop/id`

Answers: who is this agent?

Owns:

- passport files
- identity commitments and limits
- session reconstruction
- coherence and drift monitoring
- identity audit and write-time continuity

Does not own:

- multi-agent rooms
- live presence
- notifications
- project file orientation

### `@seedrop/space`

Answers: where are agents coordinating?

Owns:

- `Space`: named coordination contexts
- `Presence`: live reachability and heartbeat state
- `Notification`: pointer-only signals routed to passports
- HTTP transport over the bounded coordination surface
- append-only message logs
- wipeable live state in `.seedrop/space/live.db`

Does not own:

- passport creation or storage
- project indexing
- long-term memory or semantic recall
- background consolidation

The HTTP server accepts an injected identity resolver:

```typescript
createServer({
  identity: {
    resolve: async (passportId) => ({ passportId }),
  },
});
```

When no resolver is configured, the server keeps trust-only local mode. When a resolver is configured, authenticated routes verify `X-Seed-Passport` before writes. The CLI or deployment shell decides how to bind that resolver to `@seedrop/id`; `space` stays focused on coordination.

### `@seedrop/space/view`

Answers: what project terrain is this agent standing in?

Owns:

- `.seedrop/view/manifest.json`
- project orientation context
- continuity packets
- file claims and leases
- project audit signals

Does not own:

- chat history
- online presence
- durable coordination rooms
- identity passports

`view` is a per-project substrate. `space` can point to `view` artifacts, but it should not duplicate project state.

### Future `@seedrop/cli`

Answers: how do humans and agents operate Seedrop from a shell?

Owns the top-level `seed` binary and routes commands across packages:

```bash
seed id ...
seed space ...
seed view ...
```

Until this package exists, package-local binaries such as `seed-space` are acceptable.

## Memo Mapping

| Memo behavior | Seedrop home | Rule |
|---|---|---|
| workspace | `Space` | Durable room, append-only messages |
| online agents | `Presence` | Live, expiring, wipeable |
| inbox / DM | `Notification` | Pointer-only, no payload store |
| continuity / context | `View` | Per-project orientation and handoff |
| identity assumptions | `@seedrop/id` | Passport-owned |
| DB-backed memory | mostly killed | Durable files win |
| sprawling API | bounded APIs | Add only under slice discipline |

## Durability Rules

- Files are durable.
- SQLite live state is wipeable.
- Messages are append-only.
- Notifications are pointer events, not payload stores.
- Acks are append events, not in-place mutation.
- Background jobs must not mutate durable knowledge.
- Smoke tests protect the full loop.

The critical invariant:

> `rm .seedrop/space/live.db` must lose zero durable knowledge.

## Design Guardrail

At every design fork, ask:

> Did Memo prove this behavior is load-bearing, or are we smuggling back complexity because it feels impressive?

If load-bearing, rebuild it cleanly.

If merely impressive, cut it.
