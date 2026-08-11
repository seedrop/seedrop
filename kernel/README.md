# `@seedrop/kernel`

Seedrop v2's transport-neutral command execution boundary.

This is the sole package that may execute state-changing v2 commands. It imports
identifiers, versions, command phases, Event/effect/Receipt meaning from
`@seedrop/protocol` and commits through the expected-version CAS owned by
`@seedrop/project`.

The Wave 3 executor is generic and feature-gated. Its governed order is:

1. validate the canonical request and resolve the registered definition;
2. resolve the Principal and authorize the operation;
3. validate and plan without durable effects;
4. compare the expected project high watermark;
5. atomically publish one canonical transaction containing lifecycle, domain,
   repair, and outbox-declaration Events;
6. rebuild the disposable projection;
7. dispatch effects idempotently by effect key;
8. return a protocol-owned command audit and commit Receipt.

Retries discover the original scoped idempotency transaction before planning.
Restart recovery derives owed effects from committed Event bytes, never from an
in-memory phase. A thrown dispatcher leaves the command `effects_pending`; a governed
dead letter yields `needs_repair`. Repair definitions require a validated
`RepairReceipt` whose command, Project, actor, and input digest match the request.

`KERNEL_ATOMIC_RECOVERY_MATRIX` is the executable process-crash contract. It names
all 16 Kernel, writer-locked commit, immutable publication, and effect boundaries and
states whether restart must execute again or recover committed bytes. The executor's
`fault`, `project_fault`, and `publish_fault` options are proof seams for this matrix;
they are not adapter policy. `published_unconfirmed` means the whole transaction is
visible to an ordinary restarted process after the atomic link, but power-loss
durability is claimed only after the containing-directory sync.

`npm run test:concurrency -w @seedrop/kernel` runs the real multi-process proof at
2, 8, and 32 independent Node processes. Its CAS workers first observe the same
project head, then race through the filesystem writer lock, explicitly retry stale
versions, and prove every acknowledged digest survives in the final canonical chain.
Separate native-open races prove that one idempotency scope resolves to one Command
and transaction across different requested Command IDs, and that one shared Lease
target has exactly one winner while every loser returns a typed conflict.

`createNativeWorkCommandDefinitions` supplies the first complete domain path:
`seedrop.work.open` atomically creates an active Intent/Episode with scope Claim,
Receipt, and Lease; `seedrop.work.finish` records completion and outcome truth,
releases the Lease, and optionally declares a required handoff effect;
`seedrop.lease.expire` appends explicit TTL expiry; and `seedrop.work.correct`
explicitly reopens a terminal Intent/Episode pair while citing both corrected Events,
recording a correction Claim and Receipt, and acquiring a fresh Lease. Correction is
separately authorizable by command name.

Definitions receive the executor's complete checked project snapshot. Expected-
version CAS remains the contention authority, so simultaneous Lease acquisition has
one canonical winner and cannot fork project history.

This package is shadow-only. It is not connected to the v1 CLI, MCP, View, passport,
Space, Bench, Observer, or Desktop writers.
