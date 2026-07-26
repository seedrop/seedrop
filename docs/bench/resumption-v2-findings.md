# Resumption benchmark v2 — extraction built, run blocked on corpus density

**Status: blocked.** The harness works. The corpus cannot yet support a credible
result, and this document records why so the next attempt does not rediscover it.

## What v2 changes

v1 and v1.1 asked whether *synthesis* helps with information held constant: both
arms got identical curated evidence, and the packet only reorganized it. At
~1.2k tokens the answer was no (Δ+8.3pp at 5 seeds, Δ-1.1pp after fixture
hardening, CIs overlapping both times). A careful reader saturates.

v2 asks the question the product actually rests on: **does the recorded ledger
help, with the repo held constant?** The booted arm legitimately knows things the
cold arm cannot derive — "codex tried a PEG grammar here and it died on nested
blocks" is not latent in the repo, it exists only because someone recorded it.
That asymmetry is the value proposition, not a leak. A v2 delta must never be
compared to a v1 delta; they measure different things.

Fixtures are extracted from real handoffs — points where one agent finished a run
and a different agent started the next in the same repo — with the repo frozen at
the commit nearest that moment. The packet is reconstructed only from records
timestamped before the handoff, so it never sees the future it is asked about.

`extract.ts` emits the v1 `ResumptionTask` shape, so `runner.ts` runs it
unchanged.

## The probe validity pass, and what it killed

Extraction over the whole corpus found 47 handoffs and 86 probes. Almost none of
it survived scrutiny.

### `next-action` — invalid, disabled

The obvious probe: "what should you do next?", judged against what the next agent
actually did. All 47 ground truths turned out to be human product decisions:

- "Redesign landing brand panel into a monochrome auto-advancing slider"
- "Audit Settings information architecture for quiet minimalism"
- "Design and implement agent-vouched browser login handoff contract"

No agent can derive these from a repo or a ledger, because they were not derived
— they were chosen by the operator and handed down. Both arms score near zero and
the delta is noise. That is worse than having no probe, because it looks like a
measurement.

A valid version needs handoffs where the next action was genuinely implied by
repo state — runs started from an existing task rather than a fresh human
instruction. The corpus does not populate task linkage densely enough to filter
on it.

### `dead-end` — zero probes available

The probe that would demonstrate the graveyard produced **nothing**, because the
graveyard was empty for the entire period the corpus covers: 677 runs, 0 recorded
failures until the cause-of-death requirement shipped. The evidence needed to
prove the feature's value could not exist before the feature existed.

This probe becomes constructible as graves accumulate. It is the single highest-
value probe class in the design, because it tests exactly the knowledge git
cannot supply.

### `standing-decision` — 39 probes, 6 distinct facts

The only class with real ground truth, and it was badly overcounted. 39 extracted
probes tested **6 distinct decisions**, with two accounting for 31 of them. That
is an n of 6 dressed up as an n of 39.

The extractor now deduplicates by ground truth, so the fixture count reflects
independent observations. 47 fixtures became 6.

## Why the run is blocked

Six independent facts cannot detect the effect size in question. v1.1 moved
1.1pp; distinguishing that from zero needs on the order of hundreds of
independent observations, not six. Running anyway would produce a number with no
power behind it — which, given that the whole point of this exercise is an honest
proof artifact, is the one outcome worth avoiding.

The blocker is corpus density, not method. Current recording rates:

| Field | Runs recording it |
|---|---|
| `decisions` | 111 / 677 (16.4%) |
| `open_threads` | 9 / 677 (1.3%) |
| failures with `cause` | 0 / 677 before this work |

## What unblocks it

1. **Let the graveyard fill.** Cause-of-death is now required and the sweeper is
   running; `dead-end` probes become available as deaths accumulate.
2. **Raise decision density.** 16.4% is too sparse. Decisions are the cheapest
   high-value record in the schema and the one probe class that already works.
3. **Populate task linkage**, so `next-action` can be filtered to handoffs where
   the next step was implied rather than instructed.
4. **Re-extract and re-check power** before running. The extractor reports
   distinct-ground-truth counts; do not run on fewer than ~100.

## Reproducing

```bash
npx tsx id/benchmarks/resumption/extract.ts --corpus --out id/benchmarks/resumption/tasks-v2
SEEDROP_BENCH_TASKS_DIR=id/benchmarks/resumption/tasks-v2 npx tsx id/benchmarks/resumption/run.ts
```

`--include-next-action` re-enables the disabled probe. It should stay off until
task-linkage filtering exists.
