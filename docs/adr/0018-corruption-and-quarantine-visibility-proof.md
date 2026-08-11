# ADR 0018: Corruption and quarantine visibility proof

- Status: accepted
- Date: 2026-08-11
- Scope: Seedrop v2 Wave 3, PR-05
- Depends on: ADR 0009, ADR 0013, ADR 0014, ADR 0016
- Authority: v2 shadow path only; v1 remains authoritative

## Context

The canonical transaction scanner already retained malformed transaction bytes, but
the Wave 3 physical store contains three other artifact families: publication staging,
the disposable projection index, and writer-lock ownership. Those families had no one
inspection surface. A corrupt index could be overwritten by a rebuild without first
being reported, and malformed lock JSON was treated like an absent owner and could be
removed by stale-lock recovery. Work queries either returned a valid projection or
threw an error that exposed only a quarantine count.

## Decision

`inspectProjectSituation` is the evidence-backed read surface for all four physical
families:

| Family | Authority | Failure classification | Repair pointer |
| --- | --- | --- | --- |
| content-addressed transaction | canonical Project truth | corrupt, query incomplete | canonical source repair required |
| publication staging | crash evidence only | degraded, query may continue | inspect staging |
| projection index | disposable derivative | degraded, query may rebuild from canonical memory | rebuild projection |
| writer-lock owner | write coordination only | degraded, writes fail closed | authorized lock repair |

The surface returns artifact family, repo-relative path, byte length when readable,
expected and actual digests when knowable, a typed code, and a stable repair pointer.
It does not return arbitrary payload bytes. “Source bytes are exposed” means their
location and integrity evidence are exposed while their exact bytes remain untouched
on disk for forensic inspection.

The inspection builds the protocol `HealthEnvelope`. Transaction damage is an
error-severity quarantine because canonical truth is incomplete. Damage to staging,
the index, or lock ownership is warning-severity quarantine because those artifacts
cannot become Project truth; their optional source status still makes Health
`degraded`. `queryProjectWorkReceipts` always returns that Health and artifact evidence.
It returns no partial Receipts when canonical reduction is incomplete, but it may
return complete canonical Receipts while a derivative or coordination artifact is
degraded.

Writer-lock parsing is shared by acquisition and inspection. Only a canonical,
schema-valid owner can be evaluated for dead-local stale recovery. Malformed,
noncanonical, and unreadable owner bytes cause a typed transaction conflict and stay
in place after the lock's publication window expires. During that window, a contender
can observe the directory before `owner.json` is fully written and treats missing or
partial ownership as busy, not invalid. A missing owner file can be recovered only
after the lock directory itself is stale.

## Invariants

1. Discovery and query code never deletes or rewrites an invalid artifact.
2. Every Wave 3 physical family has an explicit absent, valid, or quarantined state.
3. Every quarantine carries its family, referent, code, severity, and repair pointer.
4. Permission denial becomes typed `read_failed` evidence rather than aborting the
   whole inspection or masquerading as absence.
5. Canonical transaction damage never yields partial work results marked complete.
6. Disposable or coordination damage never suppresses otherwise complete canonical
   work results; it travels with them as degraded Health.
7. Invalid lock ownership is never automatically stolen or deleted.
8. V1 writers and `seedrop_db` remain outside this proof.

## Rejected alternatives

- **Embed quarantined bytes in Health.** Payload size and content are unbounded;
  path, length, and digest make the evidence addressable without duplicating it.
- **Treat every artifact as canonical corruption.** A staging orphan or bad index
  cannot change transaction truth and should not suppress a valid query.
- **Silently rebuild an index during inspection.** Read paths report first; rebuild is
  the explicit repair action.
- **Treat malformed lock JSON as a missing owner.** Unknown ownership cannot prove a
  safe steal and must fail closed.
- **Use `seedrop_db` as a repair catalogue or quarantine index.** The separate
  experiment remains off the v2 trajectory until it proves independent 10x value.

## Verification

The focused matrix creates a valid canonical transaction and projection, then corrupts,
truncates, and permission-denies each of the four families: 12 mutations total. Every
case asserts preserved bytes, typed artifact evidence, Health quarantine, a repair
pointer, and checked-query behavior. Separate lock tests prove malformed and unreadable
owners return typed conflicts and remain byte-identical after acquisition fails.
