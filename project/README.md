# `@seedrop/project`

Seedrop v2's repo-owned canonical project-record boundary.

The package owns immutable project transactions, receipts, and disposable projections.
Their identifiers, versions, event envelopes, and canonical bytes come from
`@seedrop/protocol`.

TR-07 stores one content-addressed canonical transaction file per logical project
write. Publication writes and syncs a same-filesystem staging file, atomically links
the final digest path, syncs the containing directory, and only then returns a
Receipt. Readers ignore staging as authority but report every orphan, malformed,
unreadable, noncanonical, digest-mismatched, or wrong-Project artifact.

An orphan staging file remains visible in `ProjectLogScan.diagnostics` as
`uncommitted_temp`, but it cannot make the canonical projection incomplete. Staging
has no address in the transaction chain; treating it as quarantine would let a crash
before publication prevent the safe retry that recovery requires. Transaction-tree
diagnostics continue to fail the projection closed.

The reducer is a pure function over the validated transaction set. It follows one
previous-digest chain, refuses to select a winner across roots, forks, gaps, duplicate
commands, or duplicate Events, and emits a deterministic projection with source-set
digest, high watermark, lag, and quarantine diagnostics. The persisted JSON index is
derived only: deleting and rebuilding it produces the same canonical projection bytes.

Wave 3 expected-version commits add a project-local cross-process writer lock around
snapshot validation, immutable publication, and projection rebuild. A live local
process lock is never stolen. An expired lock is recovered automatically only when
its owning local PID is provably dead; unknown or remote ownership fails closed.
While holding the lock, the store compares both the observed high watermark and the
transaction predecessor with the caller's expected version. A stale writer publishes
nothing. A crash after immutable publication is recovered by retrying the same
transaction, which rebuilds the disposable index and returns `already_committed`.

`reduceWorkProjection` folds registered native work Events in canonical chain order
into current Intent, Episode, Claim, Receipt, and Lease state. It rejects incomplete
logs, duplicate native identities, invalid state ancestry, early expiry, stale
correction targets, and overlapping active Leases for one target. Work Receipts keep
their Event and transaction digests and are queryable by Receipt, kind, Command,
Principal, or subject. The work projection remains disposable rather than becoming
a second authority.

This package is shadow-only. It does not write v1 View artifacts and it does not embed
the separate database experiment.
