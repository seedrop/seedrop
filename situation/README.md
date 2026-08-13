# `@seedrop/situation`

Seedrop v2's pure, shadow-only orientation compiler. It combines Project,
Outcomes, identity, and coordination read ports without owning or rewriting any
source truth.

Every material field carries provenance, freshness, completeness, and explicit
missing evidence. The compiler returns exactly one justified next action or an
explicit refusal with blocking unknowns, evidence requests, and the smallest safe
repair. Equal inputs produce byte-identical Situations and decision identities.

`compileBoundedSituation` converts that projection into a valid JSON envelope at
an exact caller-selected byte ceiling. It records actual bytes, candidate/index/
scan counts, event and file scale, and every omitted category. The bounded path
accepts projections and index metrics—not Event or file histories—and throws a
typed `budget_insufficient` error if even mandatory truth cannot fit.

`compileAdapterSituation` is the only Wave 6 policy surface. It derives adapter
health, bucket, warnings, semantic digest, and read-only capability from the bounded
Situation. `selectAdapterSituation` centrally applies the feature flag and serves v1
on missing or mismatched projections. CLI, MCP, Observer, Bench, and Desktop may
translate or present this envelope but may not recompute its semantics.
