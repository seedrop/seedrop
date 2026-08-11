# `@seedrop/project`

Seedrop v2's repo-owned canonical project-record boundary.

TR-02 establishes ownership without implementing storage: this package owns immutable
project transactions, receipts, and disposable projections. Their identifiers,
versions, and event meaning come from `@seedrop/protocol`. The canonical transaction
log, reducer, atomic publish, quarantine, and rebuild behavior arrive in TR-07.

This package is shadow-only. It does not write v1 View artifacts and it does not embed
the separate database experiment.
