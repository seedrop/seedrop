# @seedrop/migration

`@seedrop/migration` is the Seedrop v2 shadow-import boundary. It may read frozen v1
sources, bind them to an independently verified snapshot, stage canonical Project
records, and emit reconciliation receipts. It has no v1 write authority.

Wave 4 ends at `verified_not_authorized_for_cutover`. The package deliberately has no
cutover state or cutover receipt. V1 remains authoritative, and the separate
`seedrop_db` experiment is not a dependency or storage path.

The package depends inward on `@seedrop/protocol` and `@seedrop/project`. Its explicit
v1 adapters validate passport bytes through `@seedrop/id` and View artifacts through
the frozen public schemas at `@seedrop/space/view`. Adapters and v1 packages must not
import it while it remains shadow-only.

Wave 4 identity import validates v1 passport bytes through `@seedrop/id`, then emits
deterministic protocol Principal and Project registries. The reviewed frozen corpus and
the current live read-only corpus can be checked separately:

```bash
npm run verify:identity-import -w @seedrop/migration
npm run verify:identity-import:live -w @seedrop/migration
```

The live verifier hashes the complete identity tree before and after collection. Live
drift is reported and never updates the frozen baseline.

Wave 4 View-history import reads the frozen v1 View families, emits one deterministic
shadow Project transaction per logical source record, and accounts for every record as
imported, quarantined, or unresolved. ContinuityPackets remain unresolved unless an
explicit future correction supplies a Run identity; the importer never guesses from
timestamps or text. Optional outcome-layer reports contribute observer/time/input/Git
HEAD delivery evidence without promoting Run completion to delivery.

```bash
npm run verify:view-history-import:live -w @seedrop/migration
```

The live verifier hashes the complete View tree before and after two imports and
requires byte-identical output for the same admitted source report.

Wave 4 machine-coordination reconciliation remains outside Project truth. It reads
durable Space membership/messages/mentions/notifications and outbox state as authority,
evaluates live sessions only as a TTL projection at an explicit snapshot timestamp,
classifies session files as client caches, and retains root-migration manifests as
physical evidence. Unknown SQLite tables and malformed records are quarantined rather
than dropped; broken identity or durable references remain explicitly unresolved.

The collector never calls the daemon API and verifies the selected physical corpus did
not change during collection. The live SQLite shared-memory lock map is excluded because
a reader may update it and it is not durable state; the database and write-ahead log are
hashed, while historical shared-memory copies remain covered by migration receipts.

```bash
npm run verify:coordination-import:live -w @seedrop/migration
```

The result is a machine-owned reconciliation receipt and timestamp-bound projections.
It contains no Project ID, Project event, Project transaction, or cutover authority.

The production corpus gate composes identity, every meaningful non-probe View, and
machine coordination into one deterministic read-only proof. It requires the expected
17 meaningful Views to remain discoverable from machine identity, imports the 16
product Views, and records `seedrop_db` exactly once as excluded experiment evidence.
The receipt reconciles hashes, physical and logical counts, imported field coverage,
diagnostics, identity mappings, rerun bytes, and source-tree immutability.

```bash
npm run verify:machine-corpus:live -w @seedrop/migration
```

Corpus drift is a refusal, not an automatic baseline update. The proof contains no
cutover authorization and never adds `seedrop_db` to the product dependency graph.

Wave 4 execution is restartable through `executeShadowMigration`. The executor stores
an immutable, content-addressed checkpoint journal under an operator-supplied shadow
state root. Every revision binds the admitted corpus, current receipt, per-source
cursor, stable idempotency keys, staged Project references, reconciliation counts, and
the previous checkpoint digest. Temp files are never authoritative; divergent records
for one revision are a conflict rather than a last-writer-wins update.

Source adapters receive one stable key for each migration/phase/source digest. A crash
after adapter work but before checkpoint publication can replay that key, so adapters
must use idempotent Project publication. The executor re-observes the admitted corpus
before and after stage/verification work and refuses drift. It writes only its supplied
shadow state root and has no v1 mutation, deletion, rollback-expiry, or cutover API.

```bash
npm run verify:executor -w @seedrop/migration
```

The executor fault matrix interrupts before and after every published boundary and
must always resume to `verified_not_authorized_for_cutover` with conserved counts.

The v1 compatibility surface is owned by the migration edge. It compares admitted v1
View records to their staged transaction semantics and requires each record to be
`equal`, `intentionally_transformed`, `quarantined`, or `unresolved`. The comparison
is source-digest bound, deterministic, and read-only.

Dry-run translation currently constructs only the explicit v1 `task.create` to native
`seedrop.work.open` collapse. Existing-work commands that require canonical Intent,
Episode, Lease, or Receipt identities are intentionally unsupported rather than
guessed. Drafts contain a literal `submit_capability: false`; this package has no
kernel executor dependency or submission function.

```bash
npm run verify:compatibility:live -w @seedrop/migration
```
