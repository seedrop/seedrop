# ADR 0006 — Freeze the Seedrop v2 ontology and orthogonal trust axes

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 task `TR-01/TR-08/TR-11` / `e7047e61`
- **Durable v1 change class:** none; contract-only v2 decision

## Context

Seedrop v1 has three useful coordination primitives—Task, Run, and Signal—but the machine corpus shows that the product state is larger than their status fields:

- a Run may report `completed` while its work is uncommitted, reverted, superseded, or absent at current `HEAD`;
- validation may be passed, failed, stale, skipped, unavailable, or not performed;
- a handoff may be resumable even while the substrate is degraded;
- a healthy repository projection says nothing about whether an Episode was delivered;
- aliases can make one human or agent appear as several actors;
- Tasks, handoffs, packet threads, Run goals, and inbox prose all compete to represent wanted work;
- Run files and continuity packets separately retain execution and reasoning;
- L0–L4 compresses project presence, freshness, validation, active work, and readiness into one ladder.

This creates impossible implications. `completed` has been promoted to proof, a high readiness level has implied healthy evidence, and a missing parse result has looked like absence. Wave 1 stops those unsafe promotions in v1. Wave 2 must freeze a v2 vocabulary that cannot encode them again.

This ADR is a protocol decision only. It introduces no v2 writer, migration, package, database, or source-of-truth cutover. The durable v1 freeze remains in force.

ADR 0001 remains the implemented v1 coordination surface. This ADR supersedes its three-primitives ontology only for native v2 protocol state; compatibility commands keep their v1 names until later migration and adapter gates authorize removal.

## Decision

Seedrop v2 has nine public nouns. Eight name durable facts or identities; Situation names their deterministic read projection.

| Noun | Meaning | Authority and lifecycle |
|---|---|---|
| **Principal** | One canonical actor: human, agent, or service. Client names, passport IDs, display names, and session IDs are aliases or placements, never competing identities. | Machine identity authority plus versioned alias records. Alias ambiguity denies resolution. |
| **Project** | One canonical body of work, normally a repository, with explicit repo/worktree/folder placements. | Project identity record. A changed path or cwd never creates a second Project implicitly. |
| **Intent** | A unit of wanted work, decision, question, or repair. It replaces the semantic overlap among Task, handoff, and open thread. | Immutable Intent events projected into an Intent lifecycle. |
| **Episode** | One execution attempt against an Intent. It carries steps, decisions, assumptions, changed paths, failures, and requested follow-ups. | Immutable Episode events projected into an Episode lifecycle. One Intent may have zero or many Episodes. |
| **Claim** | A proposition about a Principal, Project, Intent, Episode, artifact, or external outcome, with provenance, observed time, freshness, confidence, and invalidation rules. | Claims coexist with contradictions. Correction appends an invalidation or superseding Event; it does not overwrite history. |
| **Receipt** | Immutable evidence that an observation, validation, Git/CI/review action, delivery, migration, repair, or operator decision occurred against named inputs. | The observing authority signs or identifies the Receipt. Freshness and applicability are projected, never inferred from mere existence. |
| **Lease** | Time-bounded ownership of a target/version for collision avoidance or exclusive execution. | Lease events plus time determine active/released/expired/revoked state. Presence and task assignment are not Leases. |
| **Event** | The immutable canonical record of an accepted command and its result. One Event transaction may contain several domain facts that must become visible atomically. | Project Events are content-addressed repo truth. Machine coordination remains transactional daemon truth. Event storage details are decided after this contract. |
| **Situation** | A deterministic, authorized, byte-bounded projection answering what is true, uncertain, changed, unsafe, and next. | Disposable projection over named authorities. A Situation is never a write authority and every material field carries evidence or a typed unknown. |

### Entity relationships

```text
Principal --issues--> Event --belongs to--> Project
Project   --contains--> Intent --attempted by--> Episode
Intent/Episode/Project --described by--> Claim --supported by--> Receipt
Principal --holds--> Lease --scoped to--> Project target/version
Situation --projects--> authorized Events + Claims + Receipts + Leases + daemon facts
```

The following invariants are normative:

1. Every state-changing command names a canonical Principal and, when project-scoped, a canonical Project.
2. Every Episode references exactly one Intent. An unlinked v1 Run imports as unresolved; migration never invents an Intent link.
3. An Intent can exist without an Episode. An Episode cannot exist without an Intent in native v2 state.
4. A Claim is not evidence for itself. Confidence, freshness, and Receipt references are explicit.
5. Contradictory Claims remain visible until an authorized governing rule resolves or invalidates them.
6. A Receipt records an observation; it never rewrites the report or Event it observes.
7. A Lease grants bounded concurrency ownership only. It does not imply task assignment, execution, presence, correctness, or delivery.
8. An Event is append-only. Corrections, reopening, invalidation, and repair append Events and preserve the prior report.
9. Situation is deterministic for the same authorized inputs, policy, projection version, source watermarks, and byte budget.
10. No adapter—CLI, MCP, Observer, Bench, or Desktop—may add domain semantics that are absent from the protocol projection.

## Lifecycle models

Lifecycle is historical command state. It is not evidence, delivery, health, readiness, or confidence.

### Intent lifecycle

```text
queued -> active | paused | blocked | abandoned
active -> paused | blocked | reported_complete | abandoned
paused -> active | blocked | abandoned
blocked -> active | paused | abandoned
reported_complete -> terminal
abandoned -> terminal
```

- `queued` means wanted work exists but no Episode is active.
- `active` means at least one current Episode is executing under the Intent.
- `paused` is a deliberate resumable stop without an external blocker.
- `blocked` names an explicit unmet condition.
- `reported_complete` is the actor's report that the wanted work is finished. It implies no validation or delivery fact.
- `abandoned` is a conscious decision not to continue this Intent.

A terminal Intent is never silently resurrected. A correction appends a correction Event; renewed work creates a successor Intent with an explicit `supersedes` or `reopens` relation and authority. The exact reopen command is a later kernel decision.

### Episode lifecycle

```text
active -> paused | blocked | reported_complete | failed | abandoned
paused -> active | blocked | failed | abandoned
blocked -> active | paused | failed | abandoned
reported_complete -> terminal
failed -> terminal
abandoned -> terminal
```

- `failed` requires a cause and means this attempt ended unsuccessfully.
- `abandoned` means the attempt was consciously stopped without claiming a technical failure.
- a crashed or stale v1 Run may project to `failed` only through an explicit sweep/inference Event that records its confidence and cause; disappearance is forbidden.
- a failed or abandoned Episode remains negative continuity evidence. “Grave” is a Situation view over such Episodes, not a tenth canonical durable noun.

### Lease lifecycle

```text
active -> released | expired | revoked
released | expired | revoked -> terminal
```

- acquisition is compare-and-set against target, scope, and expected version;
- `expired` is true when the authoritative evaluation time exceeds the lease boundary, even before a sweep materializes an expiry Event;
- retrying the same acquisition key returns the same Lease; a conflicting holder is visible;
- extending ownership appends a renewal Event and never rewrites the acquisition record.

## Orthogonal trust axes

The current state projection exposes these axes separately. Missing evidence produces an explicit state; it never inherits from another axis.

| Axis | States | Governing evidence |
|---|---|---|
| **Intent lifecycle** | `queued`, `active`, `paused`, `blocked`, `reported_complete`, `abandoned` | Intent and Episode Events |
| **Episode lifecycle** | `active`, `paused`, `blocked`, `reported_complete`, `failed`, `abandoned` | Episode Events |
| **Evidence** | `unverified`, `passed`, `failed`, `stale`, `unavailable` | applicable validation/observation Receipts and freshness policy |
| **Delivery** | `not_applicable`, `unobserved`, `uncommitted`, `committed`, `review_open`, `merged`, `reverted`, `superseded`, `absent` | Git, CI, review, release, or operator Receipts |
| **Substrate health** | `healthy`, `degraded`, `corrupt`, `migrating`, `unreachable` | versioned Health inputs with watermarks and diagnostics |
| **Handoff readiness** | `not_ready`, `resumable_with_risk`, `ready` | policy projection over lifecycle, unknowns, evidence, health, Leases, and worktree state |
| **Confidence** | `observed`, `inferred_high`, `inferred_low`, `unknown` | per-Claim provenance and inference method |

Rules for these states:

- `unverified` means no applicable validation Receipt exists.
- `stale` means a once-applicable Receipt no longer covers current inputs.
- `unavailable` means the authority could not be queried; it is not `failed`.
- `unobserved` is the default delivery state when delivery authority was not queried or no applicable Receipt exists.
- `uncommitted` and `absent` require observations. They cannot be guessed from a missing local path.
- `not_applicable` is explicit policy for work without a delivery target; it is not a fallback for missing evidence.
- `healthy` is permitted only when required health sources are complete and compatible. Missing required health is `degraded` or `unreachable`.
- confidence belongs to an individual Claim. Any Situation-level confidence is a transparent aggregation, not a replacement for field-level confidence.
- readiness is a derived recommendation aid. It never rewrites lifecycle, evidence, delivery, or health.

No implication exists between axes except where a versioned policy explicitly declares and explains a decision rule. In particular:

```text
reported_complete != passed
reported_complete != committed
passed != delivered
merged != passed
healthy != ready
ready != delivered
unknown != absent
unreachable != empty
```

## V1 compatibility mapping

V1 remains authoritative until a later shadow migration and cutover receipt. Compatibility readers map without changing v1 bytes.

| V1 source | V2 projection | Required caveat |
|---|---|---|
| passport `agent_id` / passport id / name | Principal candidate and aliases | ambiguity remains unresolved and default-denied; aliases never become separate Principals |
| passport `active_projects` / cwd roots | Project candidates and placements | duplicate/ambiguous roots enter reconciliation; no silent Project merge |
| Task | Intent | `open -> queued`, `in_progress -> active`, `blocked -> blocked`, `done -> reported_complete`, `dropped -> abandoned`; `claimed` adds owner context but does not prove execution |
| Task assignment or legacy Handoff | Intent routing/recipient relation | assignment is not lifecycle, Lease, acceptance, or delivery |
| Run | Episode | `in_progress -> active`, `completed -> reported_complete`, `blocked -> blocked`, `failed -> failed`; legacy terminal semantics are retained as import metadata |
| Run validation entry | Receipt candidate | command text/status are preserved; freshness and input identity may remain unknown |
| Signal claim/lock | Lease candidate | intent text is preserved; conflicting v1 ownership remains a diagnostic |
| continuity packet | Claims and narrative attached to a deterministically related Episode | ambiguous linkage remains unresolved; packet prose never creates facts silently |
| packet open thread | Intent candidate | already-materialized Task identity wins; duplicates reconcile by evidence |
| knowledge artifact | Claim set with provenance | validation/supersession metadata does not imply current truth without applicable Receipts |
| Git/outcome observation | Receipt | observation time, repo identity, input commit, and observer identity remain explicit |
| Space message / inbox mention | coordination Event or pointer | prose does not become an Intent unless an explicit command creates one |
| presence session | ephemeral coordination projection | presence is neither a Lease nor proof of work |
| manifest / audit / L0–L4 | disposable projection inputs | imported as observations/diagnostics; never canonical lifecycle |
| failed or swept Run | failed Episode / Grave projection | cause, sweep status, confidence, and recovery condition are preserved |

When a v1 field cannot map without guessing, import produces an unresolved Claim or typed diagnostic. “Best effort” may preserve bytes; it may not invent semantics.

## Exhaustive observed-state classes

These classes cover the combinations already present or directly implied by the machine corpus. They are contract fixtures for later generated schemas and property tests.

| # | Lifecycle | Evidence | Delivery | Health | Readiness | Confidence | Required interpretation |
|---|---|---|---|---|---|---|---|
| 1 | `reported_complete` | `passed` | `uncommitted` | `healthy` | `resumable_with_risk` | `observed` | Work was reported and validated locally but has not reached the delivery authority. Never say delivered. |
| 2 | `reported_complete` | `unverified` | `unobserved` | `healthy` | `resumable_with_risk` | `observed` | Preserve the report; request validation and delivery evidence. |
| 3 | `reported_complete` | `stale` | `committed` | `healthy` | `resumable_with_risk` | `observed` | A commit exists, but validation does not cover current inputs. |
| 4 | `reported_complete` | `passed` | `merged` | `healthy` | `ready` | `observed` | Strong delivery state; still cite the Receipts rather than promote lifecycle wording. |
| 5 | `reported_complete` | `passed` | `reverted` | `healthy` | `not_ready` | `observed` | Historical delivery occurred and was undone. Do not treat the report as current success. |
| 6 | `reported_complete` | `passed` | `superseded` | `healthy` | `not_ready` | `observed` | Work survives only as superseded history; point to the governing successor. |
| 7 | `reported_complete` | `unavailable` | `unobserved` | `unreachable` | `resumable_with_risk` | `unknown` | Preserve local work and refuse delivery claims; coordination outage is not empty state. |
| 8 | `active` | `failed` | `uncommitted` | `degraded` | `not_ready` | `observed` | Work is ongoing, validation currently fails, and local changes exist. Recommend repair, not handoff completion. |
| 9 | `blocked` | `passed` | `review_open` | `healthy` | `resumable_with_risk` | `observed` | Validation passed, but an explicit blocker remains; review existence does not clear it. |
| 10 | `failed` | `failed` | `absent` | `healthy` | `not_ready` | `observed` | A failed attempt with evidence; retain as a Grave and recovery warning. |
| 11 | `abandoned` | `unverified` | `not_applicable` | `healthy` | `not_ready` | `observed` | Conscious negative knowledge; never route as active work. |
| 12 | `queued` | `unavailable` | `not_applicable` | `corrupt` | `not_ready` | `unknown` | Intent existence may be preserved, but corruption blocks confident orientation until repaired. |
| 13 | `active` | `passed` | `uncommitted` | `migrating` | `resumable_with_risk` | `observed` | Work facts survive while migration prevents unsafe writes. |
| 14 | `reported_complete` | `passed` | `absent` | `healthy` | `not_ready` | The report and validation exist, but current delivery authority observes no surviving result. This is contradiction, not data loss. |

The tables are exhaustive over observed **classes**, not the Cartesian product. Later PR-02 property tests must prove that every value is independently representable and that no invalid lifecycle edge becomes valid through another axis.

## Authority to block or recommend action

Situation policy may block a next action only with a named fact and evidence trace. The minimum blocking classes are:

- unresolved or ambiguous Principal/Project identity for a write;
- `corrupt` or `migrating` required authority for a write;
- `unreachable` required authority when the command cannot be safely local-only;
- an active conflicting Lease;
- an explicit Intent blocker;
- failed applicable validation for a delivery action;
- missing required Receipt, expected version, or authorization;
- a byte budget too small for the mandatory safe envelope.

Unknowns do not automatically stop all work. Policy must distinguish safe local inspection from writes, delivery, handoff, and destructive repair. A refusal returns the blocking facts and the smallest evidence or repair action; it never invents a fallback next action.

## Rejected alternatives

### Keep Task, Run, and Signal as the v2 domain model

Rejected. Those are valid v1 compatibility primitives, but they cannot represent one Intent with multiple Episodes, evidence/delivery independence, field-level Claims, or transactional repair without expanding into the same fragmented model under old names.

### Use one success/readiness ladder

Rejected. L0–L4 cannot order independent facts. A clean committed project can have stale validation; an uncommitted Episode can be safely resumable; a healthy substrate can contain failed work.

### Treat `completed` as proof when the worktree is clean

Rejected. Cleanliness does not establish authorship, survival, merge, review, or applicability of validation. Delivery requires a Receipt from the relevant authority.

### Resolve contradictions by newest timestamp

Rejected. Clock order does not establish authority or applicability. Contradictory Claims remain visible with source watermarks until a governing rule or authorized correction resolves them.

### Make Situation or a local index the source of truth

Rejected. Situation and indexes are disposable projections. They must rebuild from canonical project Events, daemon facts, external Receipts, and explicit policy.

### Put all state in one event ledger

Rejected. Repo-portable project truth and machine-global coordination have different replication, privacy, latency, and transaction boundaries. The protocol unifies semantics; it does not require one physical store.

### Adopt the `seedrop_db` experiment as the v2 substrate

Rejected for the main trajectory. Its semantic lessons inform the contract, but integration requires separately preregistered, reproducible, black-on-white evidence of approximately 10x end-to-end Seedrop product value. This ADR creates no dependency on that experiment.

## Consequences

- V2 package and schema work has a fixed vocabulary and cannot introduce new public nouns casually.
- Lifecycle, evidence, delivery, health, readiness, and confidence remain independently representable.
- V1 Tasks/Runs/Signals remain supported through explicit compatibility mapping until shadow migration and rollback gates pass.
- Situation becomes the product read without becoming authority.
- Graves remain a useful product projection without adding a duplicate durable entity.
- Protocol completeness and state-model property tests now have a finite contract to generate and traverse.
- Later ADRs must specify canonical IDs/bytes/errors/versions, identity registries, HealthEnvelope, command recovery, and observability without changing these meanings implicitly.
- Any semantic change to this ontology requires a superseding accepted ADR and a protocol version change. It cannot enter as an incidental implementation detail.
