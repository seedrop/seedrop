# @seedrop/observer

Read-only collector for Seedrop machine and project state. Shared by Bench and Seedrop Desktop.

```bash
seedrop-observe --json
seedrop-observe --passport ~/.seedrop/id/passport.json --space-url http://127.0.0.1:18791
```

Emits the same `BenchState` JSON shape used by Bench. Desktop maps that into human-readable cards.

The library also exposes `observeRepositorySources` for bounded content observation.
Its index is a disposable cache: a missing or invalid index causes an explicit
`full_fallback`, while a valid index reuses unchanged file digests. Callers declare
Git, artifact, schema, and policy source groups; the observer only reports digests
and never decides which claims are valid.

Wave 6 adds an opt-in `adapter_situation` field to the matching project. Use
`--v2-situation --situation-file <path> --situation-root <root>` (or the matching
environment variables). Observer validates and transports the canonical envelope;
its existing status/readiness derivation becomes only the serialized v1 fallback.
