# Seedrop v2 — Machine Evidence

**Captured:** 2026-08-08  
**Scope:** the Seedrop Views and passports available on this machine  
**Purpose:** longitudinal product evidence for the v2 architecture; not external market validation

## Method

The audit inspected nine local passports, their registered project roots, every available `.seedrop/view`, the active Space daemon storage, and the Seedrop source tree. Structured records were parsed with both permissive corpus scripts and the current strict Zod schemas. Git outcomes were inferred with the repository's existing `scripts/outcome-layer.mjs` and checked against each repository's current `HEAD`.

The evidence set contains approximately 24 registered roots, 18 initialized Views, and 17 meaningful non-probe Views. Some projects appear in more than one passport; totals below deduplicate Views by resolved root.

Git survival is an inference from changed paths, blame, timestamps, and current repository state. It is useful longitudinal evidence, not absolute proof of authorship or business outcome. A line can survive after substantial modification, and commits can move outside the inference window.

## Corpus scale

| Artifact | Count | Distribution |
| --- | ---: | --- |
| Runs | 737 | 700 completed, 26 blocked, 2 failed, 9 in progress |
| Tasks | 1,286 | 562 done, 479 open, 235 dropped, 4 blocked, 4 in progress, 2 claimed |
| Continuity packets | 595 | 539 validation passed, 12 failed, 15 skipped, 29 unknown |
| Passports inspected | 9 | operator plus Claude, Codex, Cursor, Gemini, Kilo, Kimi, Zcode identities |

The largest Views are already non-trivial production-scale dogfood:

| Project | Runs | Tasks | Packets |
| --- | ---: | ---: | ---: |
| `outer_v2` | 252 parseable | 526 | 228 |
| `tale` | 184 parseable | 285 | 120 |
| `seedrop` | 104 | 90 | 59 |
| `outer-agent` | 90 | 183 | 79 |
| `outer` | 35 | 95 | 34 |
| `loci` | 23 | 23 | 23 |
| `Invoicing` | 11 | 35 | 11 |
| `ax-research` | 8 | 0 | 10 |
| `ax-surface` | 8 | 6 | 1 |
| `seedrop_db` | 5 | 11 | 13 |
| `sendel` | 5 | 8 | 5 |
| machine `space` project | 3 | 10 | 2 |
| `RoostRuntime` | 2 | 4 | 1 |
| `outer-desktop` | 2 | 10 | 1 |
| `Roost` | 1 | 0 | 2 |
| `mczaykowski-api` | 4 | 0 | 5 |
| `ax-outreach` | 0 | 0 | 1 |

## What the corpus says

### Execution is captured; reasoning is split away

- 713 of 737 runs contain steps.
- 623 contain changed paths.
- 662 contain passed validation.
- Only 143 contain decisions.
- No run contains assumptions.
- Only 13 contain open threads.
- Continuity packets, by contrast, contain 517 decision sets, 337 assumption sets, 394 open-thread sets, and 498 changed-path sets.

This is a dual-write system in practice: Runs are the execution record and packets are the reasoning record. Packets have no canonical `run_id`, so the two halves cannot be deterministically reconciled.

### “Completed” is a report, not proof of delivery

The Git outcome layer classified 620 of 734 analyzed runs:

| Inferred outcome | Count | Share |
| --- | ---: | ---: |
| Survived at current `HEAD` | 488 | 78.7% |
| Uncommitted | 85 | 13.7% |
| Superseded | 35 | 5.6% |
| Absent | 12 | 1.9% |

Among 596 labeled `completed` runs, 125—about 21%—did not have their inferred work survive at current `HEAD`; 81—about 13.6%—appeared never to land. This does not mean those runs were useless. It means `completed` and `delivered` are different facts and Seedrop currently conflates them in trust decisions.

Examples expose different operating modes:

- `outer_v2`: 207 of 214 classified runs survived; the record is strongly Git-backed.
- `loci`: all 23 classified runs appeared uncommitted.
- `outer`: 23 of 28 classified runs appeared uncommitted.
- `seedrop`: 53 of 80 survived, 21 were superseded, 3 uncommitted, and 3 absent—the system's own history contains substantial architectural churn.
- `outer-agent`: 49 of 82 survived and 25 appeared uncommitted.

### Negative knowledge is still mostly invisible

Only 2 of 737 runs are explicitly `failed`, while 26 are blocked and 9 remain in progress. Six in-progress runs were stale for more than 72 hours at capture time. Real abandoned attempts are therefore being represented mostly as silence, open state, or later supersession—not as searchable causes of death.

### The queue accumulates without lifecycle governance

- 479 tasks are open.
- 126 open or blocked tasks are older than 30 days.
- 705 tasks have no owner.
- 907 have no related run.
- 235 are dropped, a large amount of potentially valuable negative/prioritization history.

The task layer is doing useful work, but it needs reconciliation, aging, supersession, archival, and explicit linkage rules before it can serve as a trustworthy intent ledger.

### Context budgets are advisory, not enforced

Every meaningful View returned success level L1 at capture time. Six Views were below their configured required level: `ax-research`, `loci`, `outer`, `outer_v2`, `seedrop`, and `tale`.

More importantly, every meaningful View exceeded a requested 2,048-byte context budget. Representative outputs:

| Project | Returned bytes |
| --- | ---: |
| `seedrop` | 7,025 |
| `loci` | 12,191 |
| `outer` | 12,242 |
| `outer-agent` | 17,545 |
| `seedrop_db` | 36,731 |
| `outer_v2` | 55,413 |

Even the nearly empty `ax-outreach` View returned 2,556 bytes. The implementation loads full collections before trimming and has no indexed summary that can satisfy the contract at scale.

### Schema errors become missing work

Strictly validating all 1,286 task files with the current `TaskSchema` found two invalid files. The normal task list path silently catches and skips both:

1. `outer_v2` contains a task with `completed_at` and `validation_receipt` while retaining schema version `1.0`; strict parsing rejects the unversioned extension.
2. `seedrop` contains a `blocked_by` value stored as an eight-character task prefix while the schema requires a full UUID.

The View audit checks malformed Runs and legacy Handoffs but not Tasks, continuity packets, or Signals. It can therefore return healthy while current work has disappeared from projections.

### Live storage demonstrates a root-semantics defect

The installed daemon receives `~/.seedrop/space` as its root. `SpaceStore.open()` appends its default `.seedrop/space` data directory to that root. On this machine the durable database and spaces therefore live at:

```text
~/.seedrop/space/.seedrop/space/
```

while logs and sessions also exist directly under `~/.seedrop/space/`. This is live evidence of one configuration term carrying two incompatible meanings: project root versus already-resolved data root.

### Tests are broad but not aimed at the observed failures

At capture time:

- `npm test` passed all workspaces: 774 tests passed and 3 skipped.
- `npm run typecheck --workspaces` passed.

This is a strong base. The missing test class is systemic: cross-process writers, crash points between side effects, corrupt artifacts in otherwise healthy Views, storage-root migration, hard budget enforcement at corpus scale, and parity across CLI/MCP/Observer/Desktop projections.

### The Seedrop DB experiment is both a solution candidate and new dogfood evidence

`/Users/mc/Projects/seedrop_db` is an early, separate Rust experiment whose native query is a deterministic, authorized, validity-filtered, proof-closed Situation under an exact byte budget. Its accepted architecture directly addresses the largest machine-corpus failure: orientation currently scales by loading fragmented history and trimming afterward.

The local evidence is promising but deliberately incomplete:

- G1 froze a semantic reference over 64 exact D0 histories.
- Current root and G2 workspace test suites pass; the pinned Kuzu conformance test remains environment-dependent and ignored locally.
- C0's D1 correctness artifact passes C1–C14.
- B1's original D1 miss is preserved; the distinct revision-5 artifact passes C1–C14 with SQLite application logic included.
- Both passing D1 cells produced 85 Situations and 915 typed failures from 1,000 requests. This proves semantic equivalence, not high useful-answer coverage.
- No performance result has been observed, no performance runner currently exists, and the local 24 GiB host is below the frozen 32 GiB official D3 minimum. G2 has not selected C0 or justified a custom storage engine.

The repo also reproduces Seedrop's orientation drift in miniature: its README says no G2 task has started, while its View policy and active Run say G2 is underway. The governing ADR/benchmark records remain sound, but the entry surface is stale. V2 must make governing-record identity and freshness part of every status claim.

The detailed integration and safety findings are in [Seedrop DB experiment forensics](./SEEDROP-DB-EXPERIMENT.md).

## Evidence-backed opportunity

This machine already demonstrates the product need. Hundreds of real work episodes create a durable trail, but the operator still cannot ask one source for a provable answer to:

- What is the current intent?
- What actually landed?
- Which conclusions are still fresh?
- What failed and should not be retried?
- Which work is only local or at risk?
- What single action should the next actor take?

Seedrop v2 should turn the existing corpus from a collection of journals into an evidence graph that can answer those questions within a strict budget.
