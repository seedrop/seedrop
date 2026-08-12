# ADR 0020: Deterministic shadow import of Principal and Project identity

- Status: Accepted
- Date: 2026-08-12
- Scope: Seedrop v2 Wave 4, TR-05 and TR-06
- Depends on: ADR 0008 and ADR 0019
- Authority: read-only shadow registry; v1 passports remain authoritative

## Context

ADR 0008 froze canonical Principal and Project contracts against a reviewed machine
fixture containing nine passports, 29 project links, 24 unique placements, and 23
canonical Projects. It deliberately did not define import ownership, deterministic ID
issuance, durable reconciliation evidence, or source immutability.

The live machine now contains a tenth passport (`jerry`). This is valid new state, but
it means the live corpus no longer equals the reviewed frozen baseline. Migration must
surface that drift rather than silently rebasing its source of truth.

## Decision

`@seedrop/migration` owns the v1 passport source adapter and deterministic identity
import. The adapter uses `@seedrop/id` only to validate the current passport schema,
performs stable reads, gathers read-only Git repository evidence, and returns protocol
Principal/Project candidates plus a content-addressed migration corpus. It exposes no
write operation.

Canonical IDs are deterministically minted from the entity kind and source reference
under a versioned import namespace and fixed UUIDv7 epoch. Candidate discovery order,
wall-clock time, and process identity therefore cannot change registry bytes.

Every Principal source must map exactly once. Every Project source must be either
mapped exactly once or present in the explicit unresolved queue; the two sets must be
disjoint. The admitted migration corpus record count must equal the number of
Principal plus Project sources. The Receipt binds registry digests, source-mapping
digest, counts, diagnostics, and unresolved references.

The reviewed fixture remains the Wave 4 frozen proof corpus. The live collector is a
separate immutability and drift detector: it hashes the complete v1 identity tree
before and after two imports, requires byte-identical reruns, and reports whether the
live corpus still matches the frozen baseline. It does not update that baseline.

## Invariants

1. Frozen 9-passport/29-link input reproduces 9 Principals, 24 placements, 23 Projects,
   and zero unresolved sources.
2. Every admitted source is mapped or explicitly unresolved; no source disappears.
3. Import bytes and digest are independent of discovery order and wall-clock time.
4. Registry and source-mapping digests are validated before a result is accepted.
5. Live passport, audit, and identity bytes are unchanged by collection/import.
6. Live drift is reported, never silently folded into the frozen migration baseline.
7. Project identity may include the `seedrop_db` placement as machine evidence, but
   this creates no package dependency, integration path, or product authority.
8. V1 passports remain authoritative; no cutover Receipt is issued.

## Verification

- frozen corpus exact-count and source-conservation tests;
- candidate-order and repeat-run byte equality;
- conflicting repository evidence enters the unresolved queue;
- unaccounted corpus records fail closed;
- live full-identity-tree before/after digest and repeat import proof;
- package, architecture, Wave 3 regression, root test, and all-workspace build gates.
