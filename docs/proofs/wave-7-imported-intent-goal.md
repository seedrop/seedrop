# Served Situation keeps in-progress imported run goals — 2026-08-14

**Task:** `0bd55150`  
**Authority:** freeze/seal only; no provider spend

The live-compiler corpus sat at 98/100 independent facts because
`selectImportedIntent` dropped the current View run whenever an open task did
not list that run in `related_runs`. Boot still had an in-progress episode;
the adapter did not.

## Arrange / Act / Assert

| Gate | Assert |
| --- | --- |
| `situation/tests/compiler.test.ts` | in-progress imported episode + unlinked open task → `episode_id`, `goal`, `state=in_progress` (failed before the one-line bind; passes after) |
| `npm test -w @seedrop/situation` | 19 passed |
| `npm test -w @seedrop/migration` | 35 passed |
| `npm run pr15:corpus -- --out …/wave7-2026-08-14-live-intent` | 15 repos, 0 failures, **100** fixtures, `ready_for_model_spend: true` |
| `npm run verify:pr15-served-corpus -- …/frozen` | 100 fixtures; `packet_only` is the served adapter; `v2_situation` adds repo evidence |

Machine-local output (not in git):

`~/.seedrop/benchmarks/pr15/wave7-2026-08-14-live-intent`

**Manifest SHA-256:** `f9fef5ea3697847afd6dd46123f7d8e7ae9c29b5e394689f47f66f65bf464b05`

The two new facts are `current_intent:goal` on Invoicing and outer-agent — runs
that were already `in_progress` in those Views. sendel_v2 outcome-layer graves
were not restored. `min_independent_ground_truths` stays 100.

Adapter envelopes remain under 4 KiB.

## Spend

Corpus readiness is now true. Gate A is still locked until the operator names
exact `SEEDROP_PR15_CANARY_APPROVED_LOGICAL_CALLS`,
`SEEDROP_PR15_CANARY_APPROVED_PROVIDER_ATTEMPTS`, and
`SEEDROP_PR15_CANARY_APPROVED_MAX_USD`. No provider calls were made.
