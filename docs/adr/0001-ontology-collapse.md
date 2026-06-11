# ADR 0001 — Collapse the coordination ontology before npm publish

- **Status:** accepted — **implemented 2026-06-11**
- **Date:** 2026-06-10
- **Deciders:** mc (operator), claude (author)
- **Tracking:** task `dcb76555`; blocks ship task `2cb887f3`

> **Outcome (realized).** Shipped in v0.2.0-alpha.1. The three folds landed: handoffs → assigned tasks, threads → ownerless tasks, orientation tiers (boot/focus/budgeted context). The surface went from **72 CLI / 54 MCP → 66 CLI / 45 MCP** (run `seed capabilities` for the live count). The further reduction toward ~34 MCP tools via Space/Meta verb-grouping is **deferred** per the follow-up note below; everything in this document below the metadata describes the design as decided, not a pending state.

## Context

Seedrop exposes **72 CLI commands and 54 MCP tools** across five-plus
coordination primitives: signals (claims + locks), runs, tasks, handoffs, and
threads — plus orientation read surfaces (boot, continuity, focus, view brief,
view context). The 2026-06-09 self-audit found that an agent must learn an
ontology with overlapping semantics:

- a **handoff** is approximately a task with a recipient and a payload;
- a **thread** is approximately a task with no owner;
- **continuity**, **boot**, **focus**, **view brief**, and **view context**
  are five reads over the same state at different zoom levels.

For MCP clients without deferred tool loading, every session pays the full
`ListTools` schema payload for all 54 tools. The npm publish (task `2cb887f3`)
would freeze this surface: external users make every noun a compatibility
obligation. This is the last cheap moment to subtract.

Constraint honored throughout: **no TaskSchema extension** (standing soak
decision, 2026-05-18). Every fold below uses fields the schema already has.

## Decision

Collapse to **three coordination primitives** plus identity:

| Primitive | Role | Survives as |
| --- | --- | --- |
| **Task** | Any unit of intent: queued work, an assigned handoff, an unowned question | `tasks/` (unchanged schema) |
| **Run** | The work spine: tracked execution with steps, validation, decisions, changed paths | `runs/` (unchanged) |
| **Signal** | The concurrency layer: time-leased claims/locks on paths | `signals/` + `signals-archive.json` |

### Fold 1: handoffs → tasks

A handoff becomes `task create` + `task assign`. The existing task lifecycle
already covers the negotiation (`assign` → `accept` / `decline --reason`).
The handoff payload (files_changed, validation, blockers, next_actions)
already lives on the related run; the task references it via `related_runs`
and `related_handoffs`-style linkage — no schema change. `run finish` keeps a
convenience path (`--handoff-to <agent>`) that creates the assigned task.

Removed: `seed handoff create|list|read|accept` (4 commands, 4 MCP tools).

### Fold 2: threads → ownerless tasks

A thread becomes an **open task with no owner**, created with
`dedup_key = thread:<derived-id>` so re-materialization stays idempotent.
`run thread` and `view log --thread` create these tasks instead of packet
strings; `resolved-threads.json` maps to done/dropped task states. This also
**unifies the routing mechanisms shipped this week**: the stale-thread
escalation (task `1eeadcf3`) and the unclaimed-task-queue routing
(task `134c647c`) become one mechanism — a stale ownerless task is just an
aging entry in the same queue `next_move` already consumes.

Removed: `seed view threads`, `seed view thread resolve` (2 commands, 2 MCP
tools). `seed run thread` survives as sugar that creates the task.

### Fold 3: orientation tiers — three reads, not five

| Tier | Surface | Contract |
| --- | --- | --- |
| 1 | `seed` / `seedrop_boot` | The Situation packet. The product's front door. |
| 2 | `seed focus` | ~400-token mission-scoped pre-flight; never advances the watermark. |
| 3 | `seed view context` | Deep state, byte-budgeted (default 8KB, task `fc8b8b30`). |

`seedrop_continuity` is deprecated as an MCP tool — `seedrop_boot` wraps the
same report with a strictly better packet (the CLI `seed continuity` stays
for humans). `seedrop_view_brief` folds into focus/context. Bootstrap docs
(`~/.claude/CLAUDE.md`, templates) move to `seedrop_boot` as the session-start
call before publish.

### Trim 4: signal verbs

`seedrop_signal_lock` folds into `seedrop_signal_claim` (the schema already
carries `type: claim|lock`). Release/list unchanged.

## Target MCP surface (~33 tools, from 54)

| Group | Tools | Count |
| --- | --- | --- |
| Orientation | boot, focus, view_context, view_explain, view_log, diff | 6 |
| View maintenance | bootstrap, view_sync, view_preflight, view_audit | 4 |
| Tasks | create, claim, assign, accept, decline, start, pause, done, drop, list, show, update | 12 |
| Runs | start, log, verify, decision, finish | 5 |
| Signals | claim, list, release | 3 |
| Space | register, heartbeat, post, messages, presence, join | 6 — *candidate for follow-up grouping* |
| Inbox | inbox, inbox_ack | 2 |
| Meta | index, manual, capabilities, daemon_status | 4 |

Total: **42 → second pass groups Space into 2 (send/read) and Meta into 2,
landing ≈ 34.** We deliberately keep task verbs granular: per-verb schemas are
what make MCP routing reliable, and the task family is the primitive everything
else folds into. If post-publish telemetry (task `c477e3ef`, economy report)
shows the count still hurts, the escape hatch is verb-grouped tools with an
`action` enum — a breaking change we'd batch with the next major.

## Migration (one-time, on first post-upgrade `seed view sync`)

1. **Pending handoffs** → assigned tasks (`assigned_by` = source agent,
   description carries the handoff summary, `related_runs` links the run).
   Accepted/historical handoffs stay readable in `handoffs/` (frozen dir);
   `seed migrate-handoffs --remove` deletes after verification, mirroring the
   `migrate-acorn` pattern.
2. **Open threads** → ownerless tasks with `dedup_key = thread:<id>`;
   `resolved-threads.json` entries become dropped tasks with the resolution
   note. Packet `open_threads` strings remain as source-of-record prose but
   stop materializing as a separate surface.
3. **No data loss**: both folds are additive writes plus surface removal;
   the on-disk legacy dirs are not deleted by migration.

## Consequences

- The boot router gets simpler and stronger: one queue (tasks) instead of
  three (tasks, threads, handoffs) with cross-ranking rules.
- `ListTools` payload shrinks ~40%; clients without deferred loading pay
  proportionally less per session.
- Two capabilities tests (`cli_only` set, MCP coverage parity) must be updated
  in the same change as each fold — they are the contract that keeps
  `seed capabilities` honest.
- The README's "Three primitives" claim becomes literally true.

## Out of scope

- Implementation (follow-up tasks to be created per fold, sized to land
  before `2cb887f3` unblocks).
- TaskSchema changes of any kind.
- Space daemon protocol changes.
