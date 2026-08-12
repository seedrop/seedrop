# Wave 4 View-history import proof

Date: 2026-08-12

Task: `3087ca1c-0994-4e45-a069-372ca5013fdf`

Scope: TR-12 outcome observations and TR-16 View-history migration

## Fixture proof

The focused fixture admits six logical records across Tasks, Runs, continuity,
archived Signals, and an outcome-layer report. It includes malformed Task JSON and a
valid ContinuityPacket with no Run identity.

| Result | Count |
|---|---:|
| source records / transactions | 6 / 6 |
| imported | 4 |
| quarantined | 1 |
| unresolved | 1 |
| canonical events | 9 |

The malformed Task is quarantined with `invalid_json`. The packet is unresolved with
`continuity_run_link_absent`. Reversed record discovery produces identical import
bytes and digest. Tampering with the transaction-chain digest is rejected.

Command: `npm test -w @seedrop/migration`

Result: 14 tests passed, including all View-history fixture proofs.

## Live Seedrop View proof

The live verifier generated delivery observations against the current Git HEAD, then
collected and imported the same admitted source twice. It hashed the complete View tree
before and after both passes.

| Family | Imported | Quarantined | Unresolved | Total |
|---|---:|---:|---:|---:|
| Task | 157 | 0 | 0 | 157 |
| Run | 136 | 0 | 14 | 150 |
| ContinuityPacket | 0 | 0 | 106 | 106 |
| Signal | 134 | 0 | 0 | 134 |
| Delivery observation | 110 | 0 | 13 | 123 |
| **Total** | **537** | **0** | **133** | **670** |

The 670 logical records produced 670 chained Project transactions and 1,344 events.
The complete View tree digest remained
`sha256:843d407a3bf2ac10f2a7eaa607edbd57c11c4f78cc5576004c3c7a9b81ca0199`.
Both imports of the same admitted observation report were byte-identical.

Diagnostic occurrences were:

- `continuity_run_link_absent`: 106;
- `principal_unresolved`: 29.

Diagnostic occurrences exceed unresolved-record count when one record has both an
unresolved source Principal and a missing continuity/Run link. No record is counted
twice in reconciliation.

Command: `npm run verify:view-history-import:live -w @seedrop/migration`

Result: `ok=true`, source tree unchanged, byte-identical rerun, zero quarantines, and
exact conservation (`537 + 0 + 133 = 670`).

## Boundary proof

- The adapter imports the frozen public v1 schemas through `@seedrop/space/view`.
- Only `@seedrop/migration` depends on the v1 reader; v1 packages do not import the
  shadow package.
- No cutover state or writer is exposed.
- `seedrop_db` remains absent from the package graph and runtime path.
