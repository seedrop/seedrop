# Wave 6 adapter parity proof

Wave 6 removes product-policy derivation from CLI, MCP, and Observer.
`@seedrop/situation` owns the versioned adapter envelope, including Situation
and decision identity, semantic digest, bucket, readiness, health, normalized
decision display, warnings, and the read-only mutation boundary.

Desktop and Bench were local experiments and are no longer adapters in this
repo.

`npm run verify:adapter-parity` pushes four frozen projections through every
remaining adapter:

- healthy active continuation;
- stale/degraded evidence;
- an unresolved source disagreement;
- explicit refusal with a smallest repair.

CLI, MCP, and Observer must serve byte-identical full semantic payloads. A
fifth case forces a decision-id mismatch and requires every binding to serve
v1 with the same `projection_mismatch` warning.

The release-blocking gate is `npm run test:wave-6-gate`. It also checks package
boundaries, generated contract freshness, and the remaining package tests.
