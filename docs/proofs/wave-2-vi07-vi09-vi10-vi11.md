# Wave 2 proof — VI-07 / VI-09 / VI-10 / VI-11

- **Task:** 57104322-e9c2-41d9-a337-09a1ed1444ba
- **Run:** eb919ee4-198e-4215-b379-de8a5384e3bb
- **Date:** 2026-08-10
- **Scope:** retry/CAS/outbox observability, field explanations, enforced bounded
  output, and fail-closed telemetry consent/export authorization
- **Durable v1 change class:** none

## Delivered contract

@seedrop/protocol now owns four new version 1.0.0 executable boundaries.

OperationalMetricsSnapshot derives duplicate-idempotency, CAS-conflict, retry,
outbox-lag, and dead-letter counters from canonical Event-backed spans. Its policy
derives retry-storm, lag-SLO, and dead-letter alerts. Submitted summary drift is
detectable because counters, aggregate lag, and alerts are rebuilt from the spans.

FieldExplanationTrace makes each material Situation field either resolved or
unknown. A resolved field requires confirmed/inferred confidence, canonical value
digest, projection version, versioned policy rule, governing decision, and evidence
containing an Event or Receipt. Unknown fields cannot assert a value or decision and
instead carry a typed cause and explicit evidence request.

CompileBoundedOutput enforces the byte/work budget rather than observing it after
the fact. Required candidates must fit. Optional candidates are selected
deterministically by required status, priority, and ID. Successful output carries
exact canonical full-envelope UTF-8 bytes, candidate/index/scan counts, scan limit,
included/omitted counts, and omitted categories. It refuses mandatory overflow and
scan-limit breaches; it never byte-slices JSON.

Telemetry defaults to local_only. Explicit consent is a canonical, expiring Receipt
scoped to Principal, Project, destination, schema, categories, purpose, and evidence.
Authorization is denied for absent, denied, revoked, early, expired, or mismatched
consent. Payload top-level categories must exactly match the declared request and
remain within consent. Sensitive key, private-key, bearer, and common API credential
patterns deny authorization without echoing the suspected value.

No exporter or v1 writer was added. A future exporter must require the authorization
and exact payload digest defined here. The seedrop_db experiment remains outside this
trajectory.

## Golden evidence

protocol/fixtures/observability-v1.json freezes six reliability spans, one resolved
and one unknown explanation, a three-candidate bounded compilation with Unicode, one
explicit consent Receipt, one export request, and the negative consent/secret/budget
paths:

| Artifact | Canonical SHA-256 / value |
| --- | --- |
| operational metrics snapshot | sha256:ceabc824d1b3a8faf94dbe97c66129541ee280b1127c95c311fb639a2febdec5 |
| field explanations | sha256:f1eecb37e8ccdcafedd86836375c757c43d8f0ff4e51076bac0945888514babc |
| bounded output | sha256:85b6712de588e7f95a1c15b7378e1691f1a26576cc197ee7f609499ccb530ba5 |
| bounded actual bytes | 466 of 4096 requested |
| export authorization | sha256:e3ca36ca2ff210d1b7ef09ad079a408b006749e9888218d7c0efa1d87c09ea82 |
| derived alerts | 3 |
| resolved / unknown explanations | 1 / 1 |
| no-consent / secret / insufficient-budget denial | passed / passed / passed |

The base, HealthEnvelope, command/recovery, and observability vectors reproduced
exactly on Node 20.20.2, Node 22.23.2, and Node 24.19.0.

## Validation evidence

- Protocol: typecheck passed; build passed; 9 files / 96 tests passed.
- Focused observability coverage: 15 tests covering derived counters/alerts, lag and
  span contradictions, future/tampered metrics, resolved and typed-unknown fields,
  claim-only/missing evidence, exact Unicode bytes, deterministic ordering, honest
  omissions, required overflow, scan overflow, candidate duplication, local-only
  default, early/expired/denied/revoked consent, identity/destination/schema/category
  mismatch, secret findings, expiring grants, and self-evidence.
- All eight npm workspaces: typecheck passed and build passed.
- Full Node 20 workspace suite: 90 Vitest files; 955 tests passed, 3 skipped; 3
  additional Desktop release-control tests passed.
- Durable-v1 freeze: passed at contract SHA-256
  fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b,
  covering 64 artifacts and 3 accepted transitions; both freeze harness tests passed.
- V1 import boundary: no CLI, MCP, ID, Space, Observer, Bench, Desktop, or package
  source imports @seedrop/protocol.
- Identity reconciliation: sanitized and live read-only modes both observed 9
  passports, 29 links, 24 unique roots, 9 canonical Principals, 23 canonical
  Projects, and 0 unresolved project sources.
- Package dry-run: 68 entries; observability declarations, JavaScript, sources,
  fixture, focused verifier, and aggregate runtime verifier are included; packed
  size 105,141 bytes, unpacked size 574,845 bytes.
- git diff --check: passed.

Desktop release verification was not asserted and its status remains developer
preview, as required by repository policy.

## Exit assessment

VI-07, VI-09, VI-10, and VI-11 are satisfied at the v2 protocol boundary.

Retry, CAS, and outbox visibility is derived from queryable spans rather than prose
or adapter-owned counters. A confident field cannot exist without provenance. A
successful bounded output cannot overflow its requested bytes or hide scan work.
Telemetry authorization cannot be created without active exact-scope consent and a
secret-free category-matched payload.

This slice intentionally does not connect v1 writers, start telemetry collection,
or perform an export. PR-01 protocol completeness/generated-schema work and PR-02
property proof remain the next Wave 2 gates before the protocol/visibility gate can
close.
