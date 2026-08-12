# @seedrop/migration

`@seedrop/migration` is the Seedrop v2 shadow-import boundary. It may read frozen v1
sources, bind them to an independently verified snapshot, stage canonical Project
records, and emit reconciliation receipts. It has no v1 write authority.

Wave 4 ends at `verified_not_authorized_for_cutover`. The package deliberately has no
cutover state or cutover receipt. V1 remains authoritative, and the separate
`seedrop_db` experiment is not a dependency or storage path.

The package depends inward on `@seedrop/protocol` and `@seedrop/project`. Adapters and
v1 packages must not import it while it remains shadow-only.
