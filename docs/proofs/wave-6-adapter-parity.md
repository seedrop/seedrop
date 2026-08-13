# Wave 6 adapter parity proof

Wave 6 removes product-policy derivation from CLI, MCP, Observer, Bench, and
Desktop. `@seedrop/situation` owns the versioned adapter envelope, including
Situation and decision identity, semantic digest, bucket, readiness, health,
normalized decision display, warnings, and the read-only mutation boundary.

`npm run verify:adapter-parity` pushes four frozen projections through every
enabled adapter:

- healthy active continuation;
- stale/degraded evidence;
- an unresolved source disagreement;
- explicit refusal with a smallest repair.

CLI, MCP, and Observer must serve byte-identical full semantic payloads. Bench
and Desktop must present the exact canonical fields from that payload while
deliberately conflicting legacy status/task fixtures are present. A fifth case
forces a decision-id mismatch and requires every binding to serve v1 with the
same `projection_mismatch` warning.

The release-blocking gate is `npm run test:wave-6-gate`. It also checks package
boundaries, generated contract freshness, all affected package tests/builds,
Desktop's read-only observer smoke, and the full parity matrix. Desktop remains
a developer preview: this proof does not replace its separate signed and
notarized `release:verify` requirement.
