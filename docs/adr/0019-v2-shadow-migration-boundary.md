# ADR 0019: Wave 4 shadow migration boundary

- Status: Accepted
- Date: 2026-08-12
- Scope: Seedrop v2 Wave 4, TR-16 and TX-15 foundation
- Authority: shadow import only; v1 remains authoritative

## Context

Wave 3 proved canonical Project transactions and one native transactional vertical
slice. The machine corpus is now large enough that migration is a product-critical
system, not a conversion script: nine passports, 29 project links, 24 unique roots,
17 meaningful Views, and machine coordination state must all remain attributable.

Migration must not create a second authority or silently normalize disagreement. It
also must not turn the separate `seedrop_db` experiment into a dependency before that
experiment independently proves roughly 10x end-to-end value.

## Decision

Add `@seedrop/migration` as a shadow-only modular-monolith package. It depends inward
on protocol contracts and canonical Project records. It owns read-only v1 source
admission, binding to an independently verified source snapshot, staged shadow import,
and reconciliation. It owns neither domain semantics nor adapter policy.

The Wave 4 state machine has exactly four states:

1. `preview`
2. `source_snapshot_verified`
3. `staged`
4. `verified_not_authorized_for_cutover`

There is deliberately no cutover state or cutover Receipt. A later wave may add one
only through a new accepted decision after full shadow parity; Wave 4 cannot infer or
issue it.

Every transition carries the same canonical source corpus. The corpus orders source
references deterministically and conserves source, file, byte, and logical-record
counts. Any digest or count drift stops the transition. Verification conserves every
source record as exactly one of imported, quarantined, or unresolved. A record may not
disappear merely because it is malformed or cannot be linked.

Staged Project references point into `@seedrop/project`; canonical transaction bytes
remain repo truth and projection indexes remain disposable. Machine coordination stays
machine-owned and will receive its own reconciliation receipt rather than being folded
into Project truth.

## Invariants

1. V1 source access is read-only; no source edit or deletion is authorized.
2. The verified snapshot and admitted live corpus must have identical digests/counts.
3. State transitions are forward, adjacent, and restartable from durable receipts.
4. Imported + quarantined + unresolved equals the admitted source-record count.
5. Cutover is unrepresentable in the Wave 4 contract.
6. V1 writers remain authoritative after successful verification.
7. No v1 package or adapter imports the shadow migration package.
8. `seedrop_db` is neither a dependency nor a storage implementation.

## Consequences

Wave 4 can now build identity, View-history, and coordination importers behind one
explicit safety boundary. The package does not yet perform filesystem discovery,
import records, stage transactions, reconcile the full corpus, or expose compatibility
readers; those are the remaining ordered Wave 4 tasks.

## Verification

- architecture graph and shadow-only import checks;
- package ownership/exclusion tests;
- deterministic corpus digest/count tests;
- serialization/restart tests at every representable state;
- source-drift, skipped-state, and record-loss rejection tests;
- root architecture test, package build/typecheck/test, and Wave 3 regression gate.
