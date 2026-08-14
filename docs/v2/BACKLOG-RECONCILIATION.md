# Seedrop v2 live-backlog reconciliation

**Task:** DC-13  
**Decision date:** 2026-08-09  
**Authorities:** [v2 execution catalog](./EVIDENCE-BASED-PLAN.md), [system forensics](./SYSTEM-FORENSICS.md), [DC-02 snapshot receipt](./SNAPSHOT-RESTORE.md), [durable-v1 freeze](./DURABLE-V1-FREEZE.md)

This is the disposition ledger for every task that was active when DC-13 started. Dropping means “remove from the live routing queue while preserving the task record and its reason”; it never deletes history. Later-wave work is rematerialized from the canonical catalog only when its preceding wave gate passes.

## Governing rules

1. Wave 0 and the explicit Wave 1 safety input may remain in the internal implementation queue.
2. A later-wave legacy task is absorbed into its catalog item and dropped from the live queue unless the v2 plan explicitly names it as a governing retained task.
3. Desktop signing, protected-environment, architecture, release, and rollback work remains visible as a separate operator-authority gate. It never makes Desktop the recommended path before `PR-18` passes.
4. The retained benchmark-v2 task is an operator-owned program gate, not permission to execute before Wave 7.
5. The old v0.2 launch task is a separate claimed historical/external lane. It does not block v2; broad promotion is superseded by `PR-15` evidence and the design-partner protocol.
6. `seedrop_db` remains off-trajectory. Its four former Seedrop tasks stay durably dropped; experiment continuity remains in that repository.

## Retained and gated tasks

| Task | Catalog / lane | Disposition | Owner or execution gate |
| --- | --- | --- | --- |
| `a3ed6030` weak-reader hardening | `VI-05`, `CF-05`, `PR-15` | retain as Wave 1A safety input | unassigned implementation task after Wave 0 gate |
| `7a1be782` resumption benchmark v2 | `PR-15` | retain as governing product benchmark | assign `mc`; do not execute before Wave 7 and frozen protocol |
| `7cd937de` x64 artifact evidence | `PR-18` | retain external release gate | assign `mc`; dual-architecture runner authority |
| `b83a94b8` signing/notarization umbrella | `PR-18` | retain canonical Desktop signing gate | assign `mc`; Apple/GitHub release authority |
| `2fd783e8` clean-account/rollback drill | `PR-16`, `PR-18` | retain external release gate | assign `mc`; only after signed artifact exists |
| `9e083a65` protected GitHub environments | `PR-18` | retain external release gate | assign `mc`; repository-administration authority |
| `360e3f3a` release credentials | `PR-18` | retain external release gate | assign `mc`; credential provisioning authority |
| `62d064e5` tag and release workflow | `PR-18` | retain external release gate | assign `mc`; only after commit, credentials, artifact, and rollback evidence |
| `2cb887f3` v0.2 publish/external-user/HN task | historical v1 launch lane | retain claimed by `claude`; explicitly non-blocking for v2 | operator decides closure; no broad product claim before `PR-15` |
| `4b18106f` Wave 0 gate | Wave 0 | mark done after DC-01, DC-02, and DC-13 receipts pass | authorizes Wave 1 materialization only |
| `33b67b5c` DC-13 | `DC-13` | mark done after this ledger and live-state verification | Product/Program |

## Absorbed, merged, or superseded tasks

| Task | Catalog mapping | Durable disposition |
| --- | --- | --- |
| `609fc20d` benchmark v1 | `PR-15` / `7a1be782` | drop; v2 benchmark supersedes its active work while preserving results |
| `e0d25b85` negative knowledge | `PR-12`, Wave 5 | absorb; rematerialize after canonical Grave/Episode truth exists |
| `a821dc7f` outcome scoring | `TR-12`, `PR-15` | absorb; no pre-kernel telemetry write |
| `8d727870` one write/many reads | Wave 6, `CF-11` | absorb; projection feature waits for Episode truth and adapter parity |
| `2b031545` boot receipt | `VI-10`, `PR-15` | absorb; waits for frozen measurement and receipt authority |
| `c477e3ef` economy report | `VI-10`, `PR-15` | absorb; its telemetry decision is done, but persistence waits for v2 receipts |
| `6f59a861` scope-gate rerank | `TR-14`, `CF-07` | absorb; Situation owns bounded ranking, not a v1 policy passthrough feature |
| `d5c10fdc` disagreement diagnostics | `VI-01`, `VI-05`, `TR-11` | merge into one governing Wave 2 item when that wave opens |
| `f980b786` source-disagreement thread | `VI-01`, `VI-05` | drop as duplicate of the merged Wave 2 item |
| `ad879c33` next-repair ranking thread | `VI-01`, `VI-05`, `TR-11` | merge into the Wave 2 health/readiness contract |
| `5948ac42` readiness-scope thread | `VI-01`, `TR-11` | merge into orthogonal readiness/health axes |
| `5bc21b95` Bench visual regression | `PR-17` | merge into the later human repair-safety suite |
| `05c3bba8` resumption visual QA | `PR-17` | merge into the same later UI suite |
| `aee5fcff` Bench mutations | `TX-01`–`TX-16`, `CF-11`, `PR-17` | defer; Bench must consume kernel commands, never invent mutation semantics |
| `228e0d6c` client metadata expansion | Wave 6, `PR-11` | defer until generated adapters and protocol stabilize |
| `6e7d1649` extension framework | post-v2 evidence only | drop as premature; requires 2–3 proven extension use cases after release |
| `44de3fc0` legacy-install adoption | `PR-16`, Wave 8A | absorb into clean-install/adoption/rollback release proof |
| `cfbac7dc` duplicate signing task | `PR-18` / `b83a94b8` | drop as duplicate of the retained signing/notarization umbrella |
| `bda14d62` stale Wave 0 thread | Wave 0 / `33b67b5c` | drop as stale duplicate; DC-01 is already complete |
| `72563e1c` stale Wave 0 thread | Wave 0 / `33b67b5c` | drop as duplicate of the live DC-13 task and gate |

## Hidden malformed task repaired for accounting

`6f59a861-60e5-48b6-b479-074548a8258c` was absent from MCP task reads because its `blocked_by` entry persisted the prefix `0102baf4`, violating the UUID schema. The DC-02 snapshot preserves the original bytes. DC-13 replaced only that reference with canonical task id `0102baf4-811d-46a4-9157-48f4ace6df00`; MCP then returned the task normally, allowing an explicit disposition. This is containment evidence for `DC-04`/`DC-06`, not a claim that the general reader/transition defect is fixed.

## Database experiment verification

The following task records remain `dropped` with the 2026-08-08 off-trajectory decision: `e27f9132`, `2ecece94`, `5666733c`, and `fd705708`. No active task depends on `seedrop_db`.

## Completion proof

To close DC-13, the live-state verification must show:

- zero unaccounted active tasks;
- the 20 absorbed/merged/superseded records above are durably `dropped` with catalog-aware reasons;
- the seven retained program/release gates are assigned to `mc` with explicit notes;
- `a3ed6030` remains the sole unassigned pre-materialized Wave 1 input;
- the v0.2 historical launch lane remains claimed by `claude` and non-blocking;
- all four database-experiment tasks remain dropped;
- DC-01 and DC-02 are done, then DC-13 and the Wave 0 gate close with validation receipts.

### Verified result before closing DC-13

The live task corpus contained 100 records. DC-13 started with 31 active records, including one malformed open task hidden from native reads. After repair and disposition:

| Check | Result |
| --- | --- |
| Absorbed/merged/superseded tasks dropped | 20 / 20 |
| Retained benchmark/Desktop gates assigned to `mc` with notes | 7 / 7 |
| Historical v0.2 lane retained | 1, claimed by `claude`, non-blocking |
| Wave 1A safety input retained | 1, `a3ed6030` |
| Database-experiment tasks dropped | 4 / 4 |
| Invalid persisted blocker references | 0 after the recorded repair |
| Interim active set | 11: the nine retained lanes plus DC-13 and the Wave 0 gate |

After DC-13 and the Wave 0 gate become `done`, the expected active set is exactly nine records: one unassigned Wave 1A input, seven operator-gated benchmark/Desktop tasks, and the separately claimed historical v0.2 lane. No later internal v2 wave has been materialized.
