# Wave 2 PR-01 proof — protocol completeness and generated schema prototype

- **Date:** 2026-08-11
- **Task:** `959421c5-5986-4193-b932-4f04b7f02b30`
- **Run:** `31dc3bd8-e16f-404e-b3f1-3a3430927db5`
- **Decision:** ADR 0012
- **Scope:** v2 protocol inventory and generated evidence only; no v1 writer, kernel,
  cutover, Desktop release, or `seedrop_db` integration

## Delivered contract

One executable inventory now accounts for:

- all nine public nouns, with `implemented`, `partial`, or `declared` status;
- 15 intentional top-level protocol surfaces and their version/builder/validator
  links;
- Intent, Episode, Lease, and command lifecycle transitions;
- five orthogonal trust axes;
- all canonical ID kinds, version axes/current versions, and registered errors;
- the current proposal-only event type and deliberately open event/command
  registries;
- nine explicit missing boundaries, including native Intent, Episode, Claim,
  Receipt, Lease, Event, and Situation roots.

The generator combines that runtime inventory with the actual `src/index.ts` export
boundary and registered interface declarations. At this revision it enumerates 90
public value exports and 111 public type exports. It emits four contract artifacts
plus a golden fixture:

- machine-readable protocol catalog;
- JSON Schema 2020-12 top-level shape prototype;
- TypeScript bindings;
- human completeness report;
- counts and SHA-256 digests covering all generated artifact bytes.

The schema refuses unknown top-level fields and freezes required fields and exact
version constants where present. It intentionally does not guess nested named
types; runtime builders remain the semantic authority.

## Drift proof

`npm run check:artifacts -w @seedrop/protocol` rebuilt every artifact in memory and
exact-compared all five committed files: passed.

`node protocol/scripts/verify-protocol-generation.mjs` additionally verified the
four SHA-256 digests, runtime/catalog identity, nine-noun coverage, nonempty explicit
gaps, and every registered surface's public type, version, builder, and validator
symbol: passed.

The same verifier is part of `verify-runtime-goldens.mjs`, package prepublication,
and the workspace CI build path. The generated bindings independently typechecked
under NodeNext/ES2022.

## Validation evidence

- Protocol typecheck, build, artifact check, focused verifier, and focused suite:
  passed; 10 test files and 101 tests.
- Aggregate protocol golden suite: passed on Node 20.20.2, 22.23.2, and 24.19.0
  with identical base, health, command-recovery, observability, and generation
  vectors.
- All eight npm workspaces: build passed.
- Full Node 20 workspace suite: 91 Vitest files; 960 tests passed, 3 skipped; 3
  additional Desktop release-control tests passed.
- Durable-v1 freeze: passed at contract SHA-256
  `fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b`,
  covering 64 artifacts and 3 accepted transitions; both freeze harness tests
  passed.
- V1 import boundary: no CLI, MCP, ID, Space, Observer, Bench, Desktop, or other
  non-protocol source imports `@seedrop/protocol`.
- Identity reconciliation: sanitized and live read-only modes both observed 9
  passports, 29 links, 24 unique roots, 9 canonical Principals, 23 canonical
  Projects, and 0 unresolved project sources.
- Package dry-run: 80 entries; generated catalog, schema, bindings, report, fixture,
  generator, focused verifier, source, JavaScript, and declarations are included;
  packed size 131,085 bytes and unpacked size 744,585 bytes.
- Dependency audit: initially exposed newly published transitive advisories against
  the lockfile. Patch-compatible lock updates moved Hono to 4.13.1, ip-address to
  10.5.0, and nanoid to 3.3.18; `npm audit --audit-level=low` then passed with zero
  vulnerabilities.
- `git diff --check`: passed.

Desktop signed/notarized release verification was not asserted. Desktop remains a
developer preview under repository policy.

## Exit assessment

PR-01 satisfies its exit condition: docs, schema prototype, bindings, public export
inventory, and golden bytes cannot drift independently, and every frozen public noun
or known missing durable root is explicitly accounted.

This does not claim that the v2 native kernel exists. The command and event
registries remain openly incomplete by contract. PR-02 can now consume the generated
lifecycle and trust-axis tables to prove state-space independence, transition
closure, and forbidden implication properties without scraping ADR prose.

The `seedrop_db` experiment remains outside the main trajectory until its separate,
preregistered black-on-white proof demonstrates approximately 10x end-to-end
Seedrop product value.
