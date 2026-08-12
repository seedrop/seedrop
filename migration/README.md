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
