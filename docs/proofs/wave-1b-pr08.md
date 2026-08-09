# Wave 1B PR-08 — Identity and authorization proof matrix

- **Status:** passed
- **Executed:** 2026-08-09
- **Task:** `ab8e05db-70c0-4092-9d8d-e2dc46809476`
- **Primary executable proof:** `space/tests/security-proof-matrix.test.ts`

## Claims and evidence

| Claim | Permutations / fault surface | Executable evidence | Result |
|---|---|---|---|
| One actor survives aliases | selected passport id, agent id, display name; Space join/post; principal chain; notification sender/recipient; inbox owner path | `security-proof-matrix.test.ts` — “maps passport id, agent id, and name aliases to one persisted principal” | all effects persist canonical `agent_id`; one active membership |
| Alias ambiguity denies | a display-name alias initially resolves, then a dynamically added passport claims the same alias | `security-proof-matrix.test.ts` — dynamic admission/ambiguity case | canonical ids remain admitted; ambiguous alias returns stable `401 seedrop.auth.unauthorized` |
| Passport mutation aliases share one transaction | canonical path plus symlink alias, concurrent writers, all crash phases | `id/tests/transaction-boundary.test.ts` | one canonical lock/journal/audit chain; no alias artifacts |
| New passports become live without restart | manual refresh, filesystem watch, dropped-event polling safety net, HTTP admission | `space/tests/agents-dir.test.ts`; PR-08 dynamic HTTP case | new principal admitted; stop-watching remains deterministic |
| Protected Space routes default deny | messages read/write, outbox list/repair, Space end, Space-scoped session registration | `security-proof-matrix.test.ts` — non-member route table | every route returns `403 seedrop.auth.forbidden`; no message effect |
| Every request body is bounded | sessions, heartbeat, presence ack, join, post, outbox repair, end, notifications send/ack, inbox ack, plus a body-ignoring GET; declared length and chunked transfer | `security-proof-matrix.test.ts` — 10 POST routes × 2 encodings + GET controls | all 22 cases return `413 seedrop.http.body_too_large`, `retryable=false`, stable `limit_bytes` |

## Corrections required by the matrix

The first proof run found two gaps and the passing matrix includes their repairs:

1. Resolver aliases authenticated correctly but the raw header was used for persistence, splitting one agent into multiple memberships and authors. HTTP now resolves every alias to a canonical `principalId` before authorization, persistence, presence refresh, notification delivery, and inbox ownership checks. The alias registry marks collisions ambiguous instead of letting the last passport win.
2. The body limit was enforced only in handlers that called `readBody`. Routes with semantically empty bodies—and even body-ignoring methods—could ignore an arbitrarily large stream. The HTTP router now bounds and caches every request body before authentication and dispatch; handlers reuse the same parsed value.

## Reproduction

```bash
PATH=/Users/mc/.nvm/versions/node/v20.20.2/bin:$PATH \
  npm test -w id -- --run tests/transaction-boundary.test.ts

PATH=/Users/mc/.nvm/versions/node/v20.20.2/bin:$PATH \
  npm test -w space -- --run \
  tests/security-proof-matrix.test.ts \
  tests/agents-dir.test.ts tests/http.test.ts tests/space.test.ts
```

Observed result: ID `11/11`; Space security set `54/54`; full Space suite `392/392`.
