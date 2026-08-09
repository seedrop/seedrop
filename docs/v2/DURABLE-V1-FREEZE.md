# Durable v1 freeze

DC-01 freezes Seedrop's durable v1 formats while v2 is constructed. The executable contract is [durable-v1-contract.json](./durable-v1-contract.json); [ADR 0002](../adr/0002-freeze-durable-v1.md) defines the boundary and exception policy.

## Check locally

```bash
npm run check:durable-v1
npm run test:durable-v1-freeze
```

The checker parses the named TypeScript authorities, normalizes the relevant declarations without comments or formatting, fingerprints every declaration, fingerprints its own extractor, and compares the result with the accepted manifest. A new field, enum value, status, schema primitive, migration chain, SQLite column, or tracked machine-state shape changes the contract and fails the gate.

## Accepted exception path

Do not update the manifest for ordinary feature work. When a durable v1 change is truly required:

1. Add a new ADR under `docs/adr/`.
2. Set `**Status:** accepted` only after the decision is actually accepted.
3. Set `**Durable v1 change class:** safety-repair` or `versioned-migration`.
4. Include a `## Decision` section that defines the change, migration/compatibility behavior, verification, and rollback.
5. Make the source change.
6. Explicitly accept the new fingerprint:

```bash
node scripts/check-durable-v1-freeze.mjs accept \
  --class safety-repair \
  --decision docs/adr/NNNN-decision.md \
  --id DC-NN
```

The command refuses proposed ADRs, class mismatches, decisions outside `docs/adr/`, unchanged contracts, and broken transition history. The resulting manifest update and ADR must be reviewed together.

`versioned-migration` does not mean “add an optional v1 field.” It requires a real version boundary and migration/compatibility evidence. The later v2 protocol ADR supersedes this freeze only when its schema and migration policy are accepted.

## DC-01 execution proof — 2026-08-08

| Evidence | Result |
| --- | --- |
| Accepted authority | ADR 0002 |
| Frozen durable declarations | 64 across identity, View, Space, daemon, and machine state |
| Contract SHA-256 | `c1dd3e7b003f7e5dde3ac5e16c3ff2485f754077ba02e602f973c894561588cf` |
| Extractor self-fingerprint | recorded in the contract manifest |
| Unversioned addition fixture | rejected with the changed declaration named |
| Proposed ADR fixture | rejected |
| ADR/change-class mismatch fixture | rejected |
| Accepted safety-repair fixture | transition chained and subsequent check passed |
| CI | gate runs on both supported Node matrix versions before build and workspace tests |
