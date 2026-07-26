# The Seedrop corpus: schema and method

This document specifies the record Seedrop keeps of agent work, and the method
for labeling it with outcomes. It is written so that the format can be adopted
without adopting Seedrop.

The data is not published. The schema and the method are. If other agents write
runs in this shape, the interesting artifact stops being one machine's history
and becomes a format that cross-vendor agent work is recorded in.

## Why this record exists

Every agent vendor keeps telemetry on its own agent's trajectory. None of them
can see the seam where work passes between agents from different vendors,
because by construction that happens outside both systems. That seam is where
inherited assumptions break, where a decision recorded by one model reads
differently to another, and where the same dead end gets re-derived.

Three properties, together, make a record worth keeping. Individually they are
all common:

- **Cross-vendor.** One schema, written by agents from different providers.
- **Outcome-linked.** Each run names the paths it touched, and lives inside a
  git repo, so what happened next is recoverable.
- **In the wild.** Real projects with real consequences, not benchmark fixtures.

## The record

Four primitives. Everything else is derived.

### Run

A unit of agent work, from intent to terminal status.

| Field | Meaning |
|---|---|
| `run_id` | UUID |
| `agent_id` | Which agent identity did the work — the passport, not the model string |
| `goal` | What was being attempted, in the agent's own words |
| `status` | `in_progress` \| `completed` \| `blocked` \| `failed` |
| `cause` | One-line cause of death. **Required** for `blocked` and `failed` |
| `swept` | True when a sweeper inferred the death rather than the agent reporting it |
| `started_at` / `finished_at` | ISO-8601 |
| `steps` | Append-only progress entries, each with its own `changed_paths` |
| `decisions` | Choices made, recorded at the time — not reconstructed afterward |
| `assumptions` | What the agent took to be true without verifying |
| `open_threads` | Unresolved questions handed to whoever comes next |
| `changed_paths` | Repo-relative paths the run modified. **This is the join key to git** |
| `validation` | Commands run, their status, and notes — the evidence of checking |
| `next_actions` | Structured suggestions with risk and whether a human is required |

Two fields do the load-bearing work. `changed_paths` is what makes a run
linkable to what actually happened afterward. `cause` is what makes a failed run
worth reading.

### Task, Signal, Continuity packet

`Task` is a commitment with an owner and a lifecycle; an assigned task is a
handoff, an ownerless one is a thread. `Signal` is a lease on a path, so two
agents do not silently collide. `ContinuityPacket` is a narrative checkpoint
written by the agent for whoever arrives next.

## Recording failure

The corpus this schema came from ran 92 runs with 0 failures — not because
nothing failed, but because recording a failure was expensive and reads as an
admission. A success-only record cannot answer the question that most helps an
arriving agent: *what was already tried here that did not work?*

Two rules keep the graveyard populated:

**Dying is cheaper than completing.** Finishing `completed` is gated on the
run's changed paths being committed. Finishing `failed` or `blocked` requires
one sentence and nothing else. If failure is not the path of least resistance,
it does not get recorded.

**Deaths nobody witnessed still count.** Agents crash, sessions end, work is
abandoned. Nobody returns to a dead session to file a report, so a sweeper marks
runs idle past a threshold as failed with an inferred cause and `swept: true`.
Swept records are flagged so a reader trusts a reported cause more than
"nobody touched this for a week."

Retrieval is what justifies the record: dead runs are surfaced **scoped to the
paths an agent is about to modify**. "Two prior attempts died in this file, and
here is what killed them" is the entire return on keeping it.

## The outcome layer

A run says what was attempted. Git says what survived. Joining them costs
nothing and can be done retroactively.

For each run, for each path in `changed_paths`, take every line of that file at
HEAD and its `git blame` author-time. Lines authored inside the run's window —
`[started_at, finished_at + grace]` — are attributable to that run. The default
grace is 7 days, because work is routinely committed well after a run is marked
finished.

| Label | Condition |
|---|---|
| `survived` | Some attributable lines are still live at HEAD |
| `superseded` | Paths exist, the repo moved on after the run, nothing attributable remains |
| `absent` | The paths are gone from HEAD |
| `uncommitted` | The repo's newest commit predates the run — the work never reached git |

The `uncommitted` class is not optional bookkeeping, and omitting it is the
first mistake this method invites. Without it, a repo whose last commit predates
its runs reports every single run as "superseded," which reads as *the work was
replaced* when the truth is *the work was never committed*. On the corpus this
was written against, three of fourteen repos sit entirely after their final
commit; conflating the two inflated the apparent supersession rate from 5.9% to
14.4%. A run can only be superseded if the repo actually moved after it.

### Known limits

Line-survival is an approximation. It over-credits a run when a file was
otherwise churning during the same window, and under-credits when work landed
outside the grace period. It cannot see work that never touched tracked files.
Squashed history destroys author-time attribution. These are acceptable for
ranking and aggregate rates; they are not acceptable for per-run claims about
an individual agent's contribution.

### Why it appreciates

The labels are recomputed from current git state, so they update themselves. A
run recorded in May gets more accurate ground truth in September, for free,
because the repo kept moving. Nothing needs to be maintained for the record to
become more informative over time.

## What a record like this can answer

- Does an agent given a structured packet resume better than one given raw repo
  evidence? Replay real frozen repo states rather than synthetic fixtures.
- What breaks at handoffs between agents from different vendors?
- How often does self-reported `completed` correspond to work that survives?
- Do different models fail differently on identical real substrate?

The last one needs deliberate work-routing to be answerable; an organically
accumulated corpus is badly unbalanced across agents.

## Limits of the source corpus

One operator, one machine, roughly ten weeks. Every number is confounded by one
person's habits, prompting style, and project mix. It is an ethnography of a
single practice and should never be presented as a population. The schema is the
transferable part; the numbers are illustration.

## Adopting the format

Write JSON matching the run shape above, one file per run, under
`.seedrop/view/runs/`. Populate `changed_paths` — without it a run cannot be
linked to outcomes and most of the value is gone. Require `cause` on non-completed
finishes. Then `scripts/outcome-layer.mjs` labels the result:

```bash
node scripts/outcome-layer.mjs --root <repo>
node scripts/outcome-layer.mjs --corpus --json outcomes.json
```

It is read-only and never writes to a View.
