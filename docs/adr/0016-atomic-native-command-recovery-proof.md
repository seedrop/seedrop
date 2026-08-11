# ADR 0016: Atomic native command crash and recovery proof

- Status: accepted
- Date: 2026-08-11
- Scope: Seedrop v2 Wave 3, PR-03
- Depends on: ADR 0013, ADR 0014, ADR 0015
- Authority: v2 shadow path only; v1 remains authoritative

## Context

The generic Kernel tests covered seven logical execution boundaries, and the Project
store independently covered five publication boundaries. They did not prove the
complete native command across the nested Kernel, writer-locked commit, publication,
projection, outbox, and Receipt path. In particular, publication faults leave an
honestly reported staging file. The Project reducer classified that non-authoritative
residue as quarantine, so a restart could see the correct whole-or-none transaction
state and still refuse both re-execution and recovery.

## Decision

Publish one executable `KERNEL_ATOMIC_RECOVERY_MATRIX` covering all 16 injected
boundaries in physical order:

| Layer | Boundaries | Restart authority |
| --- | --- | --- |
| Kernel pre-commit | before authorization, after validation, before commit | no transaction; execute again |
| writer-locked commit | after lock, after snapshot | no transaction; execute again |
| immutable publication | before/after write, after file sync | staging only; execute again |
| immutable publication | after atomic publish | whole transaction; recover; directory durability unconfirmed |
| durable commit | after directory sync, transaction publish, projection, or Kernel commit | whole transaction; recover |
| effect/Receipt | before effect, after effect, before Receipt | whole transaction; recover stable effect key and Receipt identity |

The Kernel exposes nested `project_fault` and `publish_fault` proof seams in addition
to its existing logical `fault` seam. Production behavior does not invoke them.

`scanProjectTransactions` continues to report every staging orphan as
`uncommitted_temp`. `reduceProjectTransactions` excludes that one diagnostic class
from authoritative quarantine and completeness because staging is never transaction
truth and cannot participate in the digest chain. All transaction-tree corruption,
fork, gap, duplicate, and read-failure diagnostics still fail closed.

The matrix's visibility statement models an ordinary process restart. A successful
hard link before directory sync exposes the complete file or no file; it does not
claim survival across sudden power loss. Power-loss durability begins only after the
containing-directory fsync boundary.

## Invariants

1. Every injected boundary exposes either zero or one complete command transaction.
2. Before publication, restart re-executes the original request against unchanged
   canonical project state.
3. After publication, restart recovers committed bytes and never replans domain
   Events.
4. Projection and native work state expose the whole logical finish or the prior open
   state, never a partial Intent, Episode, Claim, Receipt, or Lease transition.
5. Outbox replay uses the same effect key and creates one logical delivery even when
   control is lost after the dispatcher returns.
6. Receipt materialization after restart uses identities committed in the transaction.
7. Staging evidence remains inspectable but cannot veto canonical recovery.
8. V1 writers and the separate database experiment remain outside this proof.

## Rejected alternatives

- **Treat staging residue as authoritative corruption.** It turns a harmless
  pre-publication crash into an unrecoverable project.
- **Silently delete every staging artifact while scanning.** Discovery is read-only;
  crash evidence must remain visible and unknown bytes require governed repair.
- **Rerun finish planning after canonical publication.** Generated IDs, clocks, and
  policies may differ; committed transaction bytes are the recovery plan.
- **Call atomic publish power-loss durable before directory fsync.** Process visibility
  and storage durability are different claims.
- **Use `seedrop_db` to coordinate the proof.** The experiment remains off the main
  trajectory until independent evidence proves 10x product value.

## Verification

The focused proof opens native work, injects each matrix boundary into a finish with a
required handoff, constructs a fresh executor, and verifies transaction count,
projection completeness, terminal work state, Lease release, one finish Receipt, and
one logical outbox delivery. Publication tests separately verify staging diagnostics,
whole-or-none visibility, safe retry, and canonical projection completeness.
