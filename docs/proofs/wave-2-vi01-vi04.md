# Wave 2 proof — VI-01 / VI-04

- **Task:** `c1b0ed58-6bf0-4b53-bb31-cce3dfc02b82`
- **Run:** `8a385f85-ca07-411e-8ef7-dd4143c685da`
- **Date:** 2026-08-09
- **Scope:** versioned HealthEnvelope, source provenance/watermarks, deterministic
  substrate derivation, budget truth, and governed/unresolved disagreement
- **Durable v1 change class:** none

## Delivered contract

`@seedrop/protocol` now owns `HealthEnvelope` version `1.0.0` and derives its
summary from structured evidence. Callers cannot submit `substrate` or `reasons`.
The derived safety precedence is:

```text
corrupt > migrating > unreachable > degraded > healthy
```

The envelope preserves required and optional sources, opaque high-watermarks,
content digests, observation/freshness times, canonical governing records,
quarantines, stale projections, pending commands, exact byte/candidate accounting,
and contradictory claims. Governed contradiction requires a selected claim and a
canonical decision record; unresolved contradiction degrades. Claim watermarks and
digests must match their named source evidence.

Stable failures were added for malformed health input, inconsistent summaries, and
invalid disagreement records. ADR 0009 records the governing rules and the explicit
decision not to wire v1 adapters before later parity and cutover gates.

## Golden evidence

`protocol/fixtures/health-envelope-v1.json` contains exact expected canonical bytes
for all five substrate states and both disagreement outcomes:

| Case | Derived state | Canonical SHA-256 |
| --- | --- | --- |
| healthy | healthy | `6b01f5e09570e662f4ee887b19f045a061e9d47cd27d56c7b15f1620dd6bf3d6` |
| degraded | degraded | `351361d6aa068b180b66ee32571cb81d186000a7585740c92eecb0d85b6dc5e5` |
| corrupt | corrupt | `330a19f8dea9059fbf26d12f10f8e965b3c17b2f94ad88cdf0fd3acd4858638d` |
| migrating | migrating | `705215e148849ade71ed12bded9184ddb5847ddb35b82bafdcedfd01fca5535b` |
| unreachable | unreachable | `c93087f1ae0b90f51b2bd86e09fe98d3c53927980f7cd22d4d55c712819dc857` |
| disagreement-unresolved | degraded | `90cbbffe2bcf1337e82c621f3f392a1b5b903fee7642855cd53396176100d19d` |
| disagreement-governed | healthy | `fb088f9a53deb0d194d89badd6cb71c9b83cfdea01ca5b3e4129be37f87e8f7a` |

Both the existing protocol fixture (`1.2.0`) and the health fixture reproduced the
same digests on Node `20.20.2`, `22.23.2`, and `24.18.0`.

## Validation evidence

- Protocol: typecheck passed; build passed; 6 files / 62 tests passed.
- All eight npm workspaces: typecheck passed and build passed.
- Full Node 20 workspace suite: 87 test files; 921 Vitest tests passed, 3 skipped;
  3 additional Desktop release-control tests passed.
- Durable-v1 freeze: passed at contract SHA-256
  `fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b`,
  covering 64 artifacts and 3 accepted transitions; both freeze harness tests passed.
- V1 import boundary: no CLI, MCP, ID, Space, Observer, Bench, Desktop, or package
  source imports `@seedrop/protocol`.
- Identity reconciliation: sanitized and live read-only modes both observed 9
  passports, 29 links, 24 unique roots, 9 canonical Principals, 23 canonical
  Projects, and 0 unresolved project sources.
- Package dry-run: 48 entries; health declarations, JavaScript, source, fixture, and
  verifier are included; packed size 58,153 bytes, unpacked size 299,245 bytes.
- `git diff --check`: passed.

## Exit assessment

VI-01 and VI-04 are satisfied at the v2 protocol boundary: every required state has
an executable golden case; disagreement is preserved with an auditable policy trace;
and malformed, mismatched, future-dated, or tampered evidence fails closed. No v1
durable schema or adapter behavior changed.

The next dependency-ready slice is VI-03 / VI-06 / VI-08: command audit, crash
recovery, sweep policy, and repair Receipts. `PendingCommandHealth` intentionally
reports command state without pre-empting that slice's write authority.
