# @seedrop/space — Charter

**Status:** Alpha charter, slices 1-6 implemented as of 2026-05-14
**Author:** mc + claude
**Source material:** `/Users/mc/Projects/memo/research/memo-break-report-2026-05-13.md` (the deep-dive that motivated the fork)

---

## Why this exists

The legacy memo system at `/Users/mc/Projects/memo/` extended for 37 sprints and regressed badly: 99.5% of its memory rows soft-deleted by a misconfigured decay job, router crash-looping, injection daemons orphaned, workspaces accumulating without lifecycle, event inbox write-only. The failures compounded because every sprint added new subsystems without hardening the ones already there. None of the subsystems crossed a "would-be-painful-to-lose" threshold for a real user before more were piled on top.

The deep-dive surfaced one structural insight: **the durable knowledge survived the mass-delete because it lived in files (`knowledge/*.md`, sprint logs, decisions). The SQLite memory layer — which was supposed to be the "memory" of the system — was theater.** When decay vaporized 99.5% of it, the project barely flinched. The file tree was load-bearing all along.

`@seedrop/space` is a clean re-implementation of the *coordination* layer from memo, with three rules baked in from the start:

1. **Files are the durability substrate.** SQLite holds only ephemeral live state that can be wiped without data loss.
2. **The API surface is bounded.** ~8 HTTP endpoints. No new ones without removing one first.
3. **A daily smoke test proves the three pillars work end-to-end.** If it fails, no slice ships.

---

## The three pillars

### 1. Space — named coordination context

A `Space` is a named room two or more agents enter to coordinate. It has:

- A name (human-readable, used for fuzzy-matching) and an id (stable, used for refs)
- A membership list (which passports are currently in the room)
- An append-only message log
- A lifecycle: `open → active → ended → archived`
- A creation timestamp and an `ended_at` (nullable)

A `Space` is **not** a chat history. The messages are the durable artifact, but the *point* of a space is to leave a trail a third agent can reconstruct later. Sprint planning happens in a space. A negotiation happens in a space. A handoff happens in a space.

### 2. Presence — who is online

Presence answers two questions:

- Which agents are reachable right now?
- What are they working on?

Presence is **live state**. It expires. It is the only pillar that requires SQLite, because heartbeats are high-frequency writes and "is X online" needs an index.

A passport heartbeats into presence. If it stops heartbeating for N minutes, it falls offline. There is no soft-delete, no decay, no archive — presence is either current or it doesn't exist.

### 3. Notification — pointer-based signal

A notification is **not a DM**. A DM carries payload; a notification carries a pointer.

A notification says: "go look at space X / file Y / card Z, something happened that concerns you." The content lives at the source. The notification dies on read or on TTL.

This distinction matters because the legacy memo had 80KB of orphaned `undefined.pending` messages and 62 unread DMs to ghost agents. Pointers can't be orphaned in the same way — if the source is gone, the notification harmlessly resolves to nothing on fetch.

Notifications are routed to **passports**, not agent names. If hermes-the-Research-Synthesist is running on a different machine tomorrow, the notification still finds them. Identity follows the role.

---

## Non-pillars — things `@seedrop/space` does NOT do

Explicitly out of scope. Future packages may own these; this one does not.

| Concern | Owner | Why not here |
|---|---|---|
| Identity / passport | `@seedrop/id` | Already shipped (slice 1). `Space` consumes passports; it doesn't manufacture them. |
| Long-term memory / recall | `@seedrop/memory` (future) | A space is a coordination context, not a memory store. Messages are durable because the file is; the space doesn't "remember." |
| Embeddings / semantic search | not in seedrop | Use a dedicated tool (vector DB, search index) over the file tree if needed. Files are greppable. |
| LLM-backed consolidation | not in seedrop | This was a major source of degradation in legacy memo (Ollama timeouts). Out of scope. |
| Multi-machine federation | not in v0.1 | A v1+ concern. Single-host first. |
| Real-time push to terminals | not in v0.1 | Polling is fine. Push is premature optimization that broke the legacy router. |

---

## Durability model

```text
project-root/.seedrop/space/
├── spaces/
│   ├── <space-id>/
│   │   ├── meta.json           # name, members, lifecycle, timestamps
│   │   └── messages.jsonl      # append-only log, one JSON per line
│   └── ...
├── notifications/
│   └── <passport-id>.jsonl     # append-only per-passport queue, with ack markers
└── live.db                     # SQLite - sessions, presence, ephemeral state only
```

Rules:

- **Content writes go to files.** Never to SQLite.
- **`live.db` is wipeable.** A `rm live.db` should lose nothing important. Agents re-register and resume.
- **Messages are append-only.** Edits are new messages with a `replaces` field. Deletes are tombstone messages. No in-place mutation.
- **One process writes per file.** Concurrency is handled by funneling writes through a single in-process queue per file. No file locks needed in v0.1.
- **Files are UTF-8 plaintext.** JSON or markdown. No binary formats.

---

## API surface — the hard cap

### TypeScript API (the package's main export)

```typescript
class Space {
  static open(name: string, opts: SpaceOpenOpts): Promise<Space>;
  static join(name: string, opts: SpaceJoinOpts): Promise<Space>;
  static list(opts?: SpaceListOpts): Promise<SpaceMeta[]>;
  post(message: MessageInput): Promise<Message>;
  messages(opts?: MessagesOpts): Promise<Message[]>;
  members(): Promise<Member[]>;
  leave(): Promise<void>;
  end(): Promise<void>;
}

class Presence {
  static register(opts: PresenceRegisterOpts): Promise<Session>;
  static heartbeat(opts: HeartbeatOpts): Promise<void>;
  static list(): Promise<Presence[]>;
}

class Notification {
  static send(opts: NotificationSendOpts): Promise<Notification>;
  static list(opts: NotificationListOpts): Promise<Notification[]>;
  static ack(opts: NotificationAckOpts): Promise<void>;
}
```

### HTTP surface — exactly 8 routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions` | Register a session (binds passport, returns session_id) |
| `POST` | `/presence/heartbeat` | Update heartbeat for a session |
| `GET` | `/presence` | List who's online |
| `POST` | `/spaces/:name/join` | Open or join a space |
| `GET` | `/spaces/:name/messages` | Read message log (paginated by cursor) |
| `POST` | `/spaces/:name/messages` | Post a message |
| `POST` | `/spaces/:name/end` | End the space lifecycle |
| `GET` | `/notifications` + `POST /notifications` + `POST /notifications/:id/ack` | (count as one — the notification trio) |

If we need a 9th route, we remove one first. No exceptions.

---

## What we are NOT carrying over from legacy memo

The deletion list. Each item is explicitly *not* in scope, with the reason.

| Killed | Why |
|---|---|
| Memory decay engine | Caused the 2026-05-13 mass-delete. No equivalent here. |
| ANN / semantic recall | Theater. Files are greppable. |
| LLM-backed consolidation | Ollama timeouts; degraded quality. Out of scope. |
| Obsidian sync | Already killed in legacy Sprint 37. Stays dead. |
| DMs as a payload primitive | Replaced by notifications (pointers) + small spaces. |
| Event inbox | Notifications subsume the use case. |
| Router + injection daemons | Polling is sufficient for v0.1. |
| Bridge federation | Single-host first. Federate later if real demand. |
| Compat shim endpoints | Single API. No legacy URL paths. |
| Compliance gates layered three deep | Collapsed to one boundary check at the HTTP/TS API edge. |
| Sprint-claim / done / verify endpoints | These are file edits on markdown. CLI tool, not HTTP. |
| Passport assignment | `@seedrop/id` owns this. |
| Checkpoint write-to-DB | Checkpoints are markdown files. `@seedrop/space` doesn't write them. |

---

## The daily smoke test

This is the system's heartbeat. It runs every 24h in CI and locally on demand. If it fails, no slice ships until it's green again.

Run it locally with `npm run smoke`. The HTTP wrapper has a parallel smoke gate at `npm run smoke:http`.

The test, in order:

1. Wipe a temp test dir; `rm -rf` the test space root.
2. Register a passport `alpha` with a session.
3. Register a passport `beta` with a session.
4. `alpha` opens a space `smoke-test-room`.
5. `beta` joins the space.
6. `alpha` posts a message.
7. `beta` reads the message; verify content + ordering.
8. `alpha` sends a notification to `beta` pointing at the message.
9. `beta` lists notifications; verify exactly one with the right pointer.
10. `beta` acks the notification.
11. `beta` lists again; verify zero notifications.
12. `alpha` ends the space.
13. List spaces; verify `smoke-test-room` is `ended`.
14. Restart the daemon (in-process); verify the message log is still readable.
15. Wipe `live.db`; re-register `alpha` and `beta`; verify the message log is still readable.

Step 15 is the killer test. It proves the durability model holds: live state can vanish without taking content with it.

---

## Slice plan

| # | Ships | Ship-criterion | Rollback |
|---|---|---|---|
| 0 | Scaffold | `npm run typecheck` passes; `npm test` passes (no tests yet, exit 0) | n/a — empty package |
| 1 | Zod schemas + file I/O for `Space`, `Message`, `Notification`, `Session` | 100% line coverage on `src/schema.ts` and `src/io.ts`; round-trip property tests pass | Revert commit |
| 2 | Workspace operations over file-backed store | Smoke test steps 4–7 + 12–14 pass in isolation | Revert commit |
| 3 | Presence + heartbeat (SQLite slice) | Smoke test steps 2–3 + 15 pass | Revert commit; wipe `live.db` |
| 4 | Notifications (pointer-only, TTL, ack) | Smoke test steps 8–11 pass | Revert commit |
| 5 | HTTP wrapper exposing the above | Full smoke test passes end-to-end against the HTTP server | Stop the server; revert commit |
| 6 | `@seedrop/id` integration — session binds to passport | Integration test: session refuses registration without a valid passport | Revert commit |
| 7 | Legacy migration tool — read old memo SQLite, emit files | Golden-file test on a real legacy dump; round-trips a known sprint workspace | Revert commit; legacy data untouched (read-only) |

One slice in flight at a time. No skipping. No combining.

Slices 1-6 are implemented for the alpha substrate. Slice 7, the legacy memo migration tool, is intentionally separate because it touches real legacy data and is not required for the substrate cut.

---

## What success looks like at v0.1.0

- Public on GitHub under MIT
- Published to npm as `@seedrop/space`
- README explains the three pillars and the durability model in under two minutes of reading
- A single user can install the package, run the smoke gates, and start the HTTP wrapper from a tiny Node script
- The daily smoke test has run green for 14 consecutive days before tagging v0.1.0
- Legacy memo workflows have an explicit migration path before v0.1.0
- No subsystem in v0.1.0 has more than one owner — clear blast radius for any bug

---

## What success does NOT look like

- A larger API surface than this charter specifies
- A SQLite schema with more than three tables (sessions, presence, notification_routing)
- Any background job that mutates content (decay, consolidation, etc.) — none of these exist by design
- A "v0.2 will add X" list that exceeds five items — if it's longer, we got distracted
- Re-introduction of any item from the deletion list above

If we drift toward any of these, return to this charter before writing more code.
