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

The reducer is a pure function over the validated transaction set. It follows one
previous-digest chain, refuses to select a winner across roots, forks, gaps, duplicate
commands, or duplicate Events, and emits a deterministic projection with source-set
digest, high watermark, lag, and quarantine diagnostics. The persisted JSON index is
derived only: deleting and rebuilding it produces the same canonical projection bytes.

This package is shadow-only. It does not write v1 View artifacts and it does not embed
the separate database experiment.
