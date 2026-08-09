# ADR 0003 — Repair the durable-v1 freeze extractor baseline

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 task `TX-13` gate discovery
- **Durable v1 change class:** safety-repair

## Context

The initial durable-v1 manifest committed by DC-01 records extractor SHA-256 `03e04c18…`, while the extractor committed in the same repository state has SHA-256 `49496065…`. A clean checkout therefore cannot pass `npm run check:durable-v1`, even before any durable declaration changes.

Regenerating the snapshot shows that all 64 tracked declaration fingerprints still match the initial manifest. The only difference is the extractor's own provenance hash. Leaving the mismatch would make the freeze gate permanently red and encourage bypasses, producing false proof about whether the durable-v1 contract changed.

## Decision

Accept one `safety-repair` transition that updates the manifest to the SHA-256 of the extractor actually committed and executed. Do not change any tracked durable declaration as part of this transition.

The transition is valid only if the explicit snapshot comparison reports an empty `changed_artifacts` list and the freeze guard plus its negative tests pass afterward.

## Consequences

- A clean checkout can enforce the durable-v1 freeze.
- Transition history preserves the original baseline and records why its extractor provenance was corrected.
- Durable passport, audit, journal, View, Space, and CLI state shapes remain unchanged.
- Future extractor edits continue to require the accepted-transition path.
