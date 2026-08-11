# `@seedrop/protocol`

Seedrop v2's transport-neutral contract boundary. This prototype owns:

- typed, canonical UUIDv7 entity identifiers;
- versioned Principal aliases and Project placements with strict reconciliation;
- one versioned HealthEnvelope with source provenance, deterministic substrate state,
  disagreement traces, quarantines, projection lag, pending commands, and budget truth;
- append-only command audit trails with canonical phases, recovery ownership,
  age/state invariant queries, and read-only sweep candidates;
- hash-chained repair Receipts with actor/evidence, before/after state, structured
  command identity, rollback truth, and recovery ownership;
- derived operational metrics for idempotency duplicates, CAS conflicts, retries,
  outbox lag, dead letters, and policy alerts;
- field-level explanations that either resolve confident values through evidence,
  policy, projection, and a decision record or preserve a typed unknown;
- a deterministic compiler whose successful bounded envelopes carry exact full-JSON
  UTF-8 byte, candidate, index, scan, inclusion, and omission accounting;
- local-only telemetry defaults plus explicit expiring consent Receipts, exact export
  scope, payload-category matching, and secret-pattern denial;
- strict deterministic JSON bytes and SHA-256 digests;
- a stable error-code registry and wire envelope;
- independent schema, semantic, command, projection, and wire versions;
- validated, forward-only migration plans.
- one executable completeness inventory whose generated catalog, top-level JSON
  Schema prototype, TypeScript bindings, human report, and golden digests fail CI
  if they drift independently.

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
- Every nonterminal command phase is explicitly recoverable; terminal phases cannot
  retain a recovery plan. Partial result versions remain visible during failure or
  pending effects, and sweep queries propose Events without mutating command state.
- Repair journals are project-local, append-only hash chains. Raw command arguments
  are excluded; command name and canonical input digest preserve audit identity.
- Operational counters and alerts are derived from immutable Event-backed spans;
  callers cannot submit a summary that disagrees with the evidence.
- A resolved material field cannot carry unknown confidence or omit its evidence,
  policy rule, projection version, value digest, and governing decision. Missing
  truth remains a typed unknown with an explicit evidence request.
- A successful bounded compilation always measures the canonical bytes of the whole
  returned envelope and never exceeds the request. Mandatory truth that cannot fit
  and scans beyond the declared bound fail with typed errors rather than truncation.
- Telemetry is local-only when consent is absent, denied, revoked, not yet active, or
  expired. Authorization additionally requires exact Principal, Project, destination,
  schema, category, and payload-category scope and rejects secret-pattern findings.

See `docs/adr/0007-v2-canonical-protocol-mechanics.md`,
`docs/adr/0008-v2-canonical-principal-project-identity.md`,
`docs/adr/0009-v2-health-envelope-and-disagreement.md`,
`docs/adr/0010-v2-command-audit-recovery-and-repair-receipts.md`,
`docs/adr/0011-v2-explainable-bounded-consented-observability.md`,
`docs/adr/0012-v2-protocol-completeness-and-generation.md`, and the fixtures
for the frozen cross-runtime vectors and sanitized nine-passport machine corpus.

After building, `node scripts/verify-golden.mjs` verifies those vectors using only
Node's standard library and the published package output, making the same proof easy
to run under every supported Node major.

`node scripts/verify-identity-corpus.mjs` verifies the sanitized corpus. Add `--live`
to perform the same read-only reconciliation against this machine's current v1
passports and Git roots; it writes neither registry nor v1 state.

`node scripts/verify-health-golden.mjs` verifies canonical healthy, degraded,
corrupt, migrating, unreachable, governed-disagreement, and unresolved-disagreement
envelopes from built package output.

`node scripts/verify-command-recovery-golden.mjs` verifies terminal/recoverable
command audit trails, age/state reports, a stale-command sweep proposal, and a
two-entry hash-chained repair journal from built package output.

`node scripts/verify-observability-golden.mjs` checks derived reliability metrics,
resolved and unknown explanations, exact bounded-output bytes, local-only default,
explicit consent authorization, and fail-closed budget, secret, and consent paths.

`npm run generate:artifacts -w @seedrop/protocol` deliberately refreshes the
generated completeness contract after a reviewed source change. Normal development
and CI use `npm run check:artifacts -w @seedrop/protocol`, which rebuilds the same
catalog, schema prototype, bindings, report, and golden digests in memory and fails
on byte drift. `node scripts/verify-protocol-generation.mjs` additionally verifies
the committed SHA-256 fixture and all registered public symbol links.
