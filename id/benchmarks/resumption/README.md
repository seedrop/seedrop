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

Execution configuration is deliberately explicit. Provider versions and model
revisions are required in addition to model aliases; use immutable revisions
published by the provider, not labels such as `latest`.

```bash
export SEEDROP_PR15_PRIMARY_PROVIDER="provider-id"
export SEEDROP_PR15_PRIMARY_PROVIDER_VERSION="provider-api-version"
export SEEDROP_PR15_PRIMARY_BASE_URL="https://provider.example/v1"
export SEEDROP_PR15_PRIMARY_API_KEY="..."
export SEEDROP_PR15_PRIMARY_MODEL="primary-model-id"
export SEEDROP_PR15_PRIMARY_MODEL_REVISION="immutable-primary-revision"

export SEEDROP_PR15_WEAK_PROVIDER="provider-id"
export SEEDROP_PR15_WEAK_PROVIDER_VERSION="provider-api-version"
export SEEDROP_PR15_WEAK_BASE_URL="https://provider.example/v1"
export SEEDROP_PR15_WEAK_API_KEY="..."
export SEEDROP_PR15_WEAK_MODEL="weak-model-id"
export SEEDROP_PR15_WEAK_MODEL_REVISION="immutable-weak-revision"

npm run bench:resumption:pr15 -w @seedrop/id -- \
  --fixtures /absolute/path/to/frozen-fixtures \
  --out /absolute/path/to/new-proof-receipt.json
```

Optional `SEEDROP_PR15_<PRIMARY|WEAK>_JUDGE_*` variables pin a separate judge;
otherwise each profile's provider/model revision is reused. Sampling defaults
to temperature 0 and five seeds. Retry count and deterministic backoff policy,
raw responses, usage provenance, timing, fixture identities, contract/corpus
digests, paired statistics, subgroups, and every gate decision are sealed into
the receipt. The output file is created exclusively and is never overwritten.
The receipt may record a failed product gate; execution success is not evidence
that the product thresholds passed.

The CLI prints its exact logical call ceiling before execution. For the frozen
101-fixture corpus, four arms, five seeds, and two model profiles, the ceiling is
4,040 model calls plus 4,040 batched judge calls. Retry attempts are additional
provider requests and are counted separately in the receipt. Do not begin the
run without an explicit provider/model/revision selection and an accepted spend
budget for that matrix.

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
