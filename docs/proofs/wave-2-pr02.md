# Wave 2 PR-02 proof — exhaustive state-model and transition properties

- **Date:** 2026-08-11
- **Task:** `6f512716-a074-47ce-9110-187894d0f8f6`
- **Run:** `08df4391-9ac3-4b8b-98e8-eb628d2c64b8`
- **Governing decisions:** ADR 0006 and ADR 0012
- **Scope:** v2 protocol model and generated proof only; no v1 writer, native
  kernel, cutover, Desktop release, or `seedrop_db` integration

## Executable model

`protocol/src/state-model.ts` consumes the lifecycle and trust tables frozen by the
PR-01 executable inventory. It exports:

- exact lifecycle-name and state types for Intent, Episode, Lease, and command;
- `isLifecycleState`, `canLifecycleTransition`, and
  `assertLifecycleTransition`;
- a strict `buildOrthogonalTrustState` boundary for evidence, delivery, substrate,
  readiness, and confidence;
- the 14 observed state classes from ADR 0006;
- eight representative forbidden cross-axis implications.

Unknown lifecycle names or states return no permissive fallback. Assertion calls
fail with `seedrop.protocol.lifecycle_state_unknown`; known but unregistered edges
fail with `seedrop.protocol.lifecycle_transition_invalid`. Trust states require one
and only one value for every axis and reject summaries, missing axes, extra axes,
accessors, symbols, non-plain objects, and unknown values with
`seedrop.protocol.trust_state_invalid`.

The model does not infer evidence from lifecycle, delivery from evidence, readiness
from substrate, absence from unknown confidence, or any other cross-axis fact.
Versioned Situation policy may later explain a recommendation, but cannot rewrite
the five source axes.

## Generated property proof

`protocol/scripts/generate-state-model-proof.mjs` reads the generated PR-01 catalog
and the built public protocol package. It deterministically emits:

- all 152 ordered pairs across 24 lifecycle states, each marked permitted or
  rejected;
- reachability and terminal-state evidence for all four lifecycle graphs;
- all 2,700 values in the five-axis trust Cartesian product;
- all 260 value witnesses across the ten distinct pairs of trust axes;
- one concrete counterexample for each of eight forbidden implications;
- all 14 observed state classes from the machine-evidence ADR;
- a source-catalog digest and proof digest fixture.

The resulting 64,800 lifecycle-state × trust-state combinations are representable
without adding a cross-axis transition rule. They are counted rather than duplicated
in the artifact because lifecycle transition validity is independent of trust input.

Expected frozen counts:

| Property | Count |
|---|---:|
| Lifecycle models | 4 |
| Lifecycle states | 24 |
| Ordered lifecycle pairs | 152 |
| Permitted transitions | 48 |
| Rejected/implicit transitions | 104 |
| Trust tuples | 2,700 |
| Lifecycle × trust states | 64,800 |
| Pairwise trust witnesses | 260 |
| Forbidden implication counterexamples | 8 |
| Observed state classes | 14 |

`protocol/scripts/verify-state-model-proof.mjs` regenerates in memory, exact-checks
both files, verifies both SHA-256 dependencies, then replays every row through the
built public API. CI, aggregate cross-runtime goldens, and package prepublication
all run that verifier.

## Validation evidence

- Protocol typecheck, build, generated-catalog drift, state-proof drift, focused
  verifier, base golden, and focused suite: passed; 11 test files and 108 tests.
- State proof SHA-256:
  `9138dd62743eb09822065e33060fe407dae927c8011659942196ebccf3945562`.
- Base protocol fixture advanced explicitly from 1.4.0 to 1.5.0 for the three new
  registered error envelopes; existing ID, canonical bytes, versions, and migration
  vectors are unchanged.
- Aggregate protocol golden suite: passed on Node 20.20.2, 22.23.2, and 24.19.0
  with identical base, health, command-recovery, observability, protocol-generation,
  and state-model proof vectors.
- All eight npm workspaces: build passed.
- Full Node 20 workspace suite: 92 Vitest files; 967 tests passed, 3 skipped; 3
  additional Desktop release-control tests passed.
- Durable-v1 freeze: passed at contract SHA-256
  `fcc3417efeb02b91f6eba69dbcbb353d3260c08b7f26eff214a80ded2e09c35b`,
  covering 64 artifacts and 3 accepted transitions; both freeze harness tests
  passed.
- V1 import boundary: no non-protocol package source imports `@seedrop/protocol`.
- Generated TypeScript bindings independently typechecked under NodeNext/ES2022.
- Package dry-run: 89 entries; state-model source, JavaScript, declarations,
  exhaustive proof, fixture, generator, and verifier are included; packed size
  156,159 bytes and unpacked size 1,382,467 bytes.
- Dependency audit: zero vulnerabilities at `--audit-level=low`.
- `git diff --check`: passed.

Desktop signed/notarized release verification was not asserted. Desktop remains a
developer preview under repository policy.

## Exit assessment

PR-02's model-level exit condition is satisfied: every known edge and every known
rejection is executable, every trust value and pair is independently witnessed, no
forbidden implication survives its counterexample, and generated proof bytes cannot
drift from the PR-01 catalog or runtime API.

This proves the contract; it does not enable a native v2 writer. `seedrop_db` remains
outside the main trajectory until its separately preregistered approximately 10x
product-value proof exists.
