# Wave 2 TR-03/TR-04 proof — canonical protocol mechanics

- **Date:** 2026-08-09
- **Task:** `45615f83-aa07-4931-980e-43136889c607`
- **Run:** `869ffbcf-b241-4113-bd3a-0e33e9979dc2`
- **Decision:** [ADR 0007](../adr/0007-v2-canonical-protocol-mechanics.md)
- **Implementation:** `@seedrop/protocol@0.1.0-alpha.1`
- **Cutover:** none; v1 remains authoritative

## Requirement evidence

| Requirement | Authoritative evidence | Result |
| --- | --- | --- |
| Protocol-generated canonical IDs | `protocol/src/ids.ts`; frozen kind-code and deterministic UUIDv7 vector in `protocol/fixtures/golden-v2-contract.json`; ID tests for all ten kinds | Passed |
| Prefixes are input-only | `resolveCanonicalIdInput` is the only prefix API; full parser rejects noncanonical values; zero/ambiguous/short cases fail typed; no v1 consumer imports the package | Passed |
| Canonical JSON bytes | Strict encoder plus frozen text, UTF-8 hex, and SHA-256 vector; unsupported, hidden, accessor, sparse, cyclic, invalid-Unicode, and non-finite inputs fail typed | Passed |
| Golden bytes across supported Node majors | Built-output verifier returned the same ID and digest on Node `20.20.2`, `22.23.2`, and `24.18.0` | Passed |
| Stable error registry | Thirteen frozen `seedrop.protocol.*` definitions and a transport-neutral error envelope match the golden fixture and built-output verifier | Passed |
| Explicit versions | Schema `2.0.0`, semantic `2.0.0`, command/projection/wire `1.0.0`; missing/malformed, unknown historical, and forward versions are distinct typed failures | Passed |
| Ordered migration metadata | Initial production root=current plan plus a two-step executable fixture; definition rejects gaps, ambiguous edges, backward steps, duplicate/orphan metadata; every application requires current-schema validation | Passed |
| Downgrade/rollback boundary | Metadata and ADR freeze forward-only transforms; downgrade uses source snapshot restore or a version-matched compatibility reader | Passed |
| Package artifact | Dry-run tarball `@seedrop/protocol@0.1.0-alpha.1`: 34 entries, 22,190 bytes; includes both golden fixture and standalone verifier | Passed |
| No v2 write cutover | Search finds no `@seedrop/protocol` imports in id/space/cli/mcp/observer/bench/desktop; durable-v1 contract hash remains `fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b` | Passed |

## Validation receipts

### Protocol package

```text
npm run typecheck -w @seedrop/protocol
npm test -w @seedrop/protocol
npm run build -w @seedrop/protocol
```

Result: 4 test files, 29 tests passed; typecheck and build passed.

### Cross-runtime golden verifier

```text
node protocol/scripts/verify-golden.mjs
npx -y node@20 protocol/scripts/verify-golden.mjs
npx -y node@22 protocol/scripts/verify-golden.mjs
```

Result on all three majors:

```text
id     sd_int_0191416f-4495-7011-a233-445566778899
digest sha256:d607c0f3bc44925670c079130c6246e9bb05cc1462d816e3289b71b4b3dbd48f
```

### Whole workspace

```text
npm run typecheck --workspaces --if-present
npm run build --workspaces
npx -y node@20 /Users/mc/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js test --workspaces
```

Result: all eight workspace typechecks and builds passed; 891 tests passed and 3
pre-existing ID tests were skipped. The plain Node 24 test invocation was also run:
all non-Space workspaces passed, while Space failed because local `better-sqlite3` was
compiled for Node ABI 115. Running the unchanged suite under its matching supported
Node 20 runtime passed all 398 Space tests. No native dependency was rebuilt or changed.

### Compatibility and packaging

```text
npm run check:durable-v1
npm run test:durable-v1-freeze
npm pack -w @seedrop/protocol --dry-run --json
test -z "$(rg -l '@seedrop/protocol' id space cli mcp observer bench desktop || true)"
git diff --check
```

Result: durable-v1 hash unchanged across 64 artifacts and 3 accepted transitions;
both freeze tests passed; package contains fixture and verifier; isolation and diff
checks passed.

## Conclusion

TR-03/TR-04 exit criteria are satisfied in the current tree. Canonical IDs, bytes,
errors, version axes, and migration rules are executable and frozen without changing
v1 truth. The next dependency is TR-05/TR-06: canonical Principal and Project identity
contracts built on these mechanics.
