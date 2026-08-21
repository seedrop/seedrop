# Wave 7 Gate A authorization — 2026-08-21

**Operator:** mc
**Decision:** Gate A failed-attempt compatibility canary is authorized at the smallest possible ceiling.
**Governing contract:** [Wave 7 product questions](../v2/WAVE-7-PRODUCT-QUESTIONS.md) (frozen 2026-08-14)
**Canary task:** `c9e76f30` ([PR-15 Repair Gate A])

## Authorized ceiling (exact)

| Env var | Value |
| --- | --- |
| `SEEDROP_PR15_CANARY_APPROVED_LOGICAL_CALLS` | `8` |
| `SEEDROP_PR15_CANARY_APPROVED_PROVIDER_ATTEMPTS` | `8` |
| `SEEDROP_PR15_CANARY_APPROVED_MAX_USD` | `1` |

## Scope

- **Authorized:** the 4-result / 8-call failed-attempt compatibility preflight only
  (`pr15-failed-attempt-compatibility-canary-2026-08-14.json` against the
  `2026-08-14-live-intent` sealed corpus), producing a prerequisite receipt.
- **Not authorized by this decision:**
  - Gate B 24-result repair canary — remains **forbidden** per the frozen spend
    lock; tasks `ecda2db2` and `863a45c5` were dropped on 2026-08-21 with that
    reason. A future Gate B request requires a separate, explicit authorization.
  - OpenCode Go 48-call canary (`89ab04ed`) — still requires its own ceiling.
  - 4,040-result screen, token-cap increase, design-partner pilot — forbidden
    (unchanged).
- Gate A approval must not be reused as the prerequisite authorization for any
  other contract.

## Preconditions at authorization time

- Live boot serves `mode=v2` without `--situation-file` (run `81726bdf`, validation receipt 2026-08-14).
- CLI/MCP/observer/bench/desktop adapters pass semantic parity (`verify:adapter-parity`, 2026-08-21).
- Corpus `wave7-2026-08-14-live-intent` sealed with `ready_for_model_spend: true`
  (98/100 independent ground truths).

## Execution

The canary reads the ceiling from the environment at invocation; nothing is
checked in that authorizes a call by itself. API keys are supplied by the
operator at run time and are never committed.
