# Wave 2 proof — VI-03 / VI-06 / VI-08

- **Task:** `b7dff3e0-2990-4eba-bd33-45e7f716a59c`
- **Run:** `19c42661-3d5a-4f3d-b97e-2efdc32f2a53`
- **Date:** 2026-08-09
- **Scope:** command phase/audit truth, explicit recovery, age/state invariant
  queries, read-only sweep proposals, and append-only repair Receipts
- **Durable v1 change class:** none

## Delivered contract

`@seedrop/protocol` now owns `CommandAuditTrail` version `1.0.0` with eight
canonical phases:

```text
accepted, executing, effects_pending, recovery_pending,
completed, rejected, failed, compensated
```

Every nonterminal audit entry must name a canonical recovery owner, action,
deadline, and remaining attempt budget. Every terminal entry must omit recovery.
Audit Events are strictly ordered, attempts cannot regress, expected/result state
versions form a gap-free chain, and scoped idempotency identity resolves to one
Command. Partial result versions remain visible when effects are pending or a
command/repair fails.

Versioned policy queries report exact age, idle time, recovery owner, terminal and
recoverable state, and every threshold violation. Sweep output is a deterministic
`command.sweep_candidate` Event proposal with cause and inferred confidence; the
query neither mutates command state nor mints a canonical Event.

`RepairReceipt` version `1.0.0` records canonical actor/owner/Project/Command/Receipt
identity, evidence references, before/after versions and hashes, structured command
name/input digest, outcome/failure, rollback truth, and a project-local journal link.
Journal verification enforces unique IDs, strict time/sequence order, and the
canonical digest of the complete prior Receipt before any query filter is applied.
Raw command arguments are deliberately excluded.

HealthEnvelope pending-command phases now accept only canonical nonterminal phases.
Recovery ownership must agree with the `recoverable` observation. Existing health
golden bytes are unchanged.

## Golden evidence

`protocol/fixtures/command-recovery-v1.json` freezes one terminal command, one
recoverable `effects_pending` command with partial result state, one overdue sweep
proposal, and two chained repair Receipts:

| Artifact | Canonical SHA-256 |
| --- | --- |
| command audit trails | `fdee3afc493ccbb613fdfb2dd1f15309945f871361a46b6f215d27fd44dd5711` |
| invariant reports | `2164c7545ab97e6e24400e97f1a7d979a1ba40748a83e46c3bc23063e2ebfbed` |
| sweep candidates | `5e085fc3e0be922cc52261e508eed5ed2ed358e032f0086655e64796b552ca48` |
| repair journal | `2acd6cdce58dc57e75eee28e36e2ab4c713e08c3fe48d0159ca3eaf3ce1648b4` |

The command/recovery fixture, HealthEnvelope fixture, and base protocol fixture
reproduced their exact digests on Node `20.20.2`, `22.23.2`, and `24.18.0`.

## Validation evidence

- Protocol: typecheck passed; build passed; 8 files / 81 tests passed.
- Added proof coverage: 10 command tests, 8 repair tests, and 1 Health integration
  test, including illegal transitions, post-terminal append, missing/exhausted
  recovery, version gaps, duplicate scoped idempotency, future observations, terminal
  sweep exclusion, partial mutations, rollback contradictions, mixed Projects,
  sequence gaps, duplicate Receipts, chain tampering, and query integrity.
- All eight npm workspaces: typecheck passed and build passed.
- Full Node 20 workspace suite: 89 test files; 940 Vitest tests passed, 3 skipped;
  3 additional Desktop release-control tests passed.
- Durable-v1 freeze: passed at contract SHA-256
  `fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b`,
  covering 64 artifacts and 3 accepted transitions; both freeze harness tests passed.
- V1 import boundary: no CLI, MCP, ID, Space, Observer, Bench, Desktop, or package
  source imports `@seedrop/protocol`.
- Identity reconciliation: sanitized and live read-only modes both observed 9
  passports, 29 links, 24 unique roots, 9 canonical Principals, 23 canonical
  Projects, and 0 unresolved project sources.
- Package dry-run: 60 entries; command/repair declarations, JavaScript, sources,
  fixture, and verifier are included; packed size 80,500 bytes, unpacked size
  424,120 bytes.
- `git diff --check`: passed.

## Exit assessment

VI-03, VI-06, and VI-08 are satisfied at the v2 protocol boundary. Structurally
valid started commands cannot become ownerless unknown state: they are terminal or
explicitly recoverable. Overdue active records are deterministically discoverable
without read-side mutation. Repair mutation and partial failure remain queryable
through a verified append-only Receipt chain.

This slice intentionally does not retrofit v1 writers or execute sweep proposals.
The next contract slice should continue Wave 2 observability/completeness work before
Wave 3 proves one transactional v2 writer under crash and concurrency fault matrices.
