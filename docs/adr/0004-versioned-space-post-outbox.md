# ADR 0004 — Add the versioned Space post-effect outbox

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 task `TX-12` / `f0f93afa`
- **Durable v1 change class:** versioned-migration

## Context

Space messages are durable JSONL records while mentions live in the daemon SQLite store. The v1 HTTP flow appended a message before inserting its mentions. Retry deduplication prevented duplicate messages, but a process death between those stores left no durable record saying which mention effects were still owed.

The durable-v1 contract is frozen. Making unresolved cross-store effects explicit requires a new versioned durable authority rather than adding ambiguous fields to v1 messages or mentions.

## Decision

Add an additive SQLite table named `post_outbox_v2`. Every row declares `schema_version = '2.0'` and is keyed by Space, author passport, and request UUID. It stores:

- the logical command hash and stable message identity;
- the prepared v1 message payload;
- known and unknown recipients;
- deterministic mention effect keys;
- pending, processing, completed, or dead-letter state;
- attempt, lease, error, and completion metadata.

The daemon creates this table with `CREATE TABLE IF NOT EXISTS` when opening any live store. Existing v1 sessions and mentions remain unchanged. A migration regression test removes the v2 table from a populated store, reopens it, and proves the table is restored without losing the legacy row.

The execution order is outbox prepare → message append → one SQLite transaction for mention inserts plus outbox completion. Failures leave an explicit pending row; exhausted retries become dead letters. HTTP, CLI, and MCP expose author-scoped inspection and explicit repair.

## Consequences

- A message and its mention effects are one recoverable command even though JSONL and SQLite cannot share an atomic commit.
- Every unresolved effect remains queryable with its request and effect keys.
- Poison effects stop retrying automatically and require an explicit repair action.
- Existing v1 message and mention readers remain compatible.
- Rollback may stop using the v2 table, but must not delete it until its pending/dead-letter rows are reconciled or exported.
