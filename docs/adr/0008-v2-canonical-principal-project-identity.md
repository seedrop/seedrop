# ADR 0008 — Canonical Principal and Project identity contracts

- **Status:** accepted
- **Date:** 2026-08-09
- **Deciders:** mc (operator), codex (implementation)
- **Tracking:** v2 tasks `TR-05/TR-06` / `306af819`
- **Depends on:** ADR 0006, ADR 0007
- **Durable v1 change class:** none; read-only v2 reconciliation prototype

## Context

Seedrop v1 exposes identity through several locally meaningful strings. A passport has
an `agent_id` and display `name`; HTTP clients historically supplied passport IDs,
agent IDs, or names; project links have an operator-chosen `id` and a filesystem root.
The same repository can occur in several passports, clones, or worktrees. Those
strings are useful inputs but they are not durable canonical identities.

Wave 1B fixed the most dangerous current split: Space now canonicalizes admitted
passport aliases before authorization and persistence. That is a v1 safety repair,
not the v2 identity model. V2 still needs a transport-neutral contract that can:

- preserve one actor across client spellings without merging people by display name;
- preserve one Project across passports, clones, and worktrees without treating cwd
  or a legacy project label as authority;
- surface conflicts for explicit repair instead of choosing the last candidate;
- remain a shadow/read-only proof until later import and cutover gates are met.

The 2026-08-09 machine corpus contains nine valid passports, 29 active-project links,
and 24 unique recorded roots. Five repeated links point at already shared roots. Two
additional roots, `outer` and `outer_v2`, identify the same GitHub repository. Several
roots are currently absent or are non-Git folders. `seedrop_db` is represented only as
its own experimental repository placement; this decision does not add it to the v2
product trajectory or make a database part of the architecture.

## Decision

Add versioned Principal and Project identity registries to `@seedrop/protocol`. The
package remains disconnected from v1 writers and performs no I/O.

### Principal contract

A Principal registry contains:

- full canonical `sd_prn_<uuidv7>` records;
- a registry schema version and monotonically increasing revision;
- typed aliases (`passport_id`, `agent_id`, `display_name`, `client_id`);
- alias source provenance plus `introduced_revision` and optional
  `retired_revision` windows.

One imported passport creates one Principal candidate. Its passport ID, agent ID, and
display name become aliases of that candidate. Two source records merge only when an
existing canonical Principal binding explicitly names the same full Principal ID.
Matching aliases—including matching display names—never create a merge.

Alias normalization is namespace-owned and deterministic. Resolution deduplicates
multiple aliases that point to the same Principal. If an input reaches no Principal it
fails `seedrop.protocol.identity_alias_not_found`; if it reaches multiple Principals it
fails `seedrop.protocol.identity_alias_ambiguous`. The ambiguity category is
`authorization` and retryability is false: callers must repair or disambiguate rather
than retry a guessed identity.

`resolveCommandIdentities` is the adapter-neutral mutation boundary. It accepts raw
Principal and optional Project inputs and returns only registered full canonical IDs.
Authorization, event construction, persistence, idempotency, and audit code must
consume that resolved result, never the original alias. This package does not yet
connect that boundary to a v1 or v2 writer.

### Project contract

A Project registry contains:

- full canonical `sd_prj_<uuidv7>` records;
- versioned legacy-ID and normalized Git-remote aliases;
- versioned `repository`, `worktree`, and `folder` placements;
- source references for every record, alias, and placement;
- a nullable authoritative repository identity and an explicit unresolved queue.

Initial reconciliation builds evidence components using only:

1. the exact normalized real path of a placement;
2. a shared Git common-directory identity, which makes linked worktrees placements of
   the same Project;
3. a normalized origin repository identity, which joins clones of the same repository.

Repository URLs normalize common SSH/SCP/HTTPS transport spellings to host/path, strip
credentials and `.git`, lowercase known case-insensitive forge paths, and preserve
path case for unknown hosts. The stored Project identity is the normalized form, not
the credential-bearing input.

Legacy project IDs are aliases only. They can resolve an already reconciled Project,
but they never participate in the merge graph. A changed cwd never creates a Project.
A worktree is an explicit placement whose Project is selected by repository evidence.

If one evidence component contains multiple normalized origin identities, or multiple
pre-existing canonical Project bindings, the entire component is omitted from the
resolved registry and its sources enter `unresolved_source_refs`. No partial or
last-writer merge is allowed. Project alias collisions remain diagnostics and alias
resolution fails closed exactly like Principal resolution.

### Version and mutation policy

The first identity registry version is `1.0.0`; its first revision is `1`. Registry
version defines shape and semantics. Revision defines the visible alias/placement
timeline. Alias retirement closes a validity interval; history is retained rather
than overwritten. A malformed target, normalization mismatch, invalid revision
window, unregistered canonical ID, or unknown registry version fails typed.

Changing a canonical binding is a future explicit command/event with expected
revision and Receipt requirements. This slice defines read-only contract mechanics,
not registry storage, mutation authority, shadow import, or cutover.

## Corpus result

The committed fixture rebases machine paths onto `/corpus` and excludes commitments,
credentials, continuity prose, and messages. Both the fixture and a separate live,
read-only collector produce:

| Measure | Observed | Reconciled interpretation |
| --- | ---: | --- |
| Passports | 9 | 9 canonical Principal candidates |
| Active-project links | 29 | all 29 retain a source mapping |
| Unique roots | 24 | repeated passport links share placements |
| Canonical Projects | 23 | `outer` + `outer_v2` merge only by equal normalized origin |
| Unresolved project sources | 0 | no conflict was silently discarded |

Absent roots remain distinct folder placements unless their exact path is repeated.
Their lack of Git evidence is preserved; no repository identity is invented.

## Invariants

1. Full canonical IDs are the only identities returned across the mutation boundary.
2. Every accepted alias points at a registered canonical identity.
3. Alias ambiguity and unknown aliases fail before authorization or persistence.
4. Alias equality never merges Principal candidates.
5. Legacy project-ID equality never merges Project candidates.
6. Exact placement or repository evidence is required to merge Projects.
7. Worktrees are placements of a Project, never implicit Projects.
8. Conflicting repository or canonical binding evidence enters an unresolved queue.
9. Registry history is versioned and revision-windowed; retirement does not erase it.
10. Every corpus source either maps exactly once or appears explicitly unresolved.
11. This prototype performs no writes and does not change v1 authority.

## Rejected alternatives

### Use passport `agent_id` as the v2 Principal ID

Rejected. It is a mutable, client-facing alias without entity typing, global issuance,
or a safe collision story. It remains a valuable import alias.

### Merge Principals by normalized name

Rejected. Shared names are normal and would make an authentication ambiguity an
authorization escalation. Names may resolve only when the registry proves one target.

### Make the filesystem root the Project ID

Rejected. Paths move, symlinks exist, clones differ, and worktrees deliberately have
different roots. Paths are placements with provenance.

### Mint one Project for every clone or worktree

Rejected. It fragments history, claims, Leases, and outcomes for one body of work.
Repository identity wins; clone and worktree paths remain visible placements.

### Merge Projects by legacy project label

Rejected. The corpus already contains casing differences and generic labels. A label
is navigation metadata, not proof that two roots are the same repository.

### Auto-resolve repository conflicts by recency

Rejected. Recency cannot prove identity and would make a stale observation capable of
moving authority silently. Conflicts require a repair command and later Receipt.

### Persist the live reconciliation now

Rejected. Wave 2 freezes contracts. Shadow import, parity, rollback, and explicit
cutover receipts remain future gates; v1 files stay byte-authoritative.

## Consequences

Principal and Project identity now have an executable, generated-ID-compatible
boundary for later security, health, and migration work. Corpus truth demonstrates
the contract on real multi-repo evidence rather than a single synthetic example.

The result intentionally does not claim that normalized origin URL is a universal
global repository identifier. It is strong local import evidence. Once a canonical
binding exists, that binding wins; disagreement becomes reconciliation work. Future
hosted forges or distributed registries may add signed/provider-native repository IDs
through a new registry version without changing the fail-closed rules.

## Verification

Authoritative proof consists of:

- focused Principal alias, ambiguity, explicit-binding, and command-boundary tests;
- focused Project clone, worktree, legacy-name, remote-normalization, and conflict
  quarantine tests;
- `protocol/fixtures/machine-identity-corpus.json`;
- built-output verification of both the sanitized fixture and current live corpus;
- package and workspace typecheck/test/build gates;
- durable-v1 freeze verification and a search proving no v1 consumer imports the
  protocol package.
