# Wave 1B gate — Daemon and runtime containment

- **Status:** passed
- **Executed:** 2026-08-09
- **Task:** `9b058b86-04d3-4c43-b01a-e499625d5452`
- **Frozen v1 contract:** `fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b`

## Closed work

| Slice | Product boundary | Commit | Gate evidence |
|---|---|---|---|
| DC-07 | Space membership authorization and bounded bodies | `f03323d` | protected routes default-deny; every request body is globally bounded |
| DC-08 | Canonical daemon data root | `253f5f9` | migration is previewable, backed up, reconciled, read-only at the legacy root, and rollback-safe |
| DC-09 | Observational continuity | `46c4fc0` | partial fetches do not advance the watermark or presence |
| DC-10 | Retry containment | `0c322e9` | request-id replay suppresses duplicate messages and mentions |
| DC-11 | Desktop child containment | `e544f46` | stdout/stderr drain concurrently; output is bounded and UTF-8 safe; hung process groups receive bounded TERM/KILL escalation |
| DC-12 | Sealed daemon identity | `e544f46` | exact runtime manifest/source identity; fail-closed tamper checks; restart with source and system toolchain unavailable |
| TX-12 | Transactional post effects | `a08a70c` | durable outbox, deterministic effect keys, leases, dead letters, and explicit repair |
| TX-13 | Transactional passport mutations | `8163a76`, `5b132ac` | canonical cross-process lock, expected-hash CAS, idempotency, audit integrity, and process-death repair |
| TX-14 | Explicit continuity acknowledgement | `187ee3c` | content-addressed page, locked watermark CAS, one presence effect, replay no-op |
| PR-08 | Identity and authorization matrix | `e1940c4` | alias canonicalization/ambiguity, dynamic admission, route denial, and body-limit permutations |
| PR-09 | Outbox and watermark matrix | `1c61e14` | four crash boundaries, poison repair, partial fetch/retry, and acknowledgement concurrency |

All eleven blocker tasks are durably `done`.

## Gate results

| Surface | Result |
|---|---|
| Identity | typecheck/build passed; `243` tests passed, `3` intentionally skipped |
| Space daemon | typecheck/build passed; `398/398` tests; direct and HTTP smokes `15/15` each |
| CLI | typecheck/build passed; `150/150` tests; composition smoke `27/27`; packed-install smoke `11/11` |
| MCP | typecheck/build passed; `24/24` tests; protocol smoke `5/5` |
| Desktop web/release controls | typecheck/build passed; Vitest `7/7`; release-control tests `3/3` |
| Desktop native containment | Cargo `13/13`; Clippy passed with warnings denied |
| Sealed runtime | regenerated from current sources; `4043` manifest entries verified; isolation suite `4/4` |
| Unsigned developer artifact | local arm64 artifact gate passed at `113.6 MB`; signing and notarization are intentionally not claimed |
| Durable compatibility | `64` frozen artifacts and `3` accepted transitions unchanged |

The freshness gate initially rejected the previously generated Desktop runtime because its source hash no longer matched current Seedrop. Regenerating the ignored local runtime restored provenance agreement, after which verification and isolation tests passed. This is positive fail-closed evidence, not a source correction.

## Operational truth

The installed workspace daemon currently reports:

```text
service=seed-space
version=0.2.0-alpha.5
runtime_profile=development
build_hash=development-unsealed
runtime_root=/Users/mc/Projects/seedrop/cli
```

That profile is explicit and non-release. The sealed Desktop runtime separately proves startup and restart with workspace source and the system Node/toolchain unavailable. Desktop remains a developer preview until a signed, notarized artifact passes strict `npm run release:verify -w @seedrop/desktop`.

## Exit decision

Wave 1B is closed. The daemon/runtime hazards named by the gate now either converge transactionally, fail closed with explicit repair, or identify themselves as a non-release development profile. The database experiment remains outside this trajectory until it demonstrates black-on-white approximately 10x product value.
