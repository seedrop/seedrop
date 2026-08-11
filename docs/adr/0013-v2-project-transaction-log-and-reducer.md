# ADR 0013: Canonical project transaction log and deterministic reducer

- Status: Accepted
- Date: 2026-08-11
- Scope: Seedrop v2 Wave 3, TR-07, TX-05, TX-06

## Context

V1 project truth is spread across mutable Run, Task, continuity, Signal, and manifest
artifacts. A logical command can therefore become partially visible, and independent
readers can derive different state. Seedrop v2 needs a repo-owned record that survives
process crashes, cache deletion, and Git replication without turning a local database
or adapter into another authority.

The v2 protocol already owns canonical JSON, IDs, versions, errors, command audits,
and lifecycle rules. It did not yet own the atomic Event or project-transaction
envelope. `@seedrop/project` existed only as a package boundary.

## Decision

### Protocol-owned canonical envelopes

`@seedrop/protocol` owns `ProjectEventEnvelope` and `ProjectTransaction`.

Every project transaction names its command, Principal, Project, idempotency key,
canonical input digest, prior transaction digest, caller-supplied canonical UTC time,
and one or more ordered Events. The complete native command and Event-type registries
remain open until the Intent/Episode/Lease vertical slice; storage accepts only a
strict namespaced Event shape and never assigns domain meaning.

The SHA-256 digest of the exact canonical transaction bytes is both its content
address and resulting project state version. `previous_transaction_digest` is the
input version for the single project chain.

### Immutable content-addressed publication

The store layout is rooted explicitly by its caller and contains:

```text
transactions/<digest-prefix>/<digest-hex>.json   canonical authority
staging/*.tmp                                    uncommitted, never authority
index/project-projection.json                    disposable projection
```

Publication writes a same-filesystem staging file, syncs it, atomically hard-links
the final digest path, syncs the containing directory, and only then returns a
Receipt. An existing path is idempotent only when its bytes are exactly equal.
Different bytes at the same address fail with a typed integrity error and are never
overwritten.

A crash before publish exposes no canonical transaction. A crash after publish may
expose the entire transaction. Staging artifacts are ignored as truth but remain
visible as diagnostics. A successful retry removes only redundant staging bytes that
exactly match the committed transaction.

### Honest discovery and quarantine

Discovery recursively accounts for every transaction-tree artifact. It verifies path
shape, raw digest, UTF-8, JSON, protocol shape, canonical byte equality, and Project
identity. Invalid, unexpected, corrupt, unreadable, or noncanonical source bytes are
preserved in place and represented by typed quarantine diagnostics. Nothing invalid
is silently skipped or automatically repaired.

### Deterministic reduction

The reducer is a pure function over validated transactions plus source diagnostics.
It follows exactly one previous-digest chain. Multiple roots, missing predecessors,
forks, cycles, duplicate commands, and duplicate Event IDs are explicit lag and
quarantine; the reducer never selects a lexicographic or last-writer winner.

The canonical projection contains the source-set digest, applied high watermark,
ordered applied transaction/Event references, lag counts, and quarantine records. It
contains no wall-clock generation time or machine-specific absolute path.

The persisted JSON index is disposable. Full rebuild is currently the reference
tail-catch-up algorithm. Deleting the index and rebuilding from the same canonical
files must produce byte-identical projection output. A future SQLite accelerator may
implement the same contract, but its physical database bytes are never a proof target
or authority.

## Invariants

1. A publisher acknowledges the whole canonical transaction or nothing.
2. A committed content address is immutable.
3. Canonical bytes and digests are identical on every supported Node major.
4. Staging and indexes cannot become project truth.
5. Every invalid source artifact remains visible with its relative path and typed code.
6. Reducer output is independent of filesystem discovery order.
7. Forks, gaps, cycles, and duplicate identities remain unresolved until an authorized
   later correction or repair Event exists.
8. A clean Git clone containing only canonical transactions rebuilds identical
   projection bytes, source digest, and high watermark.
9. V1 writers remain authoritative during Wave 3; no adapter or v1 path imports the
   new project package.
10. The separate `seedrop_db` experiment is not part of this storage path.

## Rejected alternatives

- **Mutable project head as authority.** A crash can expose a head that disagrees with
  Events, and Git merge history cannot verify it independently.
- **SQLite as canonical repo truth.** Physical bytes are not a portable semantic
  identity and would make cache corruption or platform support an authority failure.
- **Dual-writing V1 and v2.** This creates two competing histories before migration and
  shadow reconciliation exist.
- **Choosing a fork winner by timestamp, path, or digest.** Determinism would conceal
  unresolved authority rather than repair it.
- **Deleting or rewriting malformed sources during reads.** Observation is not repair;
  source evidence must remain available for an authorized later receipt.
- **Embedding `seedrop_db`.** The experiment remains off-trajectory until independent
  end-to-end evidence satisfies its promotion rule.

## Consequences

The project package now provides a correct shadow substrate for the next Wave 3
executor. It does not yet authorize commands, close the native Event registry, emit
outbox effects, perform multi-writer CAS, migrate V1 data, or serve adapters. Those
remain separately gated work.

## Verification

Authoritative evidence consists of:

- the frozen project-transaction fixture and Node 20/22/24 runtime-golden verifier;
- protocol exact-shape, timestamp, digest, Event uniqueness, and generated-catalog
  tests;
- project fault injection before/after write, file sync, publish, and directory sync;
- immutable retry and address-conflict tests;
- corrupt, malformed, noncanonical, wrong-Project, unexpected-path, and permission
  diagnostics with source-byte preservation;
- reducer permutation, root/fork/gap/cycle/duplicate, lag, and tail-catch-up tests;
- delete/rebuild byte equality and a real Git clean-clone reconstruction test;
- architecture-cycle/no-v1-import checks, durable-v1 freeze verification, full root
  tests, and all-workspace build.
