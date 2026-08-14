# PR-15 corpus re-sealed through live boot — 2026-08-14

**Task:** `0bd55150`  
**Authority:** freeze/seal only; no provider spend

The on-disk PR-15 corpus is now compiled with `compileLiveBoundedSituation`,
the same compiler CLI/MCP boot uses. Freeze still requires the served adapter
envelope. `packet_only` is that JSON; `v2_situation` is that JSON plus frozen
repository evidence.

Machine-local output (not in git):

`~/.seedrop/benchmarks/pr15/wave7-2026-08-14-live-boot`

**Manifest SHA-256:** `ce62bc835d522a86b326ebddf4aef1825a332871682246d7084c6b02fd9c3188`

## Arrange / Act / Assert

| Gate | Assert |
| --- | --- |
| `npm run test:pr15-corpus` | verify refuses a freeze whose sibling manifest lacks `compiler: "compileLiveBoundedSituation"` |
| `npm run pr15:corpus -- --out …/wave7-2026-08-14-live-boot` | 15 repos, 0 failures, pipeline `1.1.0`, compiler `compileLiveBoundedSituation` |
| `npm run verify:pr15-served-corpus -- …/frozen` | 98 fixtures; every `packet_only` is the served adapter; every `v2_situation` adds repo evidence |
| same verify on `…/wave7-2026-08-13-b/frozen` | fails: `compiler` is missing (`undefined` ≠ `compileLiveBoundedSituation`) |

Adapter Situation envelopes stay under 4 KiB: 2,246 bytes minimum, 3,157 median,
3,346 maximum.

## Spend remains locked (98 / 100)

`ready_for_model_spend` is **false**. The only failed readiness check is
`independent_ground_truths` (98 observed, 100 required).

The 2026-08-13-b corpus had 101 facts. The three facts that did not reappear
are all `sendel_v2`:

- `relevant_failed_attempt:cause`
- `relevant_failed_attempt:retry`
- `unsafe_condition:risk-1`

Those probes were bound to a superseded grave synthesized by spawning
`scripts/outcome-layer.mjs`. Live boot does not spawn that process. sendel_v2's
View has no grave records, so the served Situation has `orientation.grave =
null` and no `grave:superseded` risk. Restoring those probes would put
evidence on the v2 arm that boot does not serve.

Do not lower the 100-fact contract to match this seal. Do not run Gate A
against 2026-08-13-b. Gate A still needs an exact operator call/attempt/USD
ceiling **and** a live-compiler corpus that meets the unchanged readiness
contract.

No provider calls were made.
