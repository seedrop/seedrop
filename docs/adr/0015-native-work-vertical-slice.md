# ADR 0015: Native work vertical slice

- Status: accepted
- Date: 2026-08-11
- Scope: Seedrop v2 Wave 3, TR-09/TR-10 and TX-09/TX-10/TX-11
- Authority: v2 shadow path only; v1 remains authoritative

## Decision

Implement the first native work path as protocol contracts, a deterministic Project
projection, and Kernel command definitions. Do not add adapter cutover or use the
`seedrop_db` experiment.

The path has four commands:

1. `seedrop.work.open` creates one Intent, Episode, scope Claim, start Receipt, and
   exclusive Lease in a single canonical project transaction.
2. `seedrop.work.finish` completes Intent and Episode, appends an outcome Claim and
   finish Receipt, releases the Lease, and optionally commits a handoff outbox
   declaration in the same transaction.
3. `seedrop.lease.expire` appends an explicit expiry Event and Receipt after TTL.
4. `seedrop.work.correct` reopens a terminal Intent/Episode pair only through two
   explicit correction Events naming their exact prior state Events, then appends a
   correction Claim, Receipt, and fresh Lease.

All commands use the existing feature gate, Principal resolution, authorization,
strict request parsing, scoped idempotency, expected-version CAS, immutable project
transaction publication, outbox recovery, and command Receipts.

## Invariants

- The frozen protocol lifecycle table is the only ordinary transition authority.
- Terminal state is never mutated or represented as an ordinary transition back to
  active. Correction is a separate append-only Event and cites the exact Event it
  supersedes.
- A Lease is active until an explicit release, expiry, or revocation Event commits.
  Wall-clock passage alone never rewrites project truth.
- Expiry before `expires_at` is rejected.
- At most one active Lease exists for a target in a complete projection.
- Expected-version CAS decides races. Concurrent same-head acquisition has one
  canonical winner and cannot fork the transaction chain.
- A finish retry uses the original idempotency scope. A committed finish with a
  pending handoff resumes its outbox effect without replanning domain Events.
- Work Receipts retain the containing transaction digest and are queryable by
  Receipt, kind, Command, Principal, and subject.
- Native definitions consume only the executor's checked project snapshot. They do
  not read v1 files or create a second durable store.
- `seedrop.work.correct` is separately authorizable by command name. Adapters must
  default-deny it unless the Principal has explicit reopen authority.

## Package ownership

- `@seedrop/protocol` owns record versions, strict builders/assertions, event names,
  command names, lifecycle payloads, and the runtime golden vector.
- `@seedrop/project` owns deterministic work reduction and Receipt queries over the
  canonical transaction log.
- `@seedrop/kernel` owns native command definitions and exposes the complete project
  snapshot to them after replay and CAS preconditions are checked.

## Rejected alternatives

- Mutating terminal records in place: destroys negative knowledge and lineage.
- Treating elapsed wall time as implicit Lease expiry: makes projection depend on
  reader time and creates disagreement without an authoritative Event.
- A separate Lease database: creates split authority before the Project log is
  proven insufficient.
- Domain logic inside adapters: reproduces policy and transition drift.
- Adding these writes to v1 CLI/MCP now: violates the Wave 3 shadow-only gate.

## Proof obligations

The focused suites prove all five nouns in one transaction, finish/release,
queryable Receipt provenance, same-key replay, pending-effect restart recovery,
one-winner Lease contention, current-head target conflict, early-expiry rejection,
explicit expiry, authorized and denied correction, stale correction rejection,
deterministic projection rebuild, and cross-runtime canonical work bytes.
