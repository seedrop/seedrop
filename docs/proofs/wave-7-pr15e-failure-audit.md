# Wave 7 PR-15E failure, refusal, and subgroup audit

**Audited:** 2026-08-14  
**Source receipt:** `sha256:53274002d3d0fcc25704a526dfd699577baec81cc8e7c9f65613771da36f840d`  
**Audit artifact:** `sha256:60efb2fa960f5d91cf1938046a018a5599bf2e1da16027c1813953c6928a7b60`  
**Verdict:** non-confirmatory execution failure; no Seedrop v2 pass/fail conclusion is authorized

## Result

The OpenCode Go cohort completed and its product gate observed `false`, but the
product verdict is not interpretable. The exact provider/request contract failed
an independent execution-validity gate before Seedrop correctness could be
measured reliably.

| Execution check | Observed | Required | Result |
|---|---:|---:|---|
| Structured response contract | 366/4,040 (9.06%) | at least 98% | fail |
| Nonempty visible response | 933/4,040 (23.09%) | at least 99% | fail |
| Completion-cap hit | 3,669/4,040 (90.82%) | at most 1% | fail |
| Judge contract validity | not retained | at least 99% with complete telemetry | fail |
| Provider attempts | 4,406 | retained evidence | — |
| Retries | 0 | retained evidence | — |
| Inferred judge calls | 366 | retained evidence | — |

The attempt accounting is diagnostic: 4,040 model calls plus exactly 366 judge
calls equals the 4,406 provider attempts. The judge was reached only when the
model produced a valid structured response. Most invalid results report the full
256 completion tokens with an empty or unusable visible response, consistent
with hidden reasoning consuming the shared allowance. The sealed receipt did not
retain finish reason or visible-versus-reasoning token detail, so that mechanism
is a strong inference rather than directly observed provider telemetry. It also
did not retain judge-response contract validity separately; repaired results do.

## Arm and model audit

| Model | Arm | Valid JSON | Cap hits | Safe action | Safety violations | Unsupported high confidence |
|---|---|---:|---:|---:|---:|---:|
| Primary | repo-only | 4/505 | 501 | 0 | 4 | 1 |
| Primary | current-v1 | 1/505 | 504 | 0 | 1 | 1 |
| Primary | packet-only | 80/505 | 426 | 28 | 45 | 52 |
| Primary | v2 Situation | 67/505 | 438 | 20 | 40 | 47 |
| Weak | repo-only | 1/505 | 502 | 0 | 1 | 0 |
| Weak | current-v1 | 2/505 | 502 | 0 | 2 | 2 |
| Weak | packet-only | 143/505 | 360 | 23 | 97 | 120 |
| Weak | v2 Situation | 68/505 | 436 | 18 | 37 | 49 |

The compact packet is the strongest directional context-shape signal, but the
screen cannot establish a product ranking. Relative to packet-only, full v2 had
2.57 percentage points fewer valid responses and 1.58 points fewer safe actions
for the primary model. For the weak model the gaps were 14.85 and 0.99 points.
These differences justify a compression/prioritization investigation after a
valid canary; they do not prove that the v2 architecture regressed.

## Refusal audit

The refusal slice is the most serious directional finding:

- 480 results belonged to frozen Situations whose required outcome was refusal;
- 82 of those results contained valid structured JSON;
- zero set `refuse=true` and zero were correct refusals;
- the only four observed refusals occurred on served, not refused, Situations.

Global execution invalidity prevents a powered product conclusion, but
truncation alone does not explain the zero refusals inside the 82 valid
structured responses. The repaired full screen must report refusal correctness
as a first-class metric, not only confirm that success and refusal fixtures were
present.

## Subgroup audit

The sealed summary reported no subgroup regressions. That result is technically
consistent with the current implementation but does not clear the important
replacement-economics comparison: subgroup regression detection compares v2
only with repo-only and current-v1. It never compares `v2_situation` with
`packet_only`. Near-zero baselines also make an empty regression list
uninformative under this execution failure.

Before a repaired product screen, subgroup reporting must explicitly include:

1. v2 versus repo-only;
2. v2 versus current-v1;
3. v2 versus packet-only for replacement economics;
4. explicit-refusal correctness by model, arm, probe class, and repository;
5. response-contract validity and completion-cap rate for every subgroup.

## Frozen corrective canary

No provider call was made during PR-15E. Two checked-in contracts now freeze the
next executable step:

- `id/benchmarks/resumption/pr15-canary-2026-08-14.json` selects three frozen
  cases—served current intent, explicit evidence-gap refusal, and a relevant
  failed attempt—across four arms and both models: 24 model results;
- `id/benchmarks/resumption/pr15-opencode-go-canary-2026-08-14.json` retains the
  proven `max_tokens` request compatibility, uses 4,096 model and 1,024 judge
  token allowances, one sample, and zero retries;
- the exact ceiling is 24 model plus at most 24 judge calls: 48 logical calls
  and 48 maximum provider attempts;
- the canary reuses the digested write-ahead reservation/result journal, exact
  resume identities, and conservative unsettled-reservation accounting proven
  by the full screen;
- because of the sample size, the frozen 98%/99%/1% rate thresholds require 24
  valid JSON responses, 24 nonempty responses, and zero completion-cap hits.
  All 24 selected cases use LLM checks, so the judge contract must also be valid
  for every invocation.

A passing canary permits consideration of a repaired full OpenCode screen. It
does not authorize that screen, the dated OpenAI confirmation, an external
product claim, or a database-trajectory change.
