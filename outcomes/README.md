# `@seedrop/outcomes`

Seedrop v2's deterministic external-outcome read model. It consumes immutable
Project transactions and projects validation evidence, delivery observations,
freshness, lifecycle reports, and contradictions without rewriting any source Event.

Reported completion is never validation or delivery. Missing observations remain
`unverified` and `unobserved`; observed absence is distinct from missing evidence.
The latest observation is selected by observation time and stable Event identity,
while an input-digest mismatch makes validation `stale`.

The package depends only on `@seedrop/protocol`, owns no writes, and remains
shadow-only until later Wave gates authorize an adapter surface.

Graves are a negative-continuity projection, not a tenth durable noun. Failed,
blocked, abandoned, superseded, and unresolved attempts retain their cause, scope,
evidence Events, source transactions, retry condition, corrections, provenance, and
completeness. A correction can make retry ready but never deletes the historical Grave.

The root live verifier projects the current Seedrop corpus twice in opposing input
orders, conserves every imported observation, and proves the View tree was not
mutated:

```bash
npm run verify:outcomes:live
```
