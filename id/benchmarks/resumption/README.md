# Resumption Benchmark

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

## The fair-fight contract

The benchmark is worthless if it is rigged, so every task obeys one rule:
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

## Limitations (honest list)

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
