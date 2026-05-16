# Contributing to `@seedrop/id`

This document defines what's stable, what's internal, and how breaking changes are handled. It exists from day 1 so the package can grow without API churn surprises.

---

## Public API stability

A symbol is "public" if and only if it is:

1. Exported from `src/index.ts`, and
2. Documented in `README.md`, and
3. Covered by a test in `tests/`.

All three must hold. If any one is missing, the symbol is **internal** — subject to change without notice, regardless of TypeScript visibility.

### Stable from v0.1.0

The following will be stable once v0.1.0 ships. Pre-v0.1.0 alpha releases may break any of these.

- `Identity` (class)
- `Identity.fromPassport(path: string)`
- `Identity.prototype.session(opts)`
- `Identity.prototype.commitSession(session, opts)`
- `Session.prototype.record(message)`
- `Session.prototype.reconstruct()`
- `Session.prototype.coherence()`

### Explicitly unstable until v1.0

Even after v0.1.0:

- Internal slot routing and slot field names
- Classifier implementation (rule vs LLM vs hybrid)
- Harvester implementation
- Drift / coherence formula (the *return shape* is stable; the *value computation* is not)
- Embedding provider defaults
- Audit log format on disk

These will be marked `@internal` in source and may change between minor versions.

---

## Breaking changes

Breaking changes to stable API symbols require a **major version bump**. Period. No exceptions.

A breaking change is any of:

- Removing a stable export
- Renaming a stable export
- Changing the signature of a stable method in a way that breaks existing call sites
- Changing observable runtime behavior in a way that would make existing tests fail

If you're not sure whether something is breaking, treat it as breaking.

### How breaking changes are announced

1. Open an issue describing the change and its rationale.
2. Add a `### Breaking` entry to `CHANGELOG.md` under `[Unreleased]`.
3. Land the change behind a feature flag if it touches runtime behavior.
4. Release the major version with the flag flipped on by default.

---

## Slice-based development

Per the PRD, work proceeds in slices. Rules:

1. **One slice in flight at a time.** No parallel slices.
2. **Each slice is additive, tested, and shippable.** No "Slice N depends on Slice N+1 to work."
3. **Each slice has a ship-criterion in its PR description.** What test demonstrates this slice works?
4. **Each slice has a rollback plan in its PR description.** "If this breaks: revert this commit."
5. **Default to behind-flag for anything that changes observable behavior.** Ship dark, validate, then enable.

---

## Testing rules

- Tests live in `tests/`, not adjacent to source.
- File naming: `tests/<module>.test.ts`.
- Use `vitest`. No `jest`, no `mocha`.
- Coverage target: ≥95% lines, ≥90% branches on stable API surface. Internal modules are exempt.
- Integration tests that hit a real LLM are tagged `// @integration` and skipped by default. Run with `npm run test:integration` (added when the first integration test lands).

---

## Commit and PR conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- One slice per PR. No "Slice 1 + Slice 2" PRs.
- PR description includes: what slice, ship-criterion, rollback plan.
- No CCL or Memo code imports. Algorithms are re-implemented; references in comments are fine.

---

## Honest negative results

If a slice's ship-criterion fails, the response is:

1. Document the failure in the PR.
2. Reassess whether the criterion was right or the design was wrong.
3. Do **not** silently weaken the criterion to make the slice pass.

This rule applies especially to the commitment-erosion benchmark (Slice 6). If the benchmark shows `@seedrop/id` doesn't beat the unprotected baseline, that result gets published as-is.
