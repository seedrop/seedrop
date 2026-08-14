# Live Situation on boot — 2026-08-14

**Task:** `0bd55150`  
**Authority:** v2 shadow path only; v1 remains served on compile failure

`seed boot --v2-situation --json` now compiles a read-only 4 KiB Situation from
the current repo View. `--situation-file` remains a fixture override. Failure
still serves v1 with `projection_missing`.

## Evidence

| Check | Result |
| --- | --- |
| `npm test -w @seedrop/migration` | 33 passed, including live-compile fixture |
| `npm test -w @seedrop/cli` | 155 passed, including live-bind success and compile-failure fallback |
| `npm test -w @seedrop/mcp` | 25 passed |
| `npm run test:architecture` | 3 passed; CLI may consume migration as a read-only projection |
| `npm run verify:situation:live` | 2554 bytes, `scanned_count=0`, View unchanged |
| `seed boot --v2-situation --json --peek` | `mode=v2`, `kind=v2_situation`, decision `resume_local_intent` |

Observed live ids from CLI (this repo, 2026-08-14):

- `situation_id`: `sha256:504a0cddb39727aaa8702c822e1b70dedb4f500850eadb4bdd34079e8597a093`
- `decision_id`: `sha256:cf2575591243ffb42f17306a47bad0c5b6ec72402a828e7b1666053c5a12b1b8`

Compile is currently ~36s on this corpus. MCP boot uses a 120s timeout for
`--v2-situation`; a running MCP server must reload to pick that timeout up.
Until then, CLI is the live proof path.

No provider calls. No write cutover. `seedrop_db` remains off-trajectory.
