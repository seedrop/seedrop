# Live Situation boot AAA — 2026-08-14

**Task:** `0bd55150`  
**Authority:** v2 shadow path only; v1 remains served on compile failure  
**Status:** AAA for this slice. No provider spend. No next Wave 7 question until this gate stays green.

Live boot no longer spawns `scripts/outcome-layer.mjs`. That process was ~25s of a
~32s compile (git blame over changed paths). Outcomes and graves on the boot path
come from imported View transactions. An explicit `outcome_report_path` remains
available for Wave 5 verifiers.

## Arrange / Act / Assert

| Test | Assert |
| --- | --- |
| `migration/tests/live-situation.test.ts` fixture | 4 KiB, View unchanged, deterministic with outcome report |
| same file, boot path | trap `scripts/outcome-layer.mjs` exiting 99 is not spawned; still deterministic |
| `cli/tests/situation-binding.test.ts` | live compile served as `mode=v2`; compile throw → `projection_missing` v1 |
| `mcp/tests/boot-v2-timeout.test.ts` | `v2_situation` passes `V2_SITUATION_BOOT_TIMEOUT_MS` (120s headroom); v1 keeps default |
| `npm run verify:situation:live` | compile ≤ 8s; CLI boot ≤ 15s; MCP boot ≤ 15s; same `situation_id` / `decision_id`; View unchanged |

## Evidence (this repo, 2026-08-14)

| Check | Result |
| --- | --- |
| `npm test -w @seedrop/migration` | 34 passed |
| `npm test -w @seedrop/cli` | 155 passed |
| `npm test -w @seedrop/mcp` | 27 passed |
| `npm run verify:situation:live` | compile **6738ms**, CLI **7320ms**, MCP **7388ms**, 2691 bytes |

Observed ids (CLI and MCP identical):

- `situation_id`: `sha256:a86ec41e63615d28783aa68ecb458278aca68b09785a8fd8dcf78f78012bad3e`
- `decision_id`: `sha256:e22e6c7aeb9377055e3d4446c25434db34321e3465717610145469f881667029`
- `next_action`: `resume_local_intent`

A running MCP server does not need a reload for this to work: compile now fits
the default 15s spawn. The 120s timeout is headroom only.

No provider calls. No write cutover. `seedrop_db` remains off-trajectory.
Gate A / Q1 / Q2 remain locked behind [WAVE-7-PRODUCT-QUESTIONS.md](../v2/WAVE-7-PRODUCT-QUESTIONS.md).
