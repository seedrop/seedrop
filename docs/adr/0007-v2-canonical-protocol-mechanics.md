# ADR 0007 — Freeze Seedrop v2 canonical protocol mechanics

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 task `TR-03/TR-04` / `45615f83`
- **Depends on:** ADR 0006
- **Durable v1 change class:** none; standalone v2 contract prototype

## Context

ADR 0006 freezes Seedrop v2's nouns, lifecycle models, domain-event boundary, and
orthogonal trust axes. Those semantics are not portable until all implementations
also agree on the mechanical protocol: identifiers, serialized bytes, errors,
version dimensions, and migrations.

The v1 corpus currently has multiple incompatible conventions:

- domain IDs are generated with ad hoc UUID calls and human-facing commands resolve
  raw string prefixes inside persistence-owning packages;
- identity audit hashing has a local key-sorting JSON function whose coercion rules
  are not a public protocol contract;
- errors range from class names and prose to independently written HTTP strings and
  partial `seedrop.*` codes;
- persisted schemas mostly report `1.0`, while the generic v1 reader treats a missing
  version as implicit `1.0` and real migration chains remain empty;
- package, command, projection, and wire compatibility are routinely collapsed into
  one npm version.

That is sufficient for a single implementation but not for generated adapters,
content-addressed events, cross-runtime receipts, or safe shadow migration. Wave 2
therefore needs one executable contract before any v2 writer exists.

## Decision

Introduce a standalone, transport-neutral `@seedrop/protocol` prototype. Nothing in
v1 imports it yet. It is executable specification, not a source-of-truth cutover.

### Canonical IDs

Native v2 protocol IDs have this exact storage and wire form:

```text
sd_<kind-code>_<lowercase UUIDv7>
```

The frozen kind codes are:

| Kind | Code |
| --- | --- |
| Principal | `prn` |
| Project | `prj` |
| Intent | `int` |
| Episode | `eps` |
| Claim | `clm` |
| Receipt | `rcp` |
| Lease | `lse` |
| Event | `evt` |
| Situation | `sit` |
| Command/idempotency identity | `cmd` |

UUIDv7 provides sortable creation time and 74 random bits without making a daemon or
database the ID allocator. The kind code prevents accidental cross-entity use. The
UUID timestamp is metadata, never authoritative event time or proof of ordering.

Only `resolveCanonicalIdInput` accepts a short prefix. It requires at least eight UUID
hex digits, scopes lookup to an expected kind, and fails typed on zero or multiple
matches. Persisted fields, events, hashes, receipts, logs, and wire responses always
contain the full canonical ID. Imported v1 IDs remain source aliases until TR-05/TR-06
reconciliation mints or resolves canonical Principal and Project identities.

### Canonical JSON bytes

`canonicalJsonBytes` is strict deterministic UTF-8 over the JSON data model:

1. object keys sort by UTF-16 code units;
2. arrays retain order;
3. strings and finite numbers use ECMAScript JSON escaping/number serialization;
4. negative zero serializes as `0`;
5. only null, boolean, finite number, valid-Unicode string, dense arrays, and plain
   string-keyed objects are accepted;
6. unsupported values, undefined fields/items, sparse arrays, hidden/symbol/accessor
   properties, extra array properties, non-plain objects, cycles, and lone surrogates
   fail typed rather than being dropped, executed, or coerced;
7. SHA-256 addresses are rendered as lowercase `sha256:<64 hex>`.

The golden fixture freezes text, bytes, Unicode behavior, digest, and an ID vector.
Event-specific content addressing remains TR-07: an Event cannot include its own
digest in the bytes being digested, and this ADR does not choose its envelope schema.

### Stable errors

Protocol errors use one closed `seedrop.protocol.*` registry. Each entry owns a stable
category, message, and retryability bit. Adapters may localize display text later, but
must preserve the code and structured details. They may not manufacture domain error
codes or infer HTTP/CLI behavior from message prose.

The initial registry freezes thirteen codes covering IDs, canonical serialization,
versions, migration graph integrity/execution, and post-migration validation. Adding
or changing a code is a semantic and wire compatibility decision, not an adapter edit.

### Independent versions

Every v2 protocol envelope makes five versions explicit:

| Axis | Initial version | Changes when |
| --- | --- | --- |
| Schema | `2.0.0` | persisted/event field shape or constraints change |
| Semantic | `2.0.0` | meaning or invariant changes without requiring the same byte shape |
| Command | `1.0.0` | accepted command names, inputs, preconditions, or result semantics change |
| Projection | `1.0.0` | Situation/reducer derivation or ordering changes |
| Wire | `1.0.0` | adapter-neutral request/response envelope representation changes |

Versions are strict three-part numeric values. Missing or malformed values fail
`version_invalid`; versions newer than the implementation fail `version_forward`;
well-formed but unregistered historical versions fail `version_unknown`. V2 never
inherits v1's implicit-missing-version rule.

### Ordered migrations and rollback boundary

A migration plan names a schema, current version, accepted roots, and deterministic
forward-only steps. Definition fails if roots cannot reach current, a version has
multiple outgoing edges, a step is backward, IDs repeat, or a step is unreachable.
The plan metadata explicitly records that steps are not reversible.

The initial `seedrop.protocol-envelope` plan has root=current=`2.0.0` and no transform;
the framework and tests prove a non-trivial two-step graph before the first real bump.
Future schema support requires adding a complete path and golden before accepting its
bytes. Every application requires current-schema validation, even when no transform
is needed. There is no generic downgrade. Rollback restores the pre-migration source
snapshot or uses a version-matched compatibility reader. A later migration command
must emit Receipts and retain quarantined source bytes; this prototype does not write.

## Invariants

1. Protocol generators are the only native v2 ID minting authority.
2. Kind mismatches and non-v7 UUIDs fail before authorization or persistence.
3. Prefixes never cross a storage, event, log, or wire boundary.
4. Equal accepted values produce byte-identical canonical JSON and equal digests.
5. Unsupported data never disappears through canonicalization.
6. Every protocol error code exists in the frozen registry.
7. No version axis is inferred from another axis or from package version.
8. Unknown and forward versions never enter a best-effort parser.
9. Every accepted migration root has one complete ordered path to current.
10. Migration transforms are pure in-memory functions; this package performs no I/O.
11. V1 remains authoritative until later shadow parity, migration, and cutover gates.

## Rejected alternatives

### Continue using bare UUIDv4 values

Rejected. They provide no entity-type guard and no common minting contract. UUIDv7 is
portable and sortable while retaining decentralized generation.

### Persist shortened IDs

Rejected. Prefix uniqueness is corpus-relative and changes as history grows. Prefixes
are input conveniences, not identities.

### Reuse identity audit `canonicalJSON` unchanged

Rejected. It silently omits undefined object fields and converts undefined at the
root to null. Content-addressed protocol bytes must fail when data is outside JSON.

### Adopt ordinary `JSON.stringify`

Rejected. Object insertion order would make addresses depend on construction history.

### Make HTTP status or exception class the error contract

Rejected. CLI, MCP, Desktop, and future adapters need the same semantic failure even
when their transport representations differ.

### Use the npm package version for all compatibility

Rejected. Schema, meaning, commands, projections, and wire representation evolve at
different rates and require different migration or refusal behavior.

### Allow graph discovery at runtime

Rejected. Ambiguity or a gap must fail at plan definition/build time, not halfway
through operator data.

### Generate reverse migrations automatically

Rejected. Most meaningful schema changes are not provably invertible. Snapshot restore
and compatibility readers keep rollback honest.

## Consequences

The protocol mechanics are now directly testable and can later generate schemas and
adapter bindings. TR-05/TR-06 can define Principal and Project identity without
reopening ID format, and VI/PR work can cite stable errors and version axes.

The strict JSON function intentionally differs from v1 identity hashing. No v1 hashes
or durable bytes change. A later consumer cutover must use explicit shadow comparison
and must not reinterpret old audit hashes as v2 canonical digests.

The package adds a modular boundary before TR-02 completes the broader dependency
architecture. That is deliberate: only the leaf contract exists now; kernel, project,
situation, outcomes, and adapter ownership remain gated.

## Verification

Authoritative proof consists of:

- `protocol/fixtures/golden-v2-contract.json`;
- `protocol/scripts/verify-golden.mjs`, run against every available supported Node
  major using built package output rather than the TypeScript test runner;
- focused tests for ID format/prefix behavior, canonical bytes/rejections, complete
  error registry, all version refusal classes, and gap-free migration graphs;
- package typecheck, test, and build;
- root workspace tests/build plus durable-v1 freeze verification;
- a current-tree check that no v1 package imports `@seedrop/protocol`.
