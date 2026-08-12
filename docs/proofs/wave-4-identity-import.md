# Wave 4 identity-import proof

- Date: 2026-08-12
- Task: `63dc848d` (`TR-05` / `TR-06`)
- Authority: shadow-only; v1 passports remain authoritative
- Governing decisions: ADR 0008, ADR 0019, ADR 0020

## Frozen reviewed corpus

Command:

```bash
npm run verify:identity-import -w @seedrop/migration
```

| Measure | Result |
| --- | ---: |
| Passport sources | 9 |
| Project-link sources | 29 |
| Unique placements | 24 |
| Canonical Principals | 9 |
| Canonical Projects | 23 |
| Unresolved Project sources | 0 |
| Repeat import | byte-identical |
| Import digest | `sha256:36b8895664e22139eb3dc0761267e6abf80f7e88c76a2ec8901ea69c5c8b2c4f` |

Every Principal source mapped once. Every Project source mapped once or would have
appeared in the explicit unresolved queue; this corpus has no unresolved sources.

## Current live read-only corpus

Command:

```bash
npm run verify:identity-import:live -w @seedrop/migration
```

| Measure | Result |
| --- | ---: |
| Passport sources | 10 |
| Project-link sources | 32 |
| Unique placements | 25 |
| Canonical Principals | 10 |
| Canonical Projects | 23 |
| Unresolved Project sources | 0 |
| Repeat import | byte-identical |
| Full v1 identity tree before/after | unchanged |
| Equals frozen migration corpus | no |

The live difference is expected evidence: the `jerry` passport and its links were
created after the reviewed nine-passport fixture. The importer reports the drift and
does not rewrite the frozen baseline, v1 passports, audit history, or any identity
source bytes.

## Failure proofs

Automated tests also prove that:

- discovery order cannot change registry bytes or the import digest;
- conflicting repository identities retain every source in the unresolved queue;
- a corpus record count that cannot account for every identity source fails closed;
- tampered registry, mapping, digest, count, or target references are rejected.

This proof does not authorize source cutover or make `seedrop_db` part of the product
dependency graph. Its placement remains ordinary machine identity evidence only.
