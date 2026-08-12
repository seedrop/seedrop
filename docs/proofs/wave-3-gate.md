# Wave 3 gate — Transactional vertical slice

- **Status:** passed
- **Executed:** 2026-08-12
- **Task:** `144a7d29-7f91-4ade-8532-c89df7dee36c`
- **Authority:** v2 shadow path only; v1 remains authoritative

## Closed work

| Slice | Product boundary | Commit | Gate evidence |
|---|---|---|---|
| TR-02 | Modular Kernel and Project boundaries | `bb6a557` | dependency direction is Kernel → Project → Protocol; adapters own no domain semantics |
| TR-07 / TX-05 / TX-06 | Canonical Project transaction log | `bd6c888` | immutable content addresses, atomic publication, deterministic reducer, lag/quarantine, byte-identical rebuild |
| TX-01–04 / TX-07 / TX-08 / TX-16 | Transaction executor and recovery | `9a5bdf6` | identity, authorization, validation, expected-version CAS, outbox, idempotency, recovery, and governed repair |
| TR-09 / TR-10 / TX-09–11 | Native work vertical slice | `43e7f48` | Intent, Episode, Claim, Receipt, and Lease open/finish/expiry/correction path over canonical transactions |
| PR-03 | Atomic crash/recovery matrix | `09333c9` | all 16 persistence/effect boundaries expose the whole logical transaction or none and restart deterministically |
| PR-04 | Multi-process concurrency/idempotency | `d358491` | 2/8/32 independent writers prove CAS retention, one duplicate outcome, and one Lease winner |
| PR-05 | Corruption/quarantine visibility | `a62940e` | transaction, staging, index, and lock families preserve corrupt/truncated/denied evidence with Health and repair pointers |

All seven blocker tasks are durably `done`.

## Executable gate

The repository-level gate command is:

```bash
npm run test:wave-3-gate
```

It composes the architecture/authority checks, frozen-v1 compatibility check, and the
complete Protocol, Project, and Kernel suites. The Kernel suite includes the 16-case
atomic recovery proof and the real 2/8/32-process concurrency proof.

## Gate results

| Surface | Result |
|---|---|
| Architecture and authority | `3/3` checks passed; no dependency cycle or shadow-package connection |
| Durable v1 freeze checker | `2/2` behavior proofs passed; the live frozen contract check passed |
| Protocol | `119/119` tests passed |
| Project | `46/46` tests passed, including the 12-case artifact mutation matrix |
| Kernel | `54/54` tests passed, including atomic recovery and 2/8/32-process races |
| Full repository regression | `1,084` checks passed, `3` intentionally skipped |
| Build | all ten workspaces built successfully |

## Authority and cutover result

The central architecture contract and its executable check require all of the
following:

- `@seedrop/kernel` and `@seedrop/project` remain shadow-only;
- no v1 workspace imports either shadow package;
- only Kernel owns state-changing v2 command execution;
- Project owns canonical transactions, Receipts, projections, and Project
  Health/quarantine;
- v1 writers remain authoritative;
- the custom database experiment is not on the main path.

Every Kernel executor instance requires an explicit Boolean `feature_enabled` value.
With `false`, execution returns `seedrop.protocol.command_feature_disabled` and writes
zero Project transactions. No CLI, MCP, View, passport, Space, Bench, Observer, or
Desktop writer is connected to the v2 Kernel.

## Exit decision

Wave 3 is closed. Seedrop now has a modular, executable transactional shadow slice
whose atomicity, recovery, process concurrency, idempotency, Lease exclusivity, and
corruption visibility claims are backed by tests rather than architecture prose.

This decision does **not** authorize v2 write cutover, shadow-package integration into
v1 adapters, Desktop distribution, or adoption of `seedrop_db`. Those require later
parity, migration, rollback, and explicit cutover gates; the database experiment still
requires black-on-white evidence of approximately 10x product value.
