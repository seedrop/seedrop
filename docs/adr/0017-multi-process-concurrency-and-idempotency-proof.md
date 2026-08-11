# ADR 0017: Multi-process concurrency and idempotency proof

- Status: accepted
- Date: 2026-08-11
- Scope: Seedrop v2 Wave 3, PR-04
- Depends on: ADR 0014, ADR 0015, ADR 0016
- Authority: v2 shadow path only; v1 remains authoritative

## Context

The writer-lock, idempotency, and Lease tests used concurrent promises in one Node
process. They exercised asynchronous races, but could not prove that independent
processes agree through only the durable project substrate. PR-04 requires evidence
at 2, 8, and 32 writers across expected-version CAS, duplicate idempotency scopes,
and exclusive Lease acquisition.

## Decision

Add a forked-worker proof with IPC barriers and one shared on-disk Project root. Every
worker has a distinct PID, executor instance, clocks, and generated Kernel/Work IDs.
No worker shares an in-memory lock, cache, projection, or outcome with another.

Run three scenarios at each concurrency level:

1. **CAS append with governed retry.** Every worker reads the same genesis high
   watermark and waits at a snapshot barrier. The parent releases all writers
   together. One first attempt wins; at least N−1 stale attempts return typed project
   conflicts. Each loser rescans and retries until acknowledged. The final canonical
   chain must contain every returned Command ID and transaction digest exactly once,
   with no fork, quarantine, or unapplied transaction.
2. **Duplicate native open.** Every process sends a different requested Command ID
   but the same Project, Principal, command name, idempotency key, version, and
   payload. All callers must resolve to one winning Command ID and transaction digest;
   exactly one result is original and N−1 are idempotent replays. The Project contains
   one transaction and one Intent, Episode, Claim, Receipt, and Lease.
3. **Exclusive Lease race.** Every process sends a distinct native-open command and
   native record identities against one target and genesis version. Exactly one
   command commits. Every loser returns either the expected-version CAS conflict or
   the domain Lease conflict after observing the winner. The projection contains one
   active Lease for the target.

The dedicated command is:

```bash
npm run test:concurrency -w @seedrop/kernel
```

## Invariants

1. An acknowledged CAS result is never absent from the final canonical chain.
2. Stale expected versions fail explicitly and never fork project history.
3. CAS retry starts from a fresh complete projection; it never overwrites or selects
   a winner after a fork.
4. One idempotency scope has one logical Command and one transaction even when each
   caller proposes a different Command ID.
5. Idempotent replay does not create duplicate native records.
6. One Lease target has at most one active winner.
7. Every Lease loser receives a typed conflict rather than a false success or silent
   disappearance.
8. The proof uses Project files and process isolation, not `seedrop_db` or shared
   in-memory coordination.

## Rejected alternatives

- **Promise-only concurrency.** It cannot prove the filesystem lock works between
  runtimes with independent memory.
- **Start processes without a read barrier.** A scheduler could serialize all CAS
  reads and produce a green test with no stale-writer collision.
- **Assert only final transaction count.** That would miss an acknowledged write whose
  Receipt digest disappeared or was replaced.
- **Treat idempotent duplicates as conflicts.** Identical scoped input should converge
  on the original outcome; conflicting input remains a separate typed error.
- **Use a database lock or queue.** The Project transaction log and writer lock are the
  substrate under proof; adding another authority would invalidate the result.

## Verification

The focused suite launches 126 child processes per complete run: 42 for CAS append,
42 for duplicate open, and 42 for Lease contention. It verifies PID independence,
the barriered same-head collision, typed conflict counts, returned-to-persisted digest
equality, deterministic complete projections, one logical duplicate outcome, and one
Lease winner at 2, 8, and 32 processes.
