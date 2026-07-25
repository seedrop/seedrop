# Seedrop Bench Plan

Seedrop Bench is the local workbench for agent state across projects. It is not a dashboard and not a new source of truth. It reads the existing Seedrop contracts: passport `active_projects`, each repo's `.seedrop/view/`, and the loopback Space daemon.

## Product Spine

Bench answers one question:

> Where does agent work exist on this machine, and what deserves attention next?

The primary object is attention, backed by projects. Agents and passports are filters or inspectors; projects are where action resumes.

## Taste

- Codex-style workbench: dark, quiet, dense, inspectable.
- Left rail: project/work index grouped by state.
- Center: selected project Situation.
- Right inspector: identity, daemon, git, View, Space, and source evidence.
- Bottom status bar: current passport, daemon reachability, project counts, stale/dirty counts, refresh time.
- No marketing hero, decorative cards, onboarding prose, or dashboard spacing.

## V0 Boundary

V0 is observer-first. It can suggest commands, but it does not mutate state.

Mutations such as `seed view sync`, task claim/start, inbox ack, run start/finish, daemon install, or bootstrap require a later explicit action model with confirmations, audit evidence, and recovery copy.

## State Groups

- `broken`: missing project root, unreadable root, malformed critical View state.
- `attention`: stale manifest, failed preflight, dirty repo, open inbox, blocked/assigned tasks, daemon mismatch.
- `active`: active run, live claim, in-progress task, online presence.
- `quiet`: healthy View with no immediate attention.

## Task Backlog

1. `[bench 1] State model and fixture harness` — done
   Create `@seedrop/bench` with a read-only state collector over passport active projects and repo View context. Add fixture-driven tests for healthy, missing root, missing View, broken/stale View, and active work states.
2. `[bench 2] Local workbench shell` — done
   Add the Codex-style shell: project rail, Situation center, right environment inspector, bottom status bar.
3. `[bench 3] Attention ranking and project grouping` — done
   Rank and group projects by attention evidence.
4. `[bench 4] Read-only inspectors for tasks, runs, signals, inbox` — done
   Inspect primitives with copyable suggested commands.
5. `[bench 5] CLI entry and launch path` — done
   Expose `seed-bench`, then wire a future `seed bench`.
6. `[bench 6] Machine inventory and mature UX copy` — done
   Scan local Seedrop passports, dedupe shared project links, keep legacy non-Seedrop links out of the workbench, and simplify visible copy around projects, focus, next action, checks, activity, and sources.
7. `[bench 7] Project Situation view and agent provenance` — done
   Make the selected project the primary surface: repo state, contributors, blockers, tasks, and next work. Distinguish linked agents from agents seen in View history; default launch selection to the current repo when possible. No human notes or commit actions.
8. `[bench 8] Resumption clarity product contract` — done
   Define the read-only readiness contract: labels, degraded facts, evidence rules, contradictions, copy vocabulary, and recommended repair selection.
9. `[bench 9] Resumption state model and fixture matrix`
   Implement deterministic state fields for readiness, degraded facts, evidence sources, contradictions, dirty-state split, task-blocker state, validation freshness, and agent provenance.
10. `[bench 10] Resumption scorecard UI`
   Render one readiness label, concise reason, degraded facts, one recommended repair, and supporting evidence.
11. `[bench 11] Source disagreement and stale-evidence diagnostics`
   Explain boot-vs-preflight disagreement, cached audit freshness, tracked-vs-untracked dirty counts, validation freshness, and linked-vs-seen agents.
12. `[bench 12] Resumption visual and interaction QA`
   Verify fixture states, keyboard navigation, overflow, and screenshots.
13. `[bench 13] Explicit action model for mutations`
   Add carefully audited mutations only after observer Bench proves useful.
