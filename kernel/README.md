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

This package is shadow-only. It is not connected to the v1 CLI, MCP, View, passport,
Space, Bench, Observer, or Desktop writers.
