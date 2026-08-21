# Default live v2 boot — 2026-08-14

**Task:** `0bd55150`  
**Authority:** v2 is the served object; v1 remains the write store and fallback  
**Status:** AAA for this slice. No provider spend. No outcome-layer on boot.

`seed boot --json` and `seedrop_boot` now serve live Situation (`mode=v2`) with
no feature flag. Writers (View, tasks, runs, passport, Space) stay v1.
`--v1` / `SEEDROP_V2_SITUATION=0` / MCP `v2_situation: false` still return the
v1 packet. Compile failure or digest mismatch still falls back to v1.

## Arrange / Act / Assert

| Test | Assert |
| --- | --- |
| `situation/tests/adapter.test.ts` | default argv serves v2; `--v1` and `SEEDROP_V2_SITUATION=0` opt out |
| `cli/tests/situation-binding.test.ts` | default boot argv enables live Situation; compile throw → v1 |
| `cli/tests/router.test.ts` | default `boot --json` is the binding envelope; `--v1` is the classic packet |
| `mcp/tests/server.test.ts` | `v2_situation` schema default is `true` |
| `mcp/tests/boot-v2-timeout.test.ts` | omitted/`true` raise 120s headroom; `false` passes `--v1` |
| `npm run verify:situation:live` | default CLI/MCP boot `mode=v2` without `--v2-situation`; `--v1` is classic v1 |

## Evidence (this repo, 2026-08-14)

| Check | Result |
| --- | --- |
| `npm test -w @seedrop/situation` | 20 passed |
| `npm test -w @seedrop/cli` | 157 passed |
| `npm test -w @seedrop/mcp` | 28 passed |
| `npm run verify:situation:live` | compile **6445ms**, CLI **7294ms**, MCP **7315ms**, 2778 bytes; `--v1` still classic v1 |

Observed ids (CLI and MCP identical, no `--v2-situation`):

- `situation_id`: `sha256:27561b92f04ea8f982be569540c8e6a1d2d591b0f83c63419bac627b33be15ad`
- `decision_id`: `sha256:36859359188b87d9f8549c71e21ca31765b1eeff7d1247804e6cbeff448622af`
- `next_action`: `resume_local_intent`

No provider calls. No dual-write. `seedrop_db` remains off-trajectory.
