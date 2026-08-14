# PR-15 v2 arm is the live boot Situation — 2026-08-14

**Task:** `0bd55150`  
**Authority:** freeze/seal only; no provider spend

The PR-15 `v2_situation` / `packet_only` arms can no longer be a hand-rolled
brochure. Freeze requires `assertAdapterSituation` (the compiled adapter
envelope boot serves). `freezePr15ReplayFromServed` takes the bounded Situation
from `compileLiveBoundedSituation` and writes:

- `packet_only`: that adapter JSON alone (first-class replacement-economics arm)
- `v2_situation`: the same JSON plus frozen repository evidence

`scripts/pr15-corpus.mjs` now calls `compileLiveBoundedSituation` instead of a
parallel compiler that spawned `outcome-layer`.

## Arrange / Act / Assert

| Test | Assert |
| --- | --- |
| `situation/tests/adapter.test.ts` | brochure `{ health: { state: "healthy" }, orientation: {} }` is rejected |
| `id/tests/resumption-replay.test.ts` | freeze of a brochure throws; seal from bounded Situation matches `compileAdapterSituation`; packet_only has no repo; v2_situation does |
| `migration/tests/live-situation.test.ts` | live compile → freeze → `situation_id` / payload equal the adapter boot would serve |
| `npm run test:architecture` | `@seedrop/id` may consume `@seedrop/situation` as a read-only projection |

No provider calls. Gate A remains locked until an operator names an exact
call/attempt/USD ceiling **and** a corpus re-sealed through this path.
