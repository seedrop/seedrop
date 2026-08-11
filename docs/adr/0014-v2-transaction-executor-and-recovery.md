# ADR 0014: Feature-gated transaction executor and recovery

- Status: Accepted
- Date: 2026-08-11
- Scope: Seedrop v2 Wave 3, TX-01–TX-04, TX-07, TX-08, TX-16
- Depends on: ADR 0010, ADR 0013

## Context

ADR 0013 established immutable project transaction bytes and a deterministic reducer,
but deliberately left execution, authorization, multi-writer compare-and-set,
idempotency, external effects, restart recovery, and repair authority open. Without a
single executor, adapters could still validate or write in different orders and
recreate the partial-command failures v2 exists to remove.

V1 remains the production authority. This slice must therefore be executable and
crash-testable without connecting CLI, MCP, View, passport, Space, Bench, Observer, or
Desktop writers to v2.

## Decision

### Package direction

The executable dependency direction is:

```text
adapter (later) -> @seedrop/kernel -> @seedrop/project -> @seedrop/protocol
```

Protocol owns IDs, versions, stable errors, command phases, lifecycle Event names,
outbox declarations, delivery Receipts, command commit Receipts, and repair Receipts.
Project owns durable transaction publication, writer serialization, expected-version
CAS, scanning, quarantine, and projections. Kernel owns the governed execution order.

The kernel and project packages remain shadow-only. No v1 package imports them.

### Feature gate and execution order

Every executor instance requires an explicit `feature_enabled` value. Disabled means
typed refusal before identity resolution, planning, files, or external effects.

An enabled command executes in this order:

1. exact canonical request and registered definition validation;
2. Principal resolution and active-state check;
3. explicit authorization for execute or recover;
4. side-effect-free domain validation and planning;
5. scoped idempotency lookup;
6. complete projection and expected-high-watermark check;
7. one writer-locked project transaction commit;
8. deterministic projection rebuild;
9. idempotent dispatch of transaction-declared outbox effects;
10. protocol command audit and commit Receipt materialization.

Unauthorized, inactive, malformed, unknown, or domain-invalid input creates no project
transaction and invokes no outbox effect.

### Cross-process expected-version CAS

Project commit uses one project-local lock directory with an immutable owner token,
host, PID, acquisition time, and stale threshold. The lock spans source scan,
high-watermark comparison, immutable publication, and projection rebuild.

A live local PID lock is never stolen. Automatic stale recovery is permitted only for
an expired lock whose owning PID is provably dead on this host. Unknown, malformed,
remote, or PID-reused ownership fails closed and requires authorized repair. The
publisher verifies the owner token immediately before the atomic link.

While locked, both the observed high watermark and the transaction's predecessor must
equal the caller's expected version. A mismatch publishes nothing. Retrying exact
bytes already at the high watermark returns `already_committed` and repairs a missing
disposable projection.

The lock is coordination, not truth. Canonical transaction bytes remain authority.

### Idempotency

Idempotency scope is Project + Principal + command name + key. A matching input digest
and version resolves to the original transaction and Command ID without replanning.
The same scope with different input or version fails typed. Concurrent duplicates may
plan independently before the lock, but only one transaction commits; losers rescan
and return the winner. Different commands with the same expected version produce one
winner and explicit CAS conflicts, never a fork.

### Transaction-declared outbox

Every external or secondary effect is a protocol `OutboxEffect` embedded as an Event
inside the same canonical project transaction as domain state. It includes a stable
effect key, type, canonical payload and payload digest, declaration time, Project,
Command, and required flag.

Dispatch occurs only after canonical commit. The outbox port must be idempotent by
effect key and return the same immutable delivery Receipt on replay. A thrown dispatch
leaves a required effect `effects_pending`; a returned governed dead letter makes the
command `needs_repair`; all governed effects delivered makes it `completed`. Optional
effects do not widen the governed success boundary.

The later machine daemon may implement this port transactionally. This slice does not
reuse or mutate the v1 Space outbox and does not introduce a second project authority.

### Restart recovery

Recovery takes a canonical Command ID and authorized actor. It scans the immutable
transaction, verifies lifecycle Events, rebuilds the projection, extracts and verifies
outbox declarations, and redispatches their stable keys. It never reruns domain
validation or planning after canonical commit.

The observable restart states are:

| State | Canonical transaction | Projection | Required effect | Recovery |
| --- | --- | --- | --- | --- |
| pre-commit failure | absent | unchanged | absent | safely execute again |
| canonical committed | present | possibly lagged | declared | rebuild then dispatch |
| effects pending | present | current | no Receipt/unreachable | redispatch same key |
| completed | present | current | delivered Receipt | return completed Receipt |
| needs repair | present | current | dead-letter Receipt | authorized repair required |

There is no state in which absence of an exception proves completion.

### Authorized repairs

A repair is a registered kernel definition with kind `repair`. Normal Principal
resolution and authorization run before planning. The plan must contain a protocol
`RepairReceipt` whose repair Command, Project, actor, command name, and canonical input
digest match the request. The Receipt and correction/invalidation Events commit in the
normal project transaction. Readers never delete or rewrite quarantined canonical
source bytes.

## Invariants

1. Disabled, unauthorized, inactive, malformed, and invalid commands create zero
   project transactions and zero outbox effects.
2. Kernel is the only package that executes v2 state-changing commands.
3. Every committed command has exactly one immutable project transaction.
4. Expected-version failure publishes nothing.
5. Project writers cannot create a hidden fork through read-check-write races.
6. One idempotency scope resolves to one Command ID and one input digest.
7. Outbox declarations commit atomically with authoritative project Events.
8. Effect dispatch begins only after canonical commit and is logically idempotent.
9. Restart recovery reads committed bytes and never reruns domain planning.
10. Every returned command is terminal or carries recovery owner, action, deadline,
    and remaining attempt budget.
11. Dead letters remain visible as `needs_repair` with their structured cause.
12. Repair mutation requires explicit authorization and a matching immutable Receipt.
13. V1 remains authoritative and the database experiment remains off the main path.

## Rejected alternatives

- **Let adapters sequence validation and writes.** This recreates divergent command
  semantics and partial effects.
- **Publish transactions without writer serialization.** Content addressing prevents
  overwrite but does not prevent two valid children from forking one predecessor.
- **Use timestamps or digest order to pick a concurrent winner after publication.**
  That hides an authority conflict instead of preventing it.
- **Steal any old-looking lock.** A paused live writer could later publish stale state.
- **Store the outbox only in memory.** A crash would erase owed effects.
- **Run effects before the canonical commit.** A failed command could leak an effect
  with no authoritative cause.
- **Rerun domain planning during recovery.** Time, IDs, policies, or filesystem state
  may have changed; recovery must consume the committed plan.
- **Connect v1 writers now.** Shadow parity and migration evidence do not yet exist.
- **Use `seedrop_db`.** The experiment remains excluded until independent product-level
  evidence proves its promotion threshold.

## Verification

The acceptance proof includes:

- exact protocol shape and contradiction tests for effects and Receipts;
- a frozen execution golden verified from built output;
- project commit retry, stale-CAS, concurrent-writer, live-lock, dead-lock, and
  post-publication crash recovery tests;
- kernel disabled, authorization, validation, expected-version, idempotency conflict,
  duplicate storm, distinct-writer, outbox pending, dead-letter, recovery, and repair
  tests;
- injected crashes before authorization, after validation, before/after commit,
  before/after effect delivery, and before Receipt materialization;
- architecture cycle/boundary checks, durable-v1 freeze verification, package builds,
  full repository tests, and supported-Node runtime goldens.
