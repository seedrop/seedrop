# Wave 2 TR-05/TR-06 proof — canonical Principal and Project identity

- **Date:** 2026-08-09
- **Task:** `306af819-4dc7-4a8e-8171-b253ec564b97`
- **Run:** `a8847f2b-daf0-4eeb-8316-2284b38dc048`
- **Decision:** [ADR 0008](../adr/0008-v2-canonical-principal-project-identity.md)
- **Implementation:** `@seedrop/protocol@0.1.0-alpha.1`
- **Cutover:** none; v1 passports, Views, and Space remain authoritative

## Requirement evidence

| Requirement | Authoritative evidence | Result |
| --- | --- | --- |
| Canonical Principal IDs | `PrincipalRegistry` accepts only full `sd_prn_<uuidv7>` targets; every candidate receives or explicitly reuses one canonical ID | Passed |
| Versioned Principal aliases | Typed namespace, normalized value, source reference, introduced revision, optional retired revision; retirement behavior is tested | Passed |
| Resolve before authorization/persistence | `resolveCommandIdentities` returns only registered full Principal/Project IDs; unknown and ambiguous aliases throw stable typed errors | Passed |
| Ambiguity default-denies | two Principals with the same normalized display name remain two records, emit a diagnostic, and fail `identity_alias_ambiguous` | Passed |
| No silent Principal merge | matching aliases never merge; only the same pre-existing full canonical binding joins sources | Passed |
| Canonical Project IDs | `ProjectRegistry` accepts only full `sd_prj_<uuidv7>` targets and maps every resolved source exactly once | Passed |
| Versioned aliases and placements | legacy-ID/Git-remote aliases plus repository/worktree/folder placements retain provenance and revision windows | Passed |
| Repository identity wins | normalized equal origin joins clones; shared Git common directory joins worktrees; exact path joins repeat observations | Passed |
| Worktrees are placements | synthetic clone/worktree fixture yields one Project with two typed placements | Passed |
| Legacy project labels do not merge | equal normalized legacy IDs at different roots remain distinct Projects; alias resolution fails closed | Passed |
| Conflicts are manual work | a shared placement with disagreeing origin identities yields zero resolved Projects for that component and two explicit unresolved sources | Passed |
| Machine corpus reconciles | committed sanitized fixture and live read-only scan both produce 9 Principals and 23 Projects from all 9 passports/29 links/24 roots, with zero unresolved | Passed |
| No v2 write cutover | no v1 consumer imports `@seedrop/protocol`; durable-v1 contract hash remains unchanged | Passed |

## Machine corpus receipt

The fixture at `protocol/fixtures/machine-identity-corpus.json` contains only identity
aliases, rebased paths, legacy project labels, and public/non-credential Git origins.
It excludes passport commitments, credential references, continuity prose, messages,
and other unrelated state.

```text
mode=sanitized-fixture
passports=9
project_links=29
unique_roots=24
canonical_principals=9
canonical_projects=23
unresolved_project_sources=0
```

The built-output verifier returned the same counts in `--live` mode by reading the
current v1 passports and Git metadata without writing them. The 24 roots become 23
Projects because `outer` and `outer_v2` have different placements but the same
normalized origin. Repeated `seedrop`, `outer-agent`, `outer_v2`, `space`, and `Roost`
links join through exact placement/repository evidence. Missing roots remain explicit,
separate folder placements; no evidence is invented.

## Validation receipts

### Protocol contract

```text
npm run typecheck -w @seedrop/protocol
npm test -w @seedrop/protocol
npm run build -w @seedrop/protocol
```

Result: 5 files and 42 tests passed; typecheck and build passed.

### Golden and corpus parity

```text
node protocol/scripts/verify-golden.mjs
npx -y node@20 protocol/scripts/verify-golden.mjs
npx -y node@22 protocol/scripts/verify-golden.mjs

node protocol/scripts/verify-identity-corpus.mjs
npx -y node@20 protocol/scripts/verify-identity-corpus.mjs
npx -y node@22 protocol/scripts/verify-identity-corpus.mjs
node protocol/scripts/verify-identity-corpus.mjs --live
```

Result: golden fixture `1.1.0` and the sanitized identity corpus matched on Node
`20.20.2`, `22.23.2`, and `24.18.0`. The live read-only corpus matched under Node 24.

### Whole workspace

```text
npm run typecheck --workspaces --if-present
npm run build --workspaces
npx -y node@20 /Users/mc/.nvm/versions/node/v24.18.0/lib/node_modules/npm/bin/npm-cli.js test --workspaces
```

Result: all eight workspace typechecks/builds passed; 904 tests passed and three
pre-existing ID tests were skipped. The supported Node 20 runtime matches the local
`better-sqlite3` ABI and passed all 398 Space tests.

### Compatibility and packaging

```text
npm run check:durable-v1
npm run test:durable-v1-freeze
npm pack -w @seedrop/protocol --dry-run --json
test -z "$(rg -l '@seedrop/protocol' id space cli mcp observer bench desktop || true)"
git diff --check
```

Result: durable-v1 hash
`fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b`
remains unchanged across 64 artifacts and three accepted transitions; both freeze
tests passed. The 41-entry, 40,265-byte dry-run package includes the identity source,
types, fixture, and standalone verifier. No v1 package imports the prototype.

## Conclusion

TR-05/TR-06 exit criteria are satisfied in the current tree. Principal and Project
identity are canonical, revisioned, provenance-carrying, and fail closed under
ambiguity. All current machine passports and project roots reconcile without silent
merges, while v1 remains byte-authoritative. The next dependency unblocked by this
slice is VI-01/VI-04: HealthEnvelope, provenance, watermarks, and disagreement.
