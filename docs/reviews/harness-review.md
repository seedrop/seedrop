# Seedrop Review — DeepSeek Harness (`dsh` agent)

**Author:** `dsh` (DeepSeek Harness, operated via the roost-node work)
**Date:** 2026-08-15
**Scope:** alpha `0.2.0-alpha.5`, exercised from the CLI/daemon surface only
(not the MCP tool, not the desktop app).

> This is a candid experience review, not an exhaustive audit. It records what
> a real agent experienced the first time it booted Seedrop against a fresh
> repo and against a live repo, and the defects that surfaced.

---

## What was exercised

- `seed doctor`, `seed whoami`, `seed login <agent>`
- `seed bootstrap` (fresh repo link + `.seedrop/view/` creation)
- `seed view init` / `seed view sync` / `seed view brief` / `seed view preflight`
- `seed boot --json` (the Situation packet)
- `.seedrop/view/policy.json` authoring + `seed view preflight` validation
- daemon health (`GET 127.0.0.1:18791/health`)

## What impressed me

1. **The mental model is genuinely right-legged.** "An agent is an entity with
   its own state — identity, orientation, coordination — all file-backed" is
   exactly the critique agents actually need. Seedrop fights the same enemy
   that roost-node fights, one layer up: durable *orientation* next to durable
   *execution/ownership*.
2. **`seed boot --json` is coherent with almost no assembly.** Identity, place,
   mission, freshness, coordination, safety, trust, outcome, continuity — a
   structured packet a cold session can consume directly. Nothing left
   localhost.
3. **The daemon health envelope is clean and self-describing.** It reports
   schema version, build origin, data root, and the registered passport set in
   one parseable JSON response.
4. **The philosophy is honest.** "No embeddings. No cloud. No vendor lock. The
   files are the contract." The pitch matches the mechanics.

## Concrete defects I hit

### 1. `seed bootstrap --help` mutates state (high severity)

```text
$ cd /Users/mc/projects/roost-node
$ seed bootstrap --help
passport: .../agents/jerry.json
linked active project: roost-node
linked repo: /Users/mc/Projects/roost-node
```

Running `bootstrap --help` **executed the bootstrap** — it linked the repo and
wrote `.seedrop/view/` — instead of printing usage. For a tool whose contract
is "read-only until you explicitly write," a `--help` flag that performs a
state-mutating write is a footgun. This is the one defect that should be fixed
before anything else.

**Suggested fix:** treat `--help` as a no-op that renders the command help, and
never run `apply()` on a help path. Add a regression test that asserts
`bootstrap --help` leaves the workspace untouched.

### 2. Identity linking happens under a silently-stale login (high severity)

`seed whoami` reported `agent: jerry ← mc` (a `seed login` left over from
another shell), so the first bootstrap linked the repo under `jerry` with no
warning that I was about to act as that agent. Nothing surfaced "you are
linking as `jerry`" at the moment of the write. I only caught it because the
operator told me `jerry` is a different agent.

Seedrop's own brand is "fragmented truth is the enemy," yet identity —
the foundational axis — is easy to get silently wrong across shells.

**Suggested fix:** `bootstrap` (and any write that keys on the active passport)
should print the active identity prominently as part of its non-`--json` output,
or require an explicit `--as <agent>` when the login was established in a
different shell/ttl than the current one.

### 3. "Commit-friendly" is in tension with the tool's own practice (medium)

The README calls the View "the only Seedrop artifact that can live inside a
repo and be committed," but Seedrop's *own* repository ignores `.seedrop/`
entirely and commits a hand-curated mirror under `docs/examples/view/` instead.
The live view's `manifest.json` is machine-specific (file hashes +
`updated_at`), so it churns on every `sync` and would fight version control.

In practice I committed `.seedrop/view/` but gitignored `manifest.json`. That
works, but it is not the clean "orientation in git" story the pitch implies,
and a naive user who commits the whole `.seedrop/` tree will get perpetual
churn and cross-machine conflicts.

**Suggested fix:** document a canonical "commit the view" recipe (which files,
which ignored), or make `manifest.json` intentionally stable (relative paths,
no wall-clock `updated_at`) so the live view truly is commit-friendly.

### 4. The success-level gate is a bootstrapping chicken-and-egg (low/medium)

Authoring a `policy.json` with `required_success_level: "L4"` immediately
produced `[fail] view_success: L1 Present` — "the view exists but is not yet a
useful orientation packet." True, and arguably correct, but it means the first
thing a policy demands cannot be satisfied on first boot: the level only
climbs after agents accumulate continuity entries and outcome evidence, which
nothing auto-populates.

**Suggested fix:** make the level ramp explicit — e.g. an "L1 until first
outcome, then L4" progression or a `bootstrapping: true` escape hatch — so the
gate reads as "earn it over time" rather than "you already failed."

### 5. Two different `view` surfaces (low, papercut)

`seed view` (repo orientation) and `seed-space view` (coordination-space view)
share the `view` verb with different semantics. The help router surfaces both,
and it was not immediately obvious which one "boot the view" meant.

### 6. The system is pull-free (structural, not a bug)

The headline "cold boot → one-line next action" only realizes after an agent
has written runs, logged continuity, and attached validation evidence. Nothing
captures that automatically, and in practice I had no instinct to do it
mid-work; I only touched `seed` when the operator asked. Seedrop lowers the
friction of *using* orientation but does not remove the requirement that an
agent *choose* to feed it.

## Bottom line

Seedrop is a genuinely sensible durable-orientation layer — local, greppable,
vendor-neutral — and a natural complement to a durable runtime like
roost-node. As shipped alpha it has two high-severity UX defects worth
prioritizing (the `--help` mutation, and silent wrong-identity linking) and a
`commit-friendly` claim that needs either tooling support or clearer guidance.
I would adopt it for a repo where cross-session continuity matters, but pin
identity explicitly and treat the deterministic next-action as something you
earn by feeding it, not a default you get for free.
