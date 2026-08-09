# @seedrop/observer

Read-only collector for Seedrop machine and project state. Shared by Bench and Seedrop Desktop.

```bash
seedrop-observe --json
seedrop-observe --passport ~/.seedrop/id/passport.json --space-url http://127.0.0.1:18791
```

Emits the same `BenchState` JSON shape used by Bench. Desktop maps that into human-readable cards.
