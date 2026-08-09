# ADR 0005 — Split continuity observation from acknowledgement

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 task `TX-14` / `cdc3b160`
- **Durable v1 change class:** none; additive v2 authority

## Context

The v1 continuity command combined two different operations: reading View, inbox, Space messages, and presence; then advancing a local watermark and registering presence. DC-09 deferred those writes until all reads succeeded, which prevented the most obvious partial-read loss. It did not make observation immutable: a successful fetch still consumed its own result, and authenticated daemon GETs refreshed presence as a hidden side effect.

That coupling makes failure timing part of product semantics. A caller that receives only part of the output, loses the process after fetch, or retries cannot state precisely whether the page was consumed. It also prevents an agent from proving that an orientation call was observational.

## Decision

Continuity fetches are read-only. Each fetch captures its high-watermark before reading sources and returns a content-addressed v2 page containing:

- the prior and high watermarks;
- a digest of the observation payload;
- completeness and blocker state;
- an opaque acknowledgement token and exact next command only when the page is complete and not a peek.

The token is an integrity-checked local receipt, not an authorization credential. Passport identity remains the authority. Fetch sends `X-Seedrop-Observe-Only: true`, causing authenticated daemon reads to skip their normal presence refresh.

`seed continuity ack --token <token>` and `seedrop_continuity_ack` are the only paths that advance the new state. Acknowledgement writes additive schema `2.0` state beside the frozen v1 file, lazily using the v1 watermark as its migration baseline. It:

1. verifies page integrity, completeness, acknowledgement eligibility, and passport ownership;
2. serializes acknowledgement with a per-agent lock;
3. compares the page's prior watermark with the currently committed watermark;
4. commits presence against an existing or deterministic fallback session UUID at the page high-watermark;
5. atomically writes the v2 watermark plus a bounded history of acknowledged page/high-watermark pairs.

The dedicated presence acknowledgement operation preserves an existing session's work label, advances `last_seen_at` only when the page boundary is newer, and creates one deterministic fallback session only when no prior session was observed. Reusing the same session/high-watermark pair returns the row unchanged. This makes retry safe if the process dies after presence commits but before the local state rename.

`seed boot` and `seedrop_boot` expose the same continuity page receipt used to build their Situation packet. Peek/focus pages are deliberately non-acknowledgeable.

## Consequences

- Fetch, partial output, and retry cannot consume unseen messages.
- Repeating an acknowledgement has no second watermark or presence effect.
- Two pages from the same prior watermark cannot both commit; the loser must refetch.
- Corrupt v2 state and malformed legacy baselines fail closed instead of silently resetting the watermark.
- Existing v1 state is preserved and remains readable; no frozen v1 declaration changes.
- Callers must explicitly acknowledge a complete page after consuming it. Until they do, the next fetch intentionally starts from the same prior watermark.
