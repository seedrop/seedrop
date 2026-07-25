# Bench Resumption Clarity

Bench exists to answer one product question:

> Can this project be safely resumed right now?

The answer must be deterministic, local-first, and evidence-backed. Bench is not a memory graph, a dashboard, or a mutation surface. It is a read-only resumption layer over Seedrop identity, repo View, Space, tasks, runs, validation, and git state.

## Product Contract

For the selected project, Bench must show:

1. **Readiness** — one label and one sentence.
2. **Degraded facts** — the few facts that prevent safe resumption.
3. **Evidence** — source, freshness, and scope for every degraded fact.
4. **Recommended repair** — one highest-leverage read-only recommendation.
5. **Supporting state** — agents, tasks, repo, validation, and source paths.

No action buttons in this phase. No human notes. No commit flow. Suggested repairs are explanatory text and commands only.

## Readiness Labels

Readiness is project-local by default. Machine-level health can degrade confidence, but should not obscure project facts.

| Label | Meaning | Typical copy |
|---|---|---|
| `Ready` | Evidence is fresh enough, no blockers, validation is acceptable, and git state is clean or intentionally captured. | "Ready to resume." |
| `Active` | Current work exists and can be resumed, but it is not clean enough for handoff. | "Active work is present." |
| `Review` | Work can proceed only after reviewing degraded evidence such as dirty state, stale source, or agent mismatch. | "Review before resuming." |
| `Blocked` | A task, missing View/root, failed validation, or explicit blocker prevents safe continuation. | "Blocked by recorded work state." |
| `Unknown` | Required evidence is missing or contradictory enough that Bench cannot make a safe claim. | "State is unknown." |

Readiness is not a score. Do not show percentages. Do not expose hidden weights in the UI.

## Degraded Fact Taxonomy

Each degraded fact has:

```ts
{
  kind: string;
  severity: "critical" | "high" | "medium" | "low";
  source: "passport" | "view" | "git" | "space" | "validation" | "bench";
  scope: "project" | "machine";
  label: string;
  detail?: string;
  evidence_path?: string;
  observed_at?: string;
}
```

### Critical

- Project root missing.
- `.seedrop/view` missing or unreadable.
- View manifest cannot parse.
- Latest validation failed for the active/next work.
- A selected task is blocked by open blockers.

### High

- Boot/source freshness disagreement: one authoritative surface reports stale/failed evidence while another reports fresh/pass.
- Dirty tracked paths overlap the current or latest run changed paths.
- Active run exists with no validation yet.
- Space daemon is required by the project and unreachable.
- Passport identity is missing or ambiguous.

### Medium

- Dirty tracked paths exist but do not overlap known run paths.
- Untracked project package/docs exist.
- Agent is seen in View history but no longer passport-linked to this project.
- Legacy `agent` identity appears in recent View evidence.
- Open unowned tasks exist.
- Validation is unknown or stale.

### Low

- Quiet projects with old but valid evidence.
- Multiple linked agents but no recent activity.
- Machine inventory contains missing roots outside the selected project.

## Evidence Rules

Bench may combine sources, but must not flatten them into a single vague truth.

| Source | Owns | Does not own |
|---|---|---|
| Passport | current identity, active project links, current focus | repo truth, historical project membership |
| View | runs, tasks, signals, validation, continuity, project-local evidence | machine-wide identity truth |
| Git | dirty state, tracked/untracked split, branch if available | task ownership or intent |
| Space | daemon reachability, live presence, inbox | durable repo handoff by itself |
| Bench | derived readiness, degraded fact grouping, recommended repair | source of truth for Seedrop state |

When sources disagree, Bench shows the disagreement as a degraded fact. It should not silently pick one unless the rule is explicit.

## Contradiction Rules

Contradictions are first-class product output.

| Contradiction | Readiness impact | Repair candidate |
|---|---|---|
| Boot says stale/failed, direct preflight passes | `Review` | Refresh or explain cached audit/source freshness |
| Passport linked agents differ from View-seen agents | `Review` unless active task depends on the unlinked agent | Reconcile project membership |
| Git dirty count differs between sources | `Review` | Inspect tracked/untracked split |
| Latest run validation passed but current run is active/unvalidated | `Active` or `Review` | Validate current run |
| Task is claimed but has open blockers | `Blocked` | Inspect blockers before proposing work |
| Legacy identity appears in active evidence | `Review` | Attribute legacy runs or leave as historical |

## Recommended Repair Selection

Bench shows exactly one recommended repair. Selection order:

1. Critical missing substrate: root missing, View missing, unreadable View.
2. Failed validation or blocked active/next task.
3. Source contradiction that makes evidence untrustworthy.
4. Dirty tracked state that prevents clean handoff.
5. Agent membership mismatch affecting active/next work.
6. Unknown/stale validation for active/next work.
7. Open unowned task queue.
8. Machine-level daemon/passport health.

The repair must be phrased as explanation first, command second:

```text
Refresh View evidence
Boot reports stale evidence while direct preflight passes. Inspect cached audit before choosing work.
seed view audit --json
```

Do not show multiple equal next actions in the primary scorecard. Secondary details may list the rest.

## Copy Vocabulary

Use mature, plain product language.

| Prefer | Avoid |
|---|---|
| Ready | Healthy |
| Review | Needs attention |
| Blocked | Broken, bad |
| Degraded | Problematic |
| Evidence | Debug data |
| Source | Backend |
| Repair | Fix now |
| Seen in View | Historical |
| Linked | Active project if ambiguous |
| Legacy identity | Unknown agent |

Do not say "hallucination" in the product UI. The user-facing concept is "unsafe resumption" or "untrusted evidence."

## Acceptance Matrix

| Fixture | Expected readiness | Primary degraded fact | Recommended repair |
|---|---|---|---|
| Clean project, View present, validation passed, no dirty paths | `Ready` | none | none |
| Active run, dirty tracked paths overlap changed paths, validation pending | `Active` | active work is unvalidated | validate current run |
| Dirty tracked paths, latest validation passed, no active run | `Review` | tracked local changes | inspect or commit/stage later |
| Boot stale/failed but direct preflight passes | `Review` | source disagreement | refresh/explain cached audit |
| Missing root | `Blocked` | project root missing | locate or unlink project |
| Missing View | `Blocked` | View missing | run `seed view init` or bootstrap |
| Claimed task with open blockers | `Blocked` | task blocked | inspect blockers |
| Claude seen in View, not passport-linked | `Review` | agent membership mismatch | reconcile project membership |
| Legacy `agent` with recent active evidence | `Review` | legacy identity | attribute or leave as historical |
| Space daemon offline, project uses Space | `Review` | Space unreachable | check daemon |
| Machine has missing project outside selected project | selected project unchanged; machine badge degraded | machine inventory degraded | inspect machine inventory |

## Current Seedrop Example

As of this planning slice, the selected `seedrop` project should not be "Ready":

- View is present.
- Git has tracked dirty paths and untracked Bench/docs.
- There are open and blocked tasks.
- Claude is seen in View but not passport-linked to `seedrop`.
- Legacy `agent` identity appears in View history.
- Boot reports stale/failed freshness while direct preflight passes with only a git warning.

Expected readiness: `Review`.

Recommended repair: source disagreement first if boot/preflight evidence still conflicts; otherwise inspect dirty state before task switching.

## Non-Goals

- No repair buttons.
- No commit/stage flow.
- No human notes.
- No background mutation.
- No semantic memory.
- No global company-memory graph.
- No replacing Seedrop source files as truth.

## Implementation Sequence

1. Add the resumption model and fixture matrix.
2. Render the scorecard from the model.
3. Add source disagreement diagnostics.
4. Add visual and interaction regression coverage.
5. Only then revisit mutation surfaces.
