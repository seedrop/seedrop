# Wave 1B PR-09 — Outbox and watermark reliability proof matrix

- **Status:** passed
- **Executed:** 2026-08-09
- **Task:** `871c7549-b9bf-48eb-97e6-69b7f92fda2a`
- **Primary executable proofs:** `space/tests/reliability-proof-matrix.test.ts`, `cli/tests/continuity-fetch.test.ts`

## Claims and evidence

| Claim | Fault surface | Executable evidence | Required result |
|---|---|---|---|
| One logical post survives redelivery | faults before/after message persistence and before/after mention effects; repeated delivery of the same request | `reliability-proof-matrix.test.ts` redelivery table | exactly one message, one mention, one completed outbox command |
| Request identity binds the command | same request UUID with identical and mutated content | PR-09 request-conflict case | identical replay is side-effect free; mutation returns stable `409 seedrop.space.request_conflict` |
| Poison work becomes operator-visible | repeated effect failure through retry exhaustion | PR-09 poison case | durable `dead_letter`, attempt count, last error, effect key, `retryable=false`, and exact repair command |
| Dead letters are repairable | explicit outbox retry after the poison is removed | PR-09 poison case | original command completes with one message and one mention; no replacement command is created |
| Partial observation never loses unseen work | presence, inbox, or one Space message fetch fails | `continuity-fetch.test.ts` partial-fetch table | page is incomplete and unacknowledgeable; legacy and v2 watermark state remain unchanged; reads send observe-only headers |
| Retry starts from the same boundary | a failed Space fetch recovers while more messages arrive | `continuity-fetch.test.ts` retry case | already observed inbox/messages reappear and newly visible work is included; no fetch-time mutation |
| Acknowledgement is exactly once | sequential replay, concurrent replay, stale lock, tampered token | `continuity-fetch.test.ts` acknowledgement cases | one CAS commit and one presence effect; replay is idempotent; invalid state/token fails closed |
| Competing pages cannot skip work | two complete pages share one prior watermark | `continuity-fetch.test.ts` out-of-order case | first acknowledgement wins; stale page gets `watermark_conflict` and cannot move state |

## Recovery contract

An unresolved post is never represented only by a transient `500`. The response and durable outbox expose:

- request id and stable message id;
- `pending` or `dead_letter` state;
- attempt count and last error;
- deterministic effect keys;
- whether an automatic retry is safe;
- the exact `seed space outbox-retry <space> <request-id>` command when explicit repair is required.

A continuity fetch is never equivalent to acknowledgement. Only a complete, content-addressed page carries an acknowledgement token. The explicit acknowledgement uses a locked compare-and-set on the prior watermark and records the page beside a single presence boundary effect.

## Reproduction

```bash
PATH=/Users/mc/.nvm/versions/node/v20.20.2/bin:$PATH \
  npm test -w space -- --run \
  tests/reliability-proof-matrix.test.ts tests/inbox-http.test.ts \
  tests/presence.test.ts

PATH=/Users/mc/.nvm/versions/node/v20.20.2/bin:$PATH \
  npm test -w cli -- --run tests/continuity-fetch.test.ts
```

Observed result: PR-09 focused Space set `37/37`; CLI continuity set `11/11`; full Space suite `398/398`; full CLI suite `150/150`; both builds; Space smokes `15/15` + `15/15`; CLI smokes `27/27` + `11/11`; frozen v1 contract unchanged at 64 artifacts and 3 accepted transitions.
