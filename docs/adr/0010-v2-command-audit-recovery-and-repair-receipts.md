# ADR 0010 — Command audit, recovery, sweep proposals, and repair Receipts

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 tasks `VI-03/VI-06/VI-08` / `b7dff3e0`
- **Depends on:** ADR 0004, ADR 0006, ADR 0007, ADR 0009
- **Durable v1 change class:** none; standalone v2 contract prototype

## Context

Seedrop already contains several real recovery mechanisms, but they do not share a
protocol:

- the versioned Space post outbox stores `pending`, `processing`, `completed`, and
  `dead_letter` rows with attempts, leases, errors, deterministic effects, inspection,
  and explicit retry;
- View run sweeping infers that an old `in_progress` run failed, preserving cause,
  age, and `swept=true`;
- identity commit journals, root migration backups, snapshot/restore Receipts,
  quarantine guidance, and Desktop setup phases each describe repair differently;
- HealthEnvelope can report a pending command, but ADR 0009 deliberately leaves
  command phase authority to this slice.

Those local mechanisms are valuable evidence, not one command model. A surface may
call work complete while another durable effect remains pending; an old record may
be swept without a common policy trace; and a repair can mutate bytes without a
queryable actor/evidence/before/after record. A generic retry counter cannot answer
who owns recovery, which state version was expected, whether partial state changed,
or how the repair can be reversed.

VI-03 requires every started command to become terminal or explicitly recoverable.
VI-06 requires age/state invariant queries and sweep candidate events for abandoned
or impossible active records. VI-08 requires every repair mutation to emit an
append-only Receipt with evidence, actor, hashes, rollback, and recovery owner.

## Decision

Add two transport-neutral version `1.0.0` contracts to `@seedrop/protocol`:

1. `CommandAuditTrail` plus read-only invariant/sweep queries;
2. `RepairReceipt` plus a project-local append-only journal verifier/query.

The package remains executable specification. This slice neither writes v2 state nor
changes v1 adapters or durable formats.

## Command audit trail

One trail identifies exactly one logical command with:

- full canonical Command, Principal, and Project IDs;
- command protocol version and stable command name;
- an idempotency key scoped by Project, Principal, command name, and key;
- canonical input digest rather than raw arguments;
- accepted time;
- an ordered list of canonical Event-backed audit entries.

Each audit entry records:

- full canonical Event ID;
- phase and observation time;
- expected state version;
- optional result state version and matching result digest;
- attempt number;
- structured error or null;
- structured recovery plan or null.

Event times must increase strictly, Event IDs cannot repeat, state versions must form
a gap-free chain, and attempt numbers cannot regress. The first entry is `accepted`,
must equal the trail's accepted time, and uses attempt zero.

Raw command arguments are intentionally absent. They can contain secrets or unstable
filesystem paths and are not necessary to prove idempotent identity. Command name,
input digest, principal, project, and key are the audit identity.

### Phases and transitions

The canonical phases are:

| Phase | Terminal | Meaning |
| --- | --- | --- |
| `accepted` | no | identity, authority context, input digest, and expected version are recorded |
| `executing` | no | the executor owns an active attempt |
| `effects_pending` | no | authoritative state may exist while one or more declared effects remain owed |
| `recovery_pending` | no | ordinary execution stopped and an explicit recovery action owns the next move |
| `completed` | yes | command and required effects reached the governed success boundary |
| `rejected` | yes | precondition/authorization/input policy denied execution |
| `failed` | yes | this command attempt ended unsuccessfully with a cause |
| `compensated` | yes | a recovery command restored the governed consistency boundary |

Allowed transitions are:

```text
accepted         -> executing | effects_pending | completed | rejected | failed
executing        -> effects_pending | recovery_pending | completed | failed
effects_pending  -> executing | recovery_pending | completed | failed
recovery_pending -> executing | effects_pending | completed | failed | compensated
completed | rejected | failed | compensated -> terminal
```

Retries append transitions through `recovery_pending`; they never erase or overwrite
an earlier attempt. A different logical retry command receives a different Command
ID. Reuse of the same scoped idempotency key must resolve to the original Command ID;
two trails claiming the same scope fail the collection audit.

### Recovery invariant

Every nonterminal entry must carry:

- canonical recovery-owner Principal ID;
- nonempty recovery action;
- recovery deadline at or after the entry;
- positive attempt limit greater than the current attempt.

Every terminal entry must carry null recovery. Therefore a structurally valid latest
entry is always either terminal or explicitly recoverable. An exhausted attempt
budget cannot masquerade as pending; the producer must append `failed`, or obtain a
new authorized recovery command and Event.

`recovery_pending`, `rejected`, and `failed` require a structured error. Other phases
must not attach one. The error preserves stable code, message, retryability, and an
optional evidence digest; it does not replace the recovery record.

Successful `completed` and `compensated` entries require result state version and
digest. Other phases may also include the pair. This is essential for partial truth:
an `effects_pending` or `failed` command may already have changed authoritative state.
Suppressing that version would recreate the half-completed-command blind spot. A
result version and digest are atomic evidence: either both are present or both null.

## Age/state invariant queries

`evaluateCommandInvariants` validates a set of trails against one versioned policy
and observation time. The policy names:

- maximum total nonterminal command age;
- maximum idle duration for each nonterminal phase.

The result keeps terminal and recoverable booleans separate and reports exact command
age, phase idle age, recovery owner, and all violations:

- `command_age_exceeded`;
- `phase_idle_exceeded`;
- `recovery_deadline_exceeded`.

Observation before the latest Event fails; negative ages are never clamped. Terminal
commands remain queryable but cannot become sweep candidates merely because they are
old.

## Sweep candidates are proposals, not writes

`findCommandSweepCandidates` returns a canonical, deterministic proposal for every
nonterminal command with an age/state violation. Each proposal includes policy,
phase, ages, recovery owner, all reason codes, and a proposed
`command.sweep_candidate` Event payload with `confidence=inferred` and explicit cause.

The query does not mint a canonical Event ID, mutate a trail, declare failure, or
execute recovery. The future kernel must authorize and append the Event using the
normal command path. This preserves ADR 0006: an abandoned record can project to
failure only through an explicit inference Event with cause and confidence. Repeated
queries over identical bytes, policy, and observation time return identical bytes.

## Repair Receipts

A repair is itself a canonical command and must emit a canonical Receipt. Each
`RepairReceipt` records:

- canonical Receipt, repair Command, Project, actor Principal, and recovery-owner
  Principal IDs;
- issuance time and typed target referent;
- structured repair command name and canonical input digest;
- at least one Claim, Receipt, or Event evidence reference with role, digest, and
  observation time;
- before and after state versions and digests;
- `applied`, `no_change`, `failed`, or `rolled_back` outcome;
- structured failure for failed outcomes;
- explicit rollback contract;
- journal sequence and previous Receipt digest.

Evidence cannot postdate the Receipt and a Receipt cannot cite itself. Evidence order
normalizes by canonical record ID. `applied` requires changed before/after state and
`no_change` requires byte-identical state references. A failed repair may preserve
either equal or changed after-state because failure can occur after partial mutation;
forcing equality would destroy the evidence needed for recovery. A failed outcome
requires failure evidence and every nonfailed outcome forbids it. `rolled_back` may
equal or differ from the immediately preceding state because the Receipt records the
actual observed result rather than assuming perfect restoration.

### Rollback truth

Rollback mode is exactly one of:

- `command`: a governed compensating command instruction;
- `snapshot`: an instruction plus immutable artifact digest;
- `manual`: an explicit human procedure;
- `unavailable`: no instruction/artifact and a required reason.

An unavailable rollback is not success; it is honest protocol evidence. Adapters may
raise policy severity but cannot manufacture a rollback path.

### Append-only journal

Repair Receipts form one Project-local chain:

- sequence starts at one and increases without gaps;
- first Receipt has null predecessor;
- every later predecessor equals the canonical SHA-256 digest of the complete prior
  Receipt;
- Receipt IDs are unique;
- issuance times increase strictly;
- Projects cannot mix in one journal.

`assertRepairJournal` verifies the whole chain before `queryRepairReceipts` filters by
Project, repair Command, actor, recovery owner, target, or outcome. Filtering never
weakens chain verification. A missing, reordered, replaced, or cross-Project Receipt
therefore fails before any adapter can present a partial repair history as complete.

## Health and adapter boundary

`PendingCommandHealth.phase` now uses the canonical nonterminal phase union. A
recoverable pending-health entry must name a recovery owner, while an explicitly
unrecoverable legacy/corrupt observation must not manufacture one. Terminal phases
cannot appear as pending. This is a v2 contract refinement only; HealthEnvelope bytes
and its seven existing goldens are unchanged.

The existing Space outbox and Run sweeper remain v1 authorities. Later compatibility
adapters may map their records into this contract under shadow comparison, but they
must preserve unknown states as diagnostics and cannot write v2 audit history
retroactively without migration evidence. No CLI, MCP, Observer, Bench, Desktop, ID,
or Space source imports `@seedrop/protocol` in this slice.

## Invariants

1. Every command trail begins with one canonical accepted Event.
2. Full Principal, Project, Command, and Event IDs cross every boundary.
3. Idempotency identity is scoped and resolves to one Command ID.
4. Audit Event times increase strictly and attempts never regress.
5. Expected/result versions form a gap-free chain.
6. Partial result state is preserved even when effects remain or the command fails.
7. Every latest phase is terminal or has a valid recovery owner, action, deadline,
   and remaining attempt budget.
8. Terminal phases never retain recovery.
9. Illegal transitions and post-terminal append fail typed.
10. Sweep evaluation is read-only, deterministic, policy-versioned, and preserves
    cause/confidence.
11. Old terminal commands never become sweep candidates.
12. Every repair names its actor, owner, evidence, command identity, target,
    before/after state, outcome, and rollback truth.
13. Repair evidence cannot postdate or self-reference the Receipt.
14. Repair journals are Project-local, gap-free, unique, strictly timed hash chains.
15. Queries verify the whole repair chain before filtering.
16. Raw command arguments and secrets are not part of either contract.
17. V1 remains authoritative until shadow parity and explicit cutover Receipts.

## Rejected alternatives

### Reuse each adapter's existing status enum

Rejected. `in_progress`, `processing`, `pending`, `dead_letter`, and setup phases have
different transaction boundaries. Rendering them alike does not establish shared
semantics or recovery ownership.

### Treat retryable errors as recovery plans

Rejected. Retryability says an operation might succeed later; it does not identify
who owns recovery, when it expires, how many attempts remain, or what action is safe.

### Mark old commands failed during the read query

Rejected. Hidden read-side mutation would destroy observation determinism and repeat
the presence/watermark side effects repaired in ADR 0005. The query proposes an Event;
an authorized command commits it.

### Forbid result versions on failed or pending commands

Rejected. Cross-store and multi-effect commands can mutate authoritative state before
their last effect or final acknowledgement. Erasing the result version hides exactly
the partial completion this contract must expose.

### Store raw shell commands and arguments in Receipts

Rejected. They may contain secrets, unstable paths, or adapter-specific syntax.
Stable command name plus canonical input digest proves identity without expanding the
credential surface.

### Keep a mutable repair log row per target

Rejected. Updating the latest row destroys prior evidence and makes rollback or
operator attribution unverifiable. Repair history is append-only and hash-chained.

### Assume every repair has automatic rollback

Rejected. Some repairs are manual or irreversible. An explicit unavailable reason is
safer than a fabricated command.

### Wire v1 adapters immediately

Rejected. Wave 2 freezes truth contracts. Adapter mapping, generated schemas, shadow
parity, migration, and write cutover are later gates.

## Consequences

Seedrop gains one executable answer for whether a command is safely terminal,
recoverable, or overdue, and one queryable proof format for repair. The Space outbox,
Run sweeper, doctor, migrations, and future transactional kernel can converge on the
same phases and evidence without sharing one physical store.

The contract is intentionally stricter than current v1 artifacts. A v1 state that
lacks a recovery owner, version, Event, or before hash must remain unresolved during
import; compatibility code may not invent it.

## Verification

Authoritative proof consists of:

- phase, transition, version-chain, recovery, idempotency, tamper, and partial-result
  tests;
- age/state policy, future-observation, terminal exclusion, and deterministic sweep
  candidate tests;
- repair outcome, evidence, rollback, tamper, query, sequence, uniqueness, and
  hash-chain tests;
- `protocol/fixtures/command-recovery-v1.json` with exact canonical digests for two
  command trails, their invariant reports, one sweep candidate, and two chained
  repair Receipts;
- built-output verification on every supported Node major;
- package/workspace gates, durable-v1 freeze verification, and proof that v1 sources
  still do not import the protocol package.
