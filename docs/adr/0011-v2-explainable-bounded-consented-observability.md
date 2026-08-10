# ADR 0011 — Explainable, bounded, consented observability

- **Status:** accepted
- **Date:** 2026-08-10
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 tasks VI-07/VI-09/VI-10/VI-11 / 57104322
- **Depends on:** ADR 0006, ADR 0007, ADR 0009, ADR 0010
- **Durable v1 change class:** none; standalone v2 contract prototype

## Context

Seedrop has substantial visibility evidence but no common protocol for interpreting
or constraining it:

- Space has a durable post outbox with attempts, lagging effects, explicit retry,
  and dead letters, while other commands expose different retry surfaces;
- command audit trails preserve idempotency and recovery, but do not define the
  counter/span projection required to detect retry storms or outbox SLO breaches;
- HealthEnvelope carries caller-supplied budget accounting, but does not itself
  compile an output or prove that actual canonical bytes fit the request;
- View explain can describe selected paths and readiness, while Situation fields do
  not have a shared field-level provenance contract;
- there is no v2 exporter today, which is the correct moment to make local-only the
  protocol default rather than adding consent after collection exists.

VI-07 requires queryable duplicate-idempotency, CAS-conflict, retry, outbox-lag, and
dead-letter metrics. VI-09 requires every confident material field to resolve through
evidence and policy or become a typed unknown. VI-10 requires actual bounded work and
output, not a requested number attached after a full scan. VI-11 requires export to
be structurally impossible without explicit, active, exact-scope consent.

## Decision

Add four independent version 1.0.0 executable contracts to @seedrop/protocol:

1. OperationalMetricsSnapshot, derived from canonical Event-backed spans;
2. FieldExplanationTrace, resolved or explicitly unknown;
3. BoundedOutputEnvelope, produced only by a deterministic enforcing compiler;
4. TelemetryConsentReceipt and TelemetryExportAuthorization, local-only by default.

The package remains an executable specification. It does not start collection,
perform network export, replace current View explain output, or connect any v1
writer. Later kernel, Situation, daemon, CLI, and exporter implementations must
produce or consume these bytes rather than reinterpreting them independently.

## Operational metrics

Each OperationalMetricSpan names a canonical Event, Project, and Command; one
operation; observation time; duration; attempt; evidence digest; and exactly one
kind:

- duplicate_idempotency;
- cas_conflict;
- retry;
- outbox_lag;
- outbox_dead_letter.

Outbox kinds require a nonnegative lag sample. Non-outbox kinds forbid one. Event IDs
are unique and observations cannot postdate the snapshot. The builder sorts spans
canonically and derives all counters, aggregate lag, and alerts. A caller cannot
submit a green counter summary while retaining contradictory spans.

The versioned policy names the maximum retries per Command and outbox lag SLO.
Derived alerts cover:

- retry_storm when one Command exceeds its retry threshold;
- outbox_lag_slo_exceeded when a sample exceeds the declared SLO;
- outbox_dead_letter for every poison/dead-letter observation.

CAS conflicts are counted as detected/prevented lost updates. This contract does not
claim that an undetected lost update is zero; the future transactional kernel must
make compare-and-swap the only accepted write path and emit a span on every conflict.
The distinction prevents an absence-of-events metric from becoming false proof.

Spans exclude raw command arguments, message bodies, environment values, and secret
material. Evidence is referenced by digest and canonical Event identity.

## Field explanations

A FieldExplanationTrace names one Situation and material field, projection version,
versioned policy/rule, ordered evidence, and one of two states.

Resolved:

- confidence is confirmed or inferred;
- value digest is present;
- governing decision record is present;
- at least one evidence item exists;
- the evidence contains an Event or Receipt;
- typed unknown is absent.

Unknown:

- confidence is exactly unknown;
- value digest and decision record are absent;
- a code, human-readable message, and nonempty requested-evidence list are present;
- partial evidence may remain visible.

Evidence names a canonical Claim, Receipt, or Event, source, role, digest, and
observation time. A confident field without provenance is invalid rather than merely
degraded. An unknown is not a null value with an optimistic label: it explicitly
states what evidence would allow resolution.

The trace is transport-neutral. A future shared explanation API can project it to
seed doctor --explain, CLI, MCP, Observer, Bench, and Desktop without giving those
adapters independent decision logic.

## Enforced bounded output

CompileBoundedOutput accepts:

- a positive requested UTF-8 byte budget;
- a maximum scanned-candidate count;
- canonical candidates with stable ID, category, index-or-scan acquisition,
  required flag, priority, and JSON value.

The compiler rejects duplicate candidate IDs and refuses before output if scan
accounting exceeds its declared maximum. Candidates normalize in this order:

1. required before optional;
2. higher priority before lower priority;
3. candidate ID as deterministic tie-breaker.

All required candidates form the mandatory payload. If the canonical full envelope
cannot fit, compilation fails with budget_insufficient. Optional candidates are
considered deterministically and included only when the full proposed envelope fits.
There is no byte slicing, invalid JSON, hidden overflow, or build-full-world-then-trim
fallback.

The returned envelope reports:

- requested and exact actual bytes;
- complete versus incomplete;
- total candidate, indexed, and scanned counts;
- scan limit;
- included and omitted counts;
- sorted omitted categories;
- included canonical payload items.

Actual bytes are the UTF-8 length of the entire canonical returned envelope,
including the accounting fields themselves. The builder solves that self-reference
to a stable fixed point and the verifier remeasures it. Every successful result
therefore satisfies actual_bytes less than or equal to requested_bytes. The adapter
may convert the same accounting to HealthBudget without reinterpretation.

HealthEnvelope remains able to describe a discovered legacy overflow as degraded.
New bounded compilers must use this enforcing contract, so they either return
within-budget bytes or a typed refusal.

## Telemetry consent and export

The protocol default is local_only. No Receipt means no export. Denied, revoked,
not-yet-issued, and expired Receipts also mean no export.

An explicit TelemetryConsentReceipt names:

- canonical Receipt, Principal, Project, and governing evidence IDs;
- granted, denied, or revoked decision;
- issue time and, for grants, mandatory expiry time;
- purpose;
- sorted categories;
- exact destination;
- exported schema ID and version.

The Receipt cannot cite itself. A grant without expiry is invalid so permanent
ambient consent cannot emerge accidentally.

AuthorizeTelemetryExport is the only contract path that creates an authorization.
It requires an active grant and exact equality for Principal, Project, destination,
schema ID, and schema version. Requested categories must be a subset of consent and
must exactly match the top-level payload keys. This prevents unrelated data from
being hidden beneath an approved category declaration.

Before authorization, the complete canonical payload is scanned for sensitive key
names, private-key blocks, bearer credentials, and common live/test API credential
shapes. A finding returns only path and pattern metadata and denies export; the
suspected value is never copied into the error. Successful authorization names the
consent Receipt and carries the canonical payload digest, not mutable payload bytes.

This contract does not provide a network client. A future exporter must accept a
fresh TelemetryExportAuthorization and the exact payload whose digest it names.
Local storage and user-visible export inspection remain separate implementation
requirements.

## Invariants

1. Metric summaries and alerts are derived from canonical spans.
2. Metric spans have unique Event identity and cannot postdate their snapshot.
3. Outbox lag exists exactly for outbox span kinds.
4. Retry storms, outbox SLO breaches, and dead letters are policy-queryable.
5. A resolved field always names value, projection, policy, decision, and evidence.
6. Resolved evidence contains at least one Event or Receipt.
7. Unknown fields cannot retain confident value or decision assertions.
8. Unknown fields name the smallest evidence request needed for resolution.
9. A successful bounded envelope remeasures to its declared actual bytes.
10. Successful actual bytes never exceed requested bytes.
11. Candidate, index, scan, inclusion, and omission counts reconcile exactly.
12. Required truth is never silently omitted.
13. Scan work beyond the declared limit refuses.
14. Optional selection is deterministic and never byte-slices JSON.
15. Telemetry is local-only without an explicit active grant.
16. Consent is exact to Principal, Project, destination, schema, categories, and time.
17. Export payload categories exactly match their declared category list.
18. Secret-pattern findings deny authorization without echoing the suspected value.
19. Consent Receipts and export authorizations are versioned and queryable.
20. V1 remains authoritative until shadow parity and explicit cutover Receipts.

## Rejected alternatives

### Accept counters supplied by each adapter

Rejected. A counter without spans cannot be reconciled, deduplicated, or explained.
Derived counters keep supporting evidence and policy alerts in one deterministic
projection.

### Treat no CAS-conflict event as proof of no lost update

Rejected. Absence of a conflict event only proves no conflict was observed. The
future kernel must make CAS mandatory before the metric can support the stronger
claim.

### Make explanation prose the contract

Rejected. Prose cannot enforce evidence identity, policy/projection versions, or the
difference between inferred confidence and missing truth.

### Truncate JSON to requested bytes

Rejected. Byte slicing can corrupt UTF-8 and JSON and hides omitted categories. The
compiler selects complete candidates and measures the complete canonical envelope.

### Build the full history and trim the response

Rejected. It satisfies output size while violating work bounds and creating the same
timeout/staleness cascade. Index and scan counts plus a scan limit are first-class.

### Allow mandatory truth to overflow

Rejected. An overflow is not a bounded result. The caller receives a typed refusal
and may explicitly request a larger budget or a different policy.

### Enable anonymous aggregate telemetry by default

Rejected. Aggregate payloads can still reveal repository, behavior, timing, and
credential material. Local-only is the safe default and explicit consent is scoped.

### Let one consent cover arbitrary destinations or schemas

Rejected. Changing destination or schema changes who can observe which structure.
Both are part of the authorization boundary.

### Redact detected secrets and export the rest automatically

Rejected. Pattern matching is not a proof that redaction is complete. A finding
fails closed and requires the operator or producer to repair the payload.

## Consequences

Wave 2 now has one protocol answer for how retry/outbox failures are measured, how a
material claim is explained, how a byte budget is enforced, and how telemetry export
is authorized. Future adapters can converge on these contracts without coupling to
one physical database or daemon implementation.

The contracts are deliberately stricter than current v1 surfaces. Legacy explanations
without evidence remain unknown; legacy budget reports may reveal overflow but cannot
be presented as successful bounded compilation; and no preexisting configuration is
implicitly migrated into telemetry consent.

## Verification

Authoritative proof consists of:

- derived counter, alert, lag, tamper, kind, and time tests;
- resolved/unknown explanation tests and confident-without-evidence rejection;
- exact Unicode/full-envelope byte tests, deterministic ordering, required-fit
  refusal, scan-limit refusal, and candidate-accounting tests;
- absent, denied, revoked, early, expired, identity, destination, schema, category,
  payload-category, and secret-pattern export denial tests;
- protocol/fixtures/observability-v1.json with exact canonical digests;
- built-output verification on Node 20, 22, and 24;
- protocol/package/workspace gates, durable-v1 freeze verification, and proof that
  v1 sources still do not import @seedrop/protocol.
