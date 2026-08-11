# ADR 0012 — Generate protocol completeness artifacts from one executable inventory

- **Status:** accepted
- **Date:** 2026-08-11
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 PR-01 / task `959421c5-5986-4193-b932-4f04b7f02b30` / run `31dc3bd8-e16f-404e-b3f1-3a3430927db5`
- **Durable v1 change class:** none; additive v2 protocol package and generated artifacts only

## Context

ADRs 0006–0011 froze the v2 ontology, canonical mechanics, identity, health,
command recovery, repair, and bounded observability contracts. They did not yet
provide one machine-readable answer to these questions:

- which public nouns are implemented, partial, or only declared;
- which lifecycle edges, trust axes, IDs, versions, errors, events, commands, and
  top-level data surfaces are part of the current contract;
- which future kernel boundaries remain intentionally open;
- whether exported TypeScript, generated bindings, JSON Schema, human docs, and
  golden bytes still describe the same protocol.

Hand-maintained copies would let those surfaces drift. Generating speculative full
schemas for Intent, Episode, Claim, Receipt, Lease, Event, or Situation would be
worse: it would turn planned ontology into an accidental storage contract before
the native kernel exists.

## Decision

`protocol/src/inventory.ts` is the executable completeness inventory for the v2
protocol prototype. It composes existing runtime registries and constants rather
than copying them:

- the nine nouns and their implementation status;
- Intent, Episode, Lease, and command lifecycle state/transition tables;
- evidence, delivery, substrate, readiness, and confidence axes;
- canonical ID kinds, version axes/current versions, and registered errors;
- registered event proposals and the deliberately open event/command registries;
- implemented top-level public surfaces and their source, role, noun, version,
  builder, and validator linkage;
- a typed list of every known missing native boundary.

The existing command transition table is now a public protocol constant so runtime
validation, generated documentation, and later state-model tests consume identical
edges.

`protocol/scripts/generate-protocol-artifacts.mjs` combines that runtime inventory
with a deterministic parse of the package's public export boundary and registered
TypeScript interfaces. It generates:

1. `protocol-catalog.json`, the complete machine-readable inventory and export map;
2. `protocol-surface-shapes.schema.json`, a JSON Schema 2020-12 prototype for exact
   top-level fields;
3. `protocol-bindings.ts`, generated ontology, lifecycle, trust, event, error,
   version, and surface-field bindings;
4. `PROTOCOL-CATALOG.md`, the human-readable completeness report;
5. `protocol-generation-v1.json`, counts and SHA-256 golden digests for all four
   generated contract artifacts.

Generation uses the built public package plus source declarations and only Node's
standard library. `--check` regenerates in memory and exact-compares every committed
artifact. CI runs the check after workspace build, the aggregate runtime verifier
runs it on each supported Node major, and package publication fails on drift.

The JSON Schema is intentionally scoped to top-level public shapes. It freezes
field names, requiredness, obvious primitive types, exact version constants, and
unknown-field denial. Existing runtime builders remain authoritative for nested
shape, identity, ordering, digest, lifecycle, authorization, and semantic
invariants. An unrecognized named TypeScript type is described but not guessed into
an incorrect JSON Schema type.

## Completeness rule

A public noun may be `implemented`, `partial`, or `declared`.

- `implemented` must name at least one registered public surface and no noun-level
  gap.
- `partial` must name the implemented surfaces and every missing boundary.
- `declared` must have an explicit gap; it cannot acquire generated storage fields.

The current inventory therefore treats Principal and Project as implemented; Claim,
Receipt, Event, and Situation as partial; and Intent, Episode, and Lease as declared.
The generic Receipt/Event/Situation roots, native command registry, and other kernel
records remain explicit gaps rather than fabricated schemas.

## Rejected alternatives

### Maintain schemas, bindings, and docs separately

Rejected. Review cannot reliably detect semantic drift across several hand-edited
representations, and a green test in one representation would not prove the others.

### Generate a schema for every planned noun now

Rejected. The ontology defines meaning and invariants, not yet the exact durable
root shapes for the native kernel. Premature schemas would create compatibility
obligations without implementation evidence.

### Treat every exported helper or input as a durable schema

Rejected. The catalog enumerates every public value and type export, while the
schema registry is restricted to intentional top-level protocol data surfaces.
Helper inputs remain visible in the export inventory without being promoted to
wire or storage records.

### Move the inventory into `seedrop_db`

Rejected for the main trajectory. The database experiment remains independent
until preregistered black-on-white evidence demonstrates approximately 10x
end-to-end Seedrop product value. PR-01 neither imports it nor chooses a storage
engine.

## Consequences

- Protocol drift is a deterministic CI failure with named artifact mismatches.
- PR-02 can consume lifecycle and trust-axis tables without scraping ADR prose.
- Future kernel work must close explicit gaps or add reviewed ones; absence cannot
  masquerade as completion.
- Generated artifacts are publishable package evidence, but they do not connect v1
  writers or authorize a v2 cutover.
- Durable v1 bytes and import boundaries remain unchanged.
