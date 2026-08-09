# `@seedrop/protocol`

Seedrop v2's transport-neutral contract boundary. This prototype owns:

- typed, canonical UUIDv7 entity identifiers;
- versioned Principal aliases and Project placements with strict reconciliation;
- one versioned HealthEnvelope with source provenance, deterministic substrate state,
  disagreement traces, quarantines, projection lag, pending commands, and budget truth;
- strict deterministic JSON bytes and SHA-256 digests;
- a stable error-code registry and wire envelope;
- independent schema, semantic, command, projection, and wire versions;
- validated, forward-only migration plans.

The package is deliberately not connected to v1 writers. It freezes mechanics for
Wave 2 without changing the authoritative passport, View, Space, CLI, MCP, Bench,
Observer, or Desktop paths.

## Contract rules

- Stored and wire IDs are always full lowercase `sd_<kind>_<uuidv7>` values.
  Short prefixes are accepted only by the explicit input resolver.
- Canonical JSON accepts only the JSON data model. It rejects unsupported values,
  sparse arrays, non-plain objects, cycles, non-finite numbers, and lone Unicode
  surrogates instead of silently coercing or dropping data.
- Every protocol failure has a registered `seedrop.protocol.*` code. Messages,
  categories, and retryability are registry-owned rather than adapter-owned.
- Every version axis is explicit. Missing, malformed, forward, and unknown versions
  fail with typed errors.
- Migration plans are deterministic and forward-only. Their graph is validated when
  defined; downgrade and rollback require a source snapshot or compatibility reader,
  never an inverse transform guessed by the protocol. Applying a plan always requires
  a current-schema validator, including when the input already reports current.
- Principal aliases are resolved to a registered canonical Principal before a caller
  authorizes or persists a command. Alias collisions remain visible and fail closed.
- Projects merge only through exact placement evidence, shared Git common-directory
  identity, or normalized repository identity. A legacy name never merges Projects;
  conflicting repository evidence enters the unresolved queue.
- Worktrees are explicit Project placements, not independent Projects.
- Health is derived from structured evidence; callers cannot submit a green summary.
  Required source absence/unreachability, corruption, migration, stale projection,
  command recovery, budget overflow, and unresolved disagreement remain typed reasons.
- Contradictory source claims remain in the envelope. Only a versioned governing
  policy trace may select one; unresolved contradiction degrades health.

See `docs/adr/0007-v2-canonical-protocol-mechanics.md`,
`docs/adr/0008-v2-canonical-principal-project-identity.md`,
`docs/adr/0009-v2-health-envelope-and-disagreement.md`, and the fixtures for the
frozen decisions, cross-runtime vectors, and sanitized nine-passport machine corpus.

After building, `node scripts/verify-golden.mjs` verifies those vectors using only
Node's standard library and the published package output, making the same proof easy
to run under every supported Node major.

`node scripts/verify-identity-corpus.mjs` verifies the sanitized corpus. Add `--live`
to perform the same read-only reconciliation against this machine's current v1
passports and Git roots; it writes neither registry nor v1 state.

`node scripts/verify-health-golden.mjs` verifies canonical healthy, degraded,
corrupt, migrating, unreachable, governed-disagreement, and unresolved-disagreement
envelopes from built package output.
