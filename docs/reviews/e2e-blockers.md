# Agentic e2e blockers — consolidated findings

**Authors:** `zcode` (coding agent, session of 2026-08-16), folding in `dsh`'s
[`harness-review.md`](./harness-review.md) (2026-08-15)
**Scope:** alpha `0.2.0-alpha.5`, dogfooded in the seedrop repo itself — CLI,
daemon, view/success ladder, package gates, CI, and the v2 Situation boot.
**Question:** what prevents Seedrop from supporting agentic work end-to-end —
cold boot → identity → orientation → coordination → work → validation →
handoff — today?

Each item below was hit live in one of the two sessions unless marked
otherwise. Status markers: **live** (reproduced 2026-08-16), **fixed**
(committed this session), **reported** (dsh's review; not re-verified or still
present).

---

## A. Identity and write safety

### 1. `seed bootstrap --help` mutates state — live, high
Re-verified today: it links the repo and dumps the manifest instead of
printing usage. A help path that writes is the single worst footgun for an
agent exploring a tool. (dsh #1.)
**Fix:** no-op help rendering + a regression test asserting the workspace is
untouched.

### 2. Agents silently inherit the previous shell's login — live, high
This session ran a full turn as `dsh` — boot, continuity ack, space join —
before the operator noticed and corrected it. `seed login` is global,
cross-shell, mutable state; MCP clients read a different config, so there are
two sources of identity truth and neither is surfaced at write time. (dsh #2,
same root cause.)
**Fix:** every write keys on the active passport and must echo `acting as
<agent> ← <principal>` prominently; require an explicit `--as` when the login
predates the session.

### 3. No guardrails against cross-identity writes — live, high
Acting as `dsh`, this agent advanced dsh's continuity watermark and joined
dsh to `seedrop-team`. Nothing challenged the writes; nothing records that
they were performed by a different runtime. For multi-agent machines this is
the integrity hole: identity is trivially contaminable.
**Fix:** bind ack tokens to the session/presence that rendered them; journal
the acting runtime alongside the passport on every durable write.

## B. The success-level ladder

### 4. The ladder punishes work-in-progress — live, medium
A dirty tree or stale manifest pins the view at L1 — i.e., exactly while an
agent is working, policy "requires L3" and every read says the view failed.
Combined with dsh #4 (nothing auto-populates evidence, so first boot reads as
failure), the gate reads as "you already failed" rather than "earn it."
**Fix:** separate accumulated evidence (per-agent, durable) from
instantaneous hygiene (tree dirty, manifest stale) and report them as two
axes.

### 5. Per-agent levels are displayed as repo facts — live, medium
`seed view context` on the same repo reported L4 when read as `dsh` and L1
when read as `zcode`, with no attribution. A handing-off agent will quote the
level as repo state. `view explain success` and `view context` can also
momentarily disagree (they evaluate at different instants against moving
inputs).
**Fix:** attribute the level to the acting agent in every surface; one shared
evaluation path.

## C. Manifest and data hygiene

### 6. The manifest is 86% build artifacts — live, medium
40,220 tracked files; 34,825 are `desktop/src-tauri/target/`. Freshness can
never converge (`sync` re-walks churn), which permanently trips the ladder's
freshness criterion and bloats the view.
**Fix:** ignore rules for `target/`, `dist/`, and generated trees, with a
policy-visible ignore list.

### 7. "Commit-friendly view" vs the tool's own practice — reported, medium
dsh #3: the manifest is machine-specific (hashes + wall-clock `updated_at`),
and seedrop's own repo gitignores `.seedrop/` entirely.
**Fix:** a stable manifest (relative paths, no wall clock) or a documented
commit recipe.

## D. Gate and CI integrity

### 8. Hand-maintained gate data rots — fixed this session, class remains
`smoke:install` packed three tarballs while cli had grown `@seedrop/migration`
and `@seedrop/situation` deps; the consumer install 404'd against the
registry. Fixed in `57c59ab` by resolving the `@seedrop/*` closure from the
workspaces manifest. Class issue: gate scripts that duplicate package-graph
truth fail silently when the graph changes.
**Fix:** keep closure derivation single-sourced; add a meta-test that fails
when a local dep is missing from the packed set.

### 9. CI does not run the smoke gates; red tests ship — live, high
`.github/workflows/test.yml` runs typecheck + `npm test --workspaces` only —
no `smoke`, `smoke:http`, `smoke:install`. That is why a red `smoke:install`
sat unnoticed on this branch. Separately, the branch carried a failing mcp
test (v1-era `schema_version` probe vs the v2 envelope; fixed in `e30e909`,
pre-existing per stash check) — nothing enforced gates before commit.
**Fix:** mirror the full gate list in CI; add a pre-push/PR gate so a red
suite cannot land.

## E. Orientation payload quality (v2)

### 10. The served Situation is lossy at the fields that matter — live, medium
`seed boot` serves v2 in shadow with `warnings: budget_limited:
decision_text, grave_text, risk_text` and `health: degraded (healthy)`. The
boot packet elides exactly the risk/decision prose an agent needs to judge
whether continuing is safe, and reports "degraded" while the substrate is
healthy — two signals an autonomous consumer cannot act on correctly.
**Fix:** explicit elision markers with reasons, honest health decomposition,
and a flag to spend budget on grave/decision text.

### 11. The coordination ritual returns stale noise — live, low/medium
The documented session ritual ends with `seed space messages seedrop-team`;
its newest message is from June and concerns a different project. Ritual
steps that return noise train agents to skip them. Presence TTL (60s) makes
`seed space presence` empty unless religiously heartbeated.
**Fix:** scope spaces per workspace (or surface per-repo message filters) and
mark stale channels in the boot packet.

## F. Ergonomics

### 12. Router help and missing run introspection — live, low
`seed run --help` prints the `seed-space serve` usage block; `seed run status`
does not exist; two different `view` verbs (dsh #5).
**Fix:** per-command help in the router; a read-only `seed run status`.

### 13. Continuity ack is copy-paste-hostile — live, low
The ack command embeds a ~600-char token in wrapped terminal output; a manual
copy corrupts it (checksum mismatch, hit today) and the workaround is
scripting extraction from re-rendered output.
**Fix:** `seed continuity ack` with no token acks the latest page for the
acting identity; keep tokens for scripted use.

## G. The structural one

### 14. Orientation is pull-free — reported, structural
dsh #6: nothing captures runs, continuity, or validation automatically; the
agent must choose to feed Seedrop mid-work, and nothing builds that instinct.
Every papercut above raises the cost of that choice. This is the difference
between "an orientation layer agents can use" and "one agents do use."
**Fix direction:** capture at the seams agents already cross — MCP
post-tool-use hooks, git hooks auto-logging gate results, daemon-side
presence deriving run state — so feeding Seedrop is a side effect of working.

---

## Priority order

1. **P0 — trust foundation:** #1 help mutation, #2/#3 identity safety.
   Until identity cannot be silently wrong or contaminable, nothing built on
   it is safe for autonomous multi-agent use.
2. **P1 — truth of state:** #6 manifest hygiene (unblocks the ladder), #9 CI
   parity (so "gates green" means something), #8 class guard.
3. **P2 — experience:** #4/#5 ladder semantics, #10 Situation budgets,
   #11 stale coordination, #12/#13 ergonomics.
4. **Structural:** #14 decides whether e2e adoption happens at all.

## What already works

Worth recording because it is why the rest is worth fixing: the boot packet
is coherent and consumable cold (dsh's verdict too); the deterministic
Situation/decision hashes make orientation reproducible; per-agent evidence
attribution is the right idea once surfaced as such; the view's next-actions
(`sync` → `brief` → `preflight`) genuinely steered a fresh agent to L4 in one
session; and the package gates exist and pass when the graph is honest —
this session's two gate failures were both found, root-caused, and repaired
inside the loop Seedrop itself was orienting.
