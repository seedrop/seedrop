# Wave 7 PR-15 OpenCode Go exact-request canary

**Executed:** 2026-08-14  
**Authorization:** 48 logical calls, 48 maximum provider attempts, USD 1 hard ceiling  
**Receipt digest:** `sha256:594f6b33f09e6f87b040fc9b0fcf8e540fa4c217e891e7325fc724b5b33ad44c`  
**Receipt file SHA-256:** `7362b521fde9274b14923e9cd9364345910724e5ff296fe485ffd0c1c99a7141`  
**Verdict:** canary failed; no repaired full screen or confirmation cohort is authorized

## Result

The 24-result canary completed in 487 seconds for USD 0.04718242. It made 47
provider attempts: 24 model calls and 23 judge calls. All 47 write-ahead
reservations settled, no reservation remains open, and no retry occurred. The
receipt's canonical digest independently verifies.

| Execution-validity check | Observed | Required | Result |
|---|---:|---:|---|
| Structured model response | 23/24 (95.83%) | at least 98% | fail |
| Nonempty visible response | 23/24 (95.83%) | at least 99% | fail |
| Completion-cap hit | 1/24 (4.17%) | at most 1% | fail |
| Exact judge response | 21/23 (91.30%) | at least 99% | fail |

Raising the model allowance from 256 to 4,096 tokens repaired most of the
provider incompatibility, but not enough to make the product experiment valid.
One weak-model response still consumed the full 4,096 tokens without a usable
visible response, and two Flash judge responses violated their exact JSON
contract.

## Exact execution failures

All three mechanical failures occurred on the same frozen failed-attempt case,
`outer-agent-216181f7-relevant_failed_attempt-cause`:

| Profile | Arm | Failure | Completion tokens |
|---|---|---|---:|
| Primary | current-v1 | invalid judge contract | 2,376 |
| Weak | repo-only | empty/invalid model response at cap | 4,096 |
| Weak | current-v1 | invalid judge contract | 3,228 |

Every packet-only and v2-Situation result was mechanically valid for both model
profiles: 12/12 structured model responses, 12/12 valid judge responses, and no
cap hits. Their completion counts were also materially smaller than the raw
contexts: packet-only ranged from 174 to 394 tokens; v2 Situation ranged from
160 to 1,297 tokens. This is a useful context-shape signal, not a powered
product verdict.

## Refusal finding

The canary included one frozen evidence-gap Situation whose required outcome was
explicit refusal. All eight model/arm combinations returned valid structured
responses and all eight judge responses were valid. None set `refuse=true`:

- correct refusals: 0/8;
- confidence range on the incorrect answers: 0.70–1.00;
- primary v2 Situation confidence: 1.00;
- weak v2 Situation confidence: 0.97.

This reproduces the PR-15E refusal finding without the old 256-token truncation
confound. It does not estimate the population refusal rate from one fixture, but
it is direct evidence that the current prompt/Situation contract does not cause
the models to operationalize Seedrop's refusal disposition. A larger screen
would only measure this known defect more expensively.

For the two served cases, packet-only and v2 Situation produced safe actions in
all eight profile/arm combinations. The early product shape is therefore
specific: compact orientation helps ordinary resumption, while refusal
semantics are not surviving the model boundary.

## Decision

Do not increase the cap again and do not run the full 4,040-result screen yet.
The next repair must be small and local:

1. make refusal an explicit executable instruction in the response contract,
   not only a Situation disposition embedded in context;
2. make the judge return contract robust under the same exact-request canary,
   preferably with a deterministic parser/repair boundary or a non-reasoning
   judge path;
3. split the failed-attempt compatibility case into a focused request canary so
   raw/current context cannot silently consume another enlarged allowance;
4. rerun only the frozen 24-result canary under a new, separately authorized
   contract;
5. consider a repaired full screen only after every execution-validity check
   passes and all explicit-refusal cases correctly refuse.

No OpenAI confirmation, external pilot claim, or database-trajectory change is
authorized by this result.
