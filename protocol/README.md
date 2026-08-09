# `@seedrop/protocol`

Seedrop v2's transport-neutral contract boundary. This prototype owns:

- typed, canonical UUIDv7 entity identifiers;
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

See `docs/adr/0007-v2-canonical-protocol-mechanics.md` and
`fixtures/golden-v2-contract.json` for the frozen decisions and cross-runtime vectors.

After building, `node scripts/verify-golden.mjs` verifies those vectors using only
Node's standard library and the published package output, making the same proof easy
to run under every supported Node major.
