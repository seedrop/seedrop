# Resumption Benchmark

## Wave 7 / PR-15 status

The original two-arm harness below is retained as historical regression coverage;
it is **not** sufficient evidence for the v2 product claim. Wave 7 freezes four
arms in `pr15-contract.json`:

| Arm | Evidence available |
|---|---|
| `repo_only` | repository frozen at the replay commit |
| `current_v1` | frozen repository plus the current v1 orientation output |
| `packet_only` | byte-bounded v2 Situation without the repository evidence body; replacement-economics arm |
| `v2_situation` | frozen repository plus the byte-bounded v2 Situation |

Before any model calls, run the corpus gate:

```bash
npm run bench:resumption:readiness -w @seedrop/id -- --corpus --allow-not-ready
```

Omit `--allow-not-ready` in automation. A not-ready corpus exits with status 2.
The gate requires at least 100 independent ground truths, five eligible repos,
no repo contributing more than 40%, all six PR-15 probe classes, frozen replay
and sanitation bindings, explicit success/refusal coverage, and task linkage for
every safest-next-action probe. These distribution floors prevent a large count
from one fact, repo, or successful-only projection from masquerading as product
proof. They do not make each subgroup independently powered; every important
subgroup regression still blocks the product decision.

The live baseline on 2026-08-13 is intentionally rejected: 14 legacy fixtures,
18 observed independent probes (12 standing decisions and 6 dead ends), zero
fixtures with the frozen Wave 7 replay binding, and no scored refusal coverage.
Do not spend benchmark model calls on that corpus.

### Execution validity before product validity

The first OpenCode Go screen completed mechanically but is non-confirmatory
product evidence: 3,669 of 4,040 model responses reached the 256-token ceiling,
only 366 responses satisfied the structured response contract, and only 933
contained any visible response text. Audit a sealed receipt without making a
provider call:

```bash
npm run bench:resumption:pr15:audit -w @seedrop/id -- \
  /absolute/path/to/pr15-receipt.json \
  --out /absolute/path/to/pr15-failure-audit.json
```

Execution validity is now a prerequisite to interpreting the product gate. It
requires at least 98% structured responses, at least 99% nonempty responses,
at most 1% completion-cap hits, and at least 99% valid judge responses with
complete judge telemetry. A failed execution-validity gate classifies the
product result as non-confirmatory even when a product threshold or paired test
appears statistically significant.

The repaired OpenCode path is frozen as a separate exact-request canary:

- `pr15-canary-2026-08-14.json` selects three frozen cases spanning served
  current intent, explicit evidence-gap refusal, and a relevant failed attempt;
- every case runs through all four arms and both model profiles, producing 24
  model results;
- `pr15-opencode-go-canary-2026-08-14.json` retains the proven `max_tokens`
  request shape but raises the model allowance to 4,096 and the judge allowance
  to 1,024 tokens;
- retries are disabled, and the 24-result sample makes the frozen rate gates
  require 24 valid JSON responses, 24 nonempty responses, and zero cap hits.
  All selected cases use the LLM judge, so every judge response must also satisfy
  its exact response contract.

That canary executed on 2026-08-14 and failed. It produced 23/24 structured
model responses, 21/23 valid judge responses, one model cap hit, and zero
correct refusals out of eight mechanically valid refusal results. Do not rerun
the old contract and do not increase its token caps.

The next repair is version-bound and two-stage:

- `pr15-failed-attempt-compatibility-canary-2026-08-14.json` isolates the prior
  failed-attempt case to `repo_only` and `current_v1` for both model profiles:
  four model results and at most four judge calls;
- `pr15-repair-canary-2026-08-14.json` retains the frozen 24-result matrix but
  binds runner `1.1.0`, prompt `1.1.0`, judge prompt `1.2.0`, and judge parser
  `1.0.0`;
- the repaired prompt applies one executable evidence/refusal policy uniformly
  to every arm without exposing the fixture's expected behavior;
- judge parsing accepts exact JSON or a deliberately bounded deterministic
  repair (a sole JSON fence, case normalization, or boolean normalization) and
  records raw response, digest, tokens, exactness, and repair status;
- `canary_passed` now requires execution validity plus 100% correct expected
  refusals and zero unexpected refusals on served results;
- `pr15-opencode-go-repair-canary-2026-08-14.json` keeps the prior 4,096/1,024
  caps, exact `max_tokens` compatibility, zero retries, and catalog binding.

The four-result compatibility preflight requires its own explicit authorization:

```bash
export SEEDROP_PR15_PRIMARY_API_KEY="<OpenCode Go key>"
export SEEDROP_PR15_WEAK_API_KEY="$SEEDROP_PR15_PRIMARY_API_KEY"
export SEEDROP_PR15_CANARY_APPROVED_LOGICAL_CALLS="8"
export SEEDROP_PR15_CANARY_APPROVED_PROVIDER_ATTEMPTS="8"
export SEEDROP_PR15_CANARY_APPROVED_MAX_USD="<explicit operator ceiling>"

npm run bench:resumption:pr15:canary -w @seedrop/id -- \
  --fixtures /absolute/path/to/frozen-fixtures \
  --canary benchmarks/resumption/pr15-failed-attempt-compatibility-canary-2026-08-14.json \
  --execution benchmarks/resumption/pr15-opencode-go-repair-canary-2026-08-14.json \
  --out /absolute/path/to/failed-attempt-compatibility-receipt.json
```

Only after that receipt passes may an operator separately authorize the repaired
24-result canary (48 logical calls/attempts). The CLI enforces the passing
prerequisite receipt and binds its digest into the new receipt:

```bash
export SEEDROP_PR15_CANARY_APPROVED_LOGICAL_CALLS="48"
export SEEDROP_PR15_CANARY_APPROVED_PROVIDER_ATTEMPTS="48"
export SEEDROP_PR15_CANARY_APPROVED_MAX_USD="<new explicit operator ceiling>"

npm run bench:resumption:pr15:canary -w @seedrop/id -- \
  --fixtures /absolute/path/to/frozen-fixtures \
  --canary benchmarks/resumption/pr15-repair-canary-2026-08-14.json \
  --execution benchmarks/resumption/pr15-opencode-go-repair-canary-2026-08-14.json \
  --prerequisite-receipt /absolute/path/to/failed-attempt-compatibility-receipt.json \
  --out /absolute/path/to/repair-canary-receipt.json
```

Neither checked-in contract authorizes a provider call. The CLI refuses before
provider import unless the exact logical-call, provider-attempt, positive USD,
and prerequisite-receipt gates pass. Journals now bind runner, response prompt,
judge prompt, and deterministic judge-parser versions in addition to both
frozen contracts and selected result identities.

Candidate replays are reviewed and frozen one at a time. The freezer refuses to
overwrite an existing output:

```bash
npm run bench:resumption:freeze -w @seedrop/id -- \
  --input candidate.json --out fixtures/frozen-replay.json
```

The candidate must carry an exact adapter Situation JSON envelope, an explicit
passed sanitation record bound to the source digest, and probe ground truth no
newer than the replay cutoff. Freezing verifies the adapter semantic digest and
read-only capability, materializes the complete content of all four arms, hashes
every arm, and hashes the complete fixture. Benchmark execution reads only these
frozen contents; it does not reopen a working tree, View, or live daemon.

### Controlled proof execution

`bench:resumption:pr15` is the only Wave 7 execution path. It reruns readiness
before importing a provider client or reading API credentials, and exits 2 with
the readiness report when the corpus is underpowered. A passing corpus is run
in the fixed order `primary`, then `weak`, across every frozen arm and seed.

Execution configuration is deliberately explicit and checked in as a frozen
contract. `pr15-openai-2026-08-13.json` pins the provider client, dated model
snapshots, generation/reasoning limits, pricing basis, retries, seeds, sources,
and known limitations. The runner sends the immutable `model_revision` to the
provider; the adjacent human-readable alias is receipt metadata only.

`pr15-opencode-go-2026-08-13.json` is the cheaper full-matrix screening cohort.
It uses DeepSeek V4 Pro as primary, DeepSeek V4 Flash as weak ablation, and
Flash as judge through OpenCode Go's OpenAI-compatible endpoint. It binds the
public provider catalog by observation time and SHA-256, and adapts requests to
the parameter shape already proven by Outer Agent (`max_tokens`, without
`reasoning_effort` or provider seed). Because OpenCode exposes mutable aliases
rather than dated revisions, a pass is contemporary evidence and does not
replace the dated-snapshot confirmation cohort.

```bash
export SEEDROP_PR15_PRIMARY_API_KEY="..."
export SEEDROP_PR15_WEAK_API_KEY="$SEEDROP_PR15_PRIMARY_API_KEY"
export SEEDROP_PR15_APPROVED_LOGICAL_CALLS="8080"
export SEEDROP_PR15_APPROVED_PROVIDER_ATTEMPTS="32320"
export SEEDROP_PR15_APPROVED_MAX_USD="<explicit operator ceiling>"

npm run bench:resumption:pr15 -w @seedrop/id -- \
  --fixtures /absolute/path/to/frozen-fixtures \
  --execution benchmarks/resumption/pr15-openai-2026-08-13.json \
  --out /absolute/path/to/new-proof-receipt.json
```

To execute the OpenCode Go screen, use the same exact call/attempt approvals
with the OpenCode credential for both profiles and select the screening
contract:

```bash
export SEEDROP_PR15_PRIMARY_API_KEY="<OpenCode Go key>"
export SEEDROP_PR15_WEAK_API_KEY="$SEEDROP_PR15_PRIMARY_API_KEY"
export SEEDROP_PR15_APPROVED_LOGICAL_CALLS="8080"
export SEEDROP_PR15_APPROVED_PROVIDER_ATTEMPTS="32320"
export SEEDROP_PR15_APPROVED_MAX_USD="<explicit operator ceiling>"

npm run bench:resumption:pr15 -w @seedrop/id -- \
  --fixtures /absolute/path/to/frozen-fixtures \
  --execution benchmarks/resumption/pr15-opencode-go-2026-08-13.json \
  --out /absolute/path/to/new-opencode-screen-receipt.json
```

Only credentials and the three exact spend approvals come from the environment;
model or sampling environment variables cannot mutate the run. A separate
project-scoped credential is recommended. Project budget alerts are operational
warnings, not a reliable hard cap; the harness enforces its USD ceiling before
each request using conservative one-token-per-byte input reservation, then
reconciles against provider token usage.

Before every provider request, a conservative cost reservation is appended and
digested in `<out>.journal.jsonl`; successful usage is settled afterward, and
every completed probe is appended separately. Interrupted reservations remain
charged against the local ceiling on restart because the provider may have
processed the request. A restart verifies the journal's benchmark, corpus,
execution, profile, retry, spend, and call-plan bindings, then skips only exact
completed identities.
Pass `--journal <path>` to choose another machine-local location. The final
receipt is created exclusively and never overwritten; if it already exists,
execution stops before provider import or credential access. Raw responses,
backend fingerprints, token/cost usage, retry/provider-attempt telemetry,
timing, fixture identities, all governing digests, paired statistics,
subgroups, and every gate decision are sealed into the receipt. The receipt may
record a failed product gate; execution success is not evidence that the
product thresholds passed.

The CLI prints its exact logical call ceiling before execution. For the frozen
101-fixture corpus, four arms, five seeds, and two model profiles, the ceiling is
4,040 model calls plus 4,040 batched judge calls. With three permitted retries,
the absolute provider-attempt ceiling is 32,320. The current snapshot/pricing
contract has an approximately $85.63 standard-request estimate for the frozen
corpus under its output caps; this is planning guidance, not authorization or a
guaranteed bill. Do not begin without an operator-approved USD ceiling.

For the OpenCode Go screen, a local dry simulation of the exact frozen request
matrix produced a $14.56 one-token-per-byte conservative reservation sum and a
$4.20 no-cache estimate when input bytes are tokenized at four bytes per token
and every response consumes its full output cap. OpenCode Go's limits are
provider-metered dollar ceilings, not guaranteed call counts; the runner still
requires a positive local USD ceiling and stops before any request that would
cross it.

## Historical two-arm harness

Measures whether an agent that receives a Seedrop **Situation packet** at boot
resumes work better than a cold agent given only raw repository evidence — and
what the packet costs in prompt tokens. This is the proof loop for Seedrop's
core claim: *a resumed agent should be strictly stronger than a cold one, by
more than the record costs.*

| Arm | Setup |
|---|---|
| `cold` | Raw repository evidence only (docs, logs, task/run/continuity excerpts — contradictions and staleness intact). |
| `booted` | The **same** evidence, plus the synthesized Situation packet. |

6 hand-authored tasks × ~2 probes × 2 arms × N seeds (default 5) ≈ 120 probe-runs.

## The historical fair-fight contract

The historical synthetic benchmark is worthless if it is rigged, so every task obeys one rule:
**everything the boot packet asserts must be derivable from the repo evidence
given to both arms.** The packet may *synthesize* (resolve contradictions,
rank stale against fresh, surface the graveyard); it may never *know more*.
The cold arm can always get every probe right by reading carefully. What is
measured is whether synthesis-at-write-time beats derivation-at-read-time.

## What the tasks test

Each task plants a realistic intent-loss trap, drawn from a 2026-07-05 audit
of Seedrop's own project history:

| Task | Failure mode under test |
|---|---|
| `001-superseded-constraint` | A freeze was later dropped; dated records must be reconciled. |
| `002-dead-approach` | An abandoned approach survives in an enthusiastic old design doc. |
| `003-next-action-routing` | Claimed in-flight work vs. a shinier open task. |
| `004-inflight-clobber` | Another agent's active claim + uncommitted mid-refactor state. |
| `005-standing-donot` | A standing policy constraint vs. a reasonable-sounding request. |
| `006-stale-focus` | The README's prominent focus line is months stale. |

Most probes demand an exact-format first line (`DECISION: YES`, `FIRST: T-103`)
and are scored by regex — deterministic and judge-free. Open-ended probes
(e.g. "recommend an approach") use a YES/NO judge call, same as the erosion
benchmark.

## Quickstart

```bash
cd id
npm install
npm install --no-save openai

export OPENAI_API_KEY="..."
export OPENAI_BASE_URL="https://api.groq.com/openai/v1"   # or http://localhost:11434/v1 for Ollama
export SEEDROP_BENCH_MODEL="llama-3.1-8b-instant"

npm run bench:resumption
```

Output:
- A summary table: correct-rate per arm with 95% Wilson CIs, Δpp, CI-overlap
  verdict, mean prompt/completion tokens per arm, and the **packet price**
  (marginal prompt tokens the booted arm pays per probe).
- A JSON dump at `benchmarks/resumption/results/<timestamp>.json` with every
  probe response and verdict.

Configuration mirrors the erosion benchmark (`SEEDROP_BENCH_JUDGE_*`,
`SEEDROP_BENCH_SEEDS`, `SEEDROP_BENCH_TASKS_DIR`, `SEEDROP_BENCH_OUT`).

## Reading the result

The claim being tested: `delta_pp` is positive with non-overlapping CIs, at a
`marginal_prompt_tokens` cost small enough to be obviously worth it. Report
both numbers together — accuracy without price is marketing, price without
accuracy is pessimism.

## Historical limitations (honest list)

- **Packet position bias:** the booted arm sees the packet before the raw
  evidence, mirroring real boot order. Prompt-position effects are not
  controlled for; swapping the order is a cheap ablation if results look odd.
- **Additive claim only:** this compares evidence vs. evidence+packet. The
  stronger *replacement* claim (packet **instead of** evidence, at a fraction
  of the tokens) needs a third `packet_only` arm — designed but deferred.
- **Synthetic fixtures:** tasks are hand-authored miniatures, not replayed
  real repos. v2 should freeze a real repo state + its real `seed` boot output
  and probe against that.
- **Format-following confound:** regex probes require exact first-line
  formats; a model that reasons correctly but formats sloppily scores as
  wrong, in both arms equally.
- **Judge confounding** for `llm`-checked probes: same caveat as the erosion
  benchmark — use a stronger independent judge via `SEEDROP_BENCH_JUDGE_*`.
