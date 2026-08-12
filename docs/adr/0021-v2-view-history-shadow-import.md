# ADR 0021: Deterministic View-history shadow transactions

- Status: Accepted
- Date: 2026-08-12
- Scope: Seedrop v2 Wave 4, TR-12 and TR-16
- Depends on: ADR 0013, ADR 0019, ADR 0020
- Authority: read-only shadow import; v1 View remains authoritative

## Context

V1 View history stores execution and reasoning in independent artifacts. Tasks name
explicit related Runs, but Runs do not name Tasks. ContinuityPackets preserve reasoning
without a `run_id`. Signals can name an owner without a durable Principal binding.
Validation is embedded in Runs and packets, while delivery is an independent Git
observation produced by `scripts/outcome-layer.mjs`.

Treating filenames, timestamps, text similarity, or completion status as hidden joins
would manufacture certainty. Dropping malformed or unlinked artifacts would make a
successful migration indistinguishable from data loss.

## Decision

`@seedrop/migration` admits Tasks, Runs, ContinuityPackets, live and archived Signals,
and optional outcome-layer reports through a read-only v1 adapter. The adapter uses the
public frozen View schemas from `@seedrop/space/view`, stable-reads each file, and hashes
the complete View tree before and after collection. It never calls a View writer.

Every logical source record becomes exactly one canonical Project transaction in
stable source-reference order. The transaction contains a provenance event with the
source family, reference, byte or canonical-record digest, schema version, source
Principal when resolvable, deterministic candidate subject ID when explicit, and its
disposition:

- `imported` when the record is valid and every required explicit relation resolves;
- `quarantined` when JSON, the source container, or the frozen schema is invalid;
- `unresolved` when valid evidence cannot be bound without guessing.

Quarantined transactions keep the source reference, digest, and diagnostic but do not
promote invalid payload fields. V1 remains the byte authority for repair.

Deterministic UUIDv7 IDs use a fixed import epoch and a versioned hash namespace.
Command idempotency keys bind the source reference and digest. Each transaction cites
the previous transaction digest, so source order, omissions, duplication, and chain
tampering are observable. Rerunning the same admitted bytes produces byte-identical
results.

Run and packet validation entries emit independent
`seedrop.outcome.validation_observed` events. Outcome-layer records emit
`seedrop.outcome.delivery_observed` with observer, observation time, input digest,
repository root, and Git HEAD build identity. `scripts/outcome-layer.mjs` now includes
that HEAD identity. A completed Run without such evidence remains only a report; the
importer does not synthesize delivery.

ContinuityPackets are deliberately unresolved because v1 has no explicit Run identity.
Their reasoning and validation remain preserved in the unresolved transaction. No
timestamp or text heuristic links them to Runs. Explicit Task blocker/Run links and
delivery `run_id` links are the only cross-record relationships promoted.

## Invariants

1. Source records equal imported plus quarantined plus unresolved records.
2. Exactly one Project transaction exists per admitted logical source record.
3. Source-tree bytes and hashes are unchanged by collection and import.
4. Stable source bytes, identity registries, project binding, and snapshot time produce
   byte-identical transactions and Receipts.
5. Every quarantine and unresolved record carries at least one reason.
6. Continuity/Run disagreement is preserved; heuristic joins are forbidden.
7. Validation and delivery observations do not rewrite reported lifecycle state.
8. V1 View remains authoritative and Wave 4 still cannot represent cutover.

## Consequences

The shadow corpus can now preserve valid history, corruption, identity drift, and
missing relationships in one auditable transaction chain. Later compatibility and
projection work can compare v1 and v2 without first trusting an irreversible cleanup.
The cost is intentional: unresolved evidence stays visible until a correction or
authoritative binding is supplied.

## Verification

- fixture with valid records, malformed JSON, missing packet/Run identity, validation,
  archived Signal, and Git delivery observation;
- byte-identical import after reversed discovery order;
- source-tree digest equality before and after collection/import;
- transaction-chain and record-mapping tamper rejection;
- live View import with exact family/disposition/diagnostic accounting;
- package, architecture, Wave 3 regression, root test, and all-workspace build gates.
