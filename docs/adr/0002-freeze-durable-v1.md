# ADR 0002 — Freeze the durable v1 contract during Seedrop v2 construction

- **Status:** accepted
- **Date:** 2026-08-08
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 task `DC-01` / `754c5b83`
- **Durable v1 change class:** initial-freeze

## Context

Seedrop v1 persists state across passport JSON, identity audit JSONL, pending identity commit journals, repo-local View files, Space JSON/JSONL, daemon SQLite, cached daemon sessions, active-passport and continuity-watermark files, and the resumable setup journal. Most of those formats still identify themselves as `1.0`, while schema migration chains are empty.

Continuing to add fields, statuses, or coordination primitives to those v1 formats would move the migration target during v2 construction and could make the preserved machine corpus ambiguous. A source-file convention or review reminder is insufficient because a schema and its consumer can change together without producing a failing test.

## Decision

Freeze the current durable v1 contract as an executable, semantic-source fingerprint. CI must regenerate the fingerprint from named schema authorities and fail when it differs from the accepted manifest.

The freeze covers:

- passport, identity audit, and pending commit-journal records;
- View, task, run, continuity, signal, policy, Space, message, notification, and session schemas;
- v1 schema migration chains;
- live daemon SQLite DDL and persisted mention result values;
- cached daemon session state;
- active-passport, continuity-watermark, and resumable setup-journal state.

A future durable v1 change is permitted only as:

1. a `safety-repair` needed to prevent loss, corruption, unauthorized access, or false proof; or
2. a `versioned-migration` that introduces and exercises an explicit migration boundary.

Either path requires a separate accepted ADR under `docs/adr/` with matching `Durable v1 change class` metadata, followed by the explicit contract-accept command. Ordinary implementation refactors, API response changes, and disposable projections are outside this freeze unless they alter a named durable authority.

The freeze extractor fingerprints itself. Weakening or changing the guard is therefore itself a durable-contract transition requiring the same accepted-decision path.

## Consequences

- Unversioned durable additions fail in CI even if their unit tests pass.
- The reviewed manifest becomes the exact migration boundary for the preserved DC-02 corpus.
- Safety repairs remain possible but cannot enter as incidental schema edits.
- V2 work adds versioned protocol/events and migrations rather than extending ambiguous v1 files.
- The guard is governance enforcement, not cryptographic authorization: repository writers can still forge history, while review and branch protection remain responsible for accepting the ADR.
