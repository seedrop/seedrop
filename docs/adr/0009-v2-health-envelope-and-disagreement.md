# ADR 0009 — Versioned HealthEnvelope, provenance, and disagreement

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 tasks `VI-01/VI-04` / `c1b0ed58`
- **Depends on:** ADR 0006, ADR 0007, ADR 0008
- **Durable v1 change class:** none; standalone v2 contract prototype

## Context

Seedrop v1 reports health through unrelated surfaces:

- daemon `/health` reports process/build/passport registration;
- doctor reports pass/warn/fail checks;
- View audit and preflight report manifest and policy conditions;
- boot separately exposes preflight failure, L-level, stale manifest, fetch warnings,
  daemon reachability, continuity completeness, and advisory byte-budget accounting;
- Bench, Observer, Desktop, CLI, and MCP select and phrase subsets independently.

Those facts can disagree without a record explaining which source governs. The live
Seedrop repo demonstrates this now: View audit reports no structural errors while
preflight reports L1 below required L3, and boot simultaneously calls the manifest
stale. These are not necessarily contradictory propositions, but v1 has no common
envelope proving their scope, source watermarks, observation times, or applicable
policy. A green chip on one surface therefore cannot establish substrate health.

ADR 0006 defines substrate health as an axis independent of lifecycle, evidence,
delivery, readiness, and confidence. It requires `healthy`, `degraded`, `corrupt`,
`migrating`, and `unreachable`, and says healthy is permitted only when required
health sources are complete and compatible. This ADR makes that rule executable.

## Decision

Add `HealthEnvelope` version `1.0.0` to the standalone `@seedrop/protocol` package.
It is a deterministic read contract and has no write authority. Current v1 adapters
do not import it in this slice.

### Envelope fields

Every envelope carries:

- `health_version` and `generated_at`;
- the actual `projection_version`;
- a policy reference with policy version, required projection version, and the exact
  required source IDs;
- one record per observed source;
- structured quarantines, stale projections, and pending commands;
- exact budget accounting;
- preserved disagreements and their governing-policy traces;
- one derived substrate state and the complete sorted reason list.

Each source record names:

- a stable source ID and kind;
- `available`, `corrupt`, `migrating`, or `unreachable` status;
- an authority-owned opaque high-watermark;
- a lowercase `sha256:` content digest;
- observation time and optional freshness boundary;
- a full canonical Claim, Receipt, or Event ID identifying its governing record;
- optional diagnostic prose that never replaces structured status.

An `available` source must have watermark, digest, observation time, and governing
record. Other statuses may retain the last verified evidence or use null when none is
available. Observation after envelope generation, freshness before observation,
malformed digests/IDs, duplicate sources, unknown fields, and `undefined` values fail
typed. A builder never drops unsupported input to obtain valid JSON.

Watermarks are opaque to the protocol because an event sequence, daemon transaction,
Git commit, external cursor, and timestamp have different order semantics. Equality
and lag policy belong to the source adapter or governing projection policy; the
protocol preserves the value and digest exactly.

### Deterministic substrate derivation

Callers provide evidence, never `substrate` or `reasons`. `buildHealthEnvelope`
derives both. `assertHealthEnvelope` rebuilds the envelope and compares canonical
bytes, so a green summary cannot disagree with its evidence.

The single summary state uses fixed safety precedence:

```text
corrupt > migrating > unreachable > degraded > healthy
```

Precedence does not discard concurrent conditions; every applicable reason remains
in the sorted reason list.

| State | Minimum derivation condition |
| --- | --- |
| `healthy` | all required sources exist, are available and fresh; projection version matches policy; no quarantine, lag, pending command, budget failure, or unresolved disagreement |
| `degraded` | optional source unavailable; source/projection stale; projection version incompatible; recoverable pending command; incomplete/overflowing budget; unresolved disagreement |
| `corrupt` | required source reports corrupt; error quarantine exists; or a pending command has no recovery path |
| `migrating` | a required source is explicitly migrating and no corrupt condition outranks it |
| `unreachable` | a required source is missing/unreachable and neither corrupt nor migrating outranks it |

An optional corrupt/migrating/unreachable source degrades the whole envelope rather
than promoting the required substrate to that state. An error-severity quarantine is
always corrupt because the envelope has preserved bytes that cannot participate in
normal truth. A warning quarantine degrades.

### Stale projections and pending commands

A stale projection record contains the projection name, referenced source,
projection watermark, current source watermark, observed time, and reason. The named
source must exist and the claimed current watermark must equal its source record;
otherwise the envelope itself is invalid.

Pending command entries use a full canonical Command ID, explicit phase,
recoverability, observation time, and optional canonical recovery owner. This is a
health summary only. VI-03/VI-06/VI-08 will define command audit, recovery, sweep, and
repair Receipt authority; adapters must not invent command phases here.

### Budget truth

Budget accounting names requested and actual bytes, completeness, candidate count,
indexed count, scanned count, and omitted categories. Counts are non-negative exact
integers, and `indexed_count + scanned_count` must equal `candidate_count`. A
complete result cannot name omitted categories. `actual_bytes` above
`requested_bytes` and `complete=false` are visible degraded reasons rather than
successful trimming claims.

The budget refers to the enclosing read response, so it is observed accounting rather
than a self-referential calculation of the HealthEnvelope's own serialized length.
VI-10 will later define the compiler/refusal boundary for a mandatory envelope that
cannot fit.

### Disagreement preservation and governance

A disagreement names one material field and at least two source claims. Each claim
retains:

- the JSON value, not only its prose summary;
- source ID, observation time, source watermark, and source digest;
- the canonical governing Claim, Receipt, or Event ID.

The claim watermark and digest must equal the evidence on its named source record;
a claim cannot borrow a source ID while supplying different provenance.

Equal canonical values are not a disagreement and fail validation. Claims must name
distinct observed sources. The record always carries a versioned policy trace:

- `unresolved` selects no claim and has no decision record; the envelope degrades;
- `governed` selects one valid claim index, names a canonical decision record, rule,
  policy ID/version, and explanation.

A governed contradiction remains present. It may coexist with `healthy` when all
required sources are complete and the policy intentionally establishes which claim
governs. The informational reason still makes the disagreement queryable. Timestamp
recency alone never selects a claim.

### Versioning and adapter boundary

`health_version` versions this nested contract. `projection_version` versions the
producer's reducer semantics, while the policy separately states the projection
version it accepts. Policy version governs required sources and disagreement rules.
No version is inferred from package, wire, or schema version.

The target architecture requires every v2 read response to carry this envelope or an
explicit reference to identical canonical bytes. That adapter adoption waits for the
generated schema/protocol-completeness gate. This slice intentionally leaves CLI,
MCP, Observer, Bench, Desktop, and all v1 durable formats unchanged.

## Invariants

1. Health summary is derived from evidence and cannot be caller-supplied.
2. Healthy requires every policy-required source to be present, available, fresh,
   and projection-compatible.
3. Missing/unreachable authority never becomes empty success.
4. Every available source has watermark, digest, observed time, and governing record.
5. Evidence cannot postdate the envelope that claims to contain it.
6. Quarantine, lag, pending command, and budget loss remain structured and queryable.
7. Summary precedence never removes a lower-precedence reason.
8. Contradictory claims remain present after governance.
9. Unresolved disagreement degrades; recency never resolves it.
10. Governed disagreement requires a selected claim and canonical decision record.
11. Equal values cannot manufacture disagreement telemetry.
12. Unknown fields and noncanonical JSON fail rather than disappear.
13. The same inputs, policy, versions, and generation time produce identical bytes.
14. Health does not imply evidence passed, delivery occurred, or handoff is ready.
15. V1 remains authoritative until later shadow parity and cutover receipts.

## Rejected alternatives

### Keep separate adapter health booleans

Rejected. Boolean chips cannot express source scope, lag, corruption, migration,
partial reads, disagreement, or budget truth and allow surfaces to drift silently.

### Let adapters choose the substrate state

Rejected. Two adapters could label identical evidence differently. The protocol owns
derivation and adapters render it.

### Treat missing source as healthy with a warning

Rejected. Required authority absence makes health unreachable; optional absence is
degraded. Neither is green.

### Collapse every non-healthy condition into degraded

Rejected. Corruption, active migration, and reachability require different safety and
recovery behavior. One generic warning would recreate the existing ambiguity.

### Resolve disagreement with newest timestamp

Rejected. Clock order proves observation order at best, not authority, applicability,
or permission to supersede another claim.

### Store only the selected disagreement value

Rejected. It destroys negative evidence and makes policy changes or correction audits
impossible. Both claims and the decision trace survive.

### Make logs the health authority

Rejected. Logs are supporting evidence, not complete, versioned, queryable state.

### Wire current v1 adapters immediately

Rejected. Wave 2 freezes the contract. Adapter parity, generated schema, shadow
comparison, and cutover are separate gates.

## Consequences

Seedrop now has one executable answer for substrate health that can later be shared by
Situation, CLI, MCP, Observer, Bench, and Desktop without adapter-owned semantics. The
contract exposes the exact facts needed to explain the current boot/preflight/audit
mismatch instead of hiding it behind a chip.

The envelope is intentionally verbose. Situation's byte-bounded compiler may refer to
content-addressed health bytes or include a mandatory compact form later, but it may
not omit the existence of corruption, missing authority, disagreement, or budget
failure.

## Verification

Authoritative proof consists of:

- focused derivation, precedence, validation, determinism, and tamper tests;
- focused governed/unresolved disagreement and false-disagreement tests;
- `protocol/fixtures/health-envelope-v1.json` with exact canonical digests for all
  five substrate states plus both disagreement outcomes;
- built-output verification on supported Node majors;
- package and workspace typecheck/test/build gates;
- durable-v1 freeze verification and a search proving no v1 consumer imports the
  protocol package.
