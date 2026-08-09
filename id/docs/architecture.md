# Seedrop ID Architecture

`@seedrop/id` is the portable agent self-state layer.

It lets an agent load one durable identity file and answer:

- Who am I?
- What am I for?
- What commitments and limits must I preserve?
- What projects am I attached to?
- What am I currently focused on?
- What tools and capabilities do I have?
- Where are credentials available by reference?
- What continuity do I need to resume work?
- What changed about my identity over time?

Embeddings and semantic coherence are optional diagnostics. They are not the center of the package.

## Boundary

`id` owns agent self-state.

It does not own project state, coordination rooms, live presence, notifications, or file manifests.

| Question | Owner |
|---|---|
| Who is this agent? | `@seedrop/id` |
| Where is the team coordinating? | `@seedrop/space` |
| What is the state of this repo/project? | `@seedrop/space/view` |

## Passport Contents

A passport should contain durable self-state:

- identity: `agent_id`, `name`, `purpose`
- commitments: `core_commitments`, `value_anchors`, `limits`
- capabilities: `competencies`
- experience: `learned_blocks`
- current work: `active_projects`
- operational references: `credential_refs`
- resume state: `continuity`
- audit metadata: `metadata`

## Credential References

Passports must not store raw secrets.

They may store references to where credentials can be found:

```json
{ "name": "github", "kind": "env", "ref": "env:GITHUB_TOKEN", "scope": "repo" }
```

Other possible reference kinds:

- `keychain`
- `onepassword`
- `file`
- `other`

The reference says where to look. It does not grant authority by itself.

## Project References

`active_projects` points to project terrain without duplicating it:

```json
{
  "id": "seedrop-space",
  "root": "/Users/mc/Projects/seedrop/space",
  "role": "implementation and review",
  "current_focus": "Alpha readiness sweep",
  "space": "seedrop-team",
  "view": ".seedrop/view"
}
```

The project details live in `view`. The coordination history lives in `space`. The passport only records that this agent is attached to that work.

## Startup Flow

An agent should be able to resume with this sequence:

1. Load `id`.
2. Identify active projects and current focus.
3. Load the selected project `view`.
4. Join the relevant `space`.
5. Continue from continuity, claims, and handoff state.

This avoids rereading the PRD and rediscovering the repo from zero on every session.

## Audited Writes And Repair

Passport writes are explicit. `commitSession()` defaults to dry-run and only touches disk with `write: true`.

The write path has three durable artifacts and one ephemeral cross-process lock:

- `passport.json` — current identity state
- `passport.json.audit.jsonl` — append-only history of committed changes
- `passport.json.commit.json` — short-lived repair journal for an in-flight commit
- `passport.json.lock` — canonical-path lock owned by one live writer

Before a mutation, the transaction resolves the passport's real path so symlink aliases share the same lock, journal, and default audit file. Under that lock it verifies:

- the current passport matches the caller's expected hash (`absent` for creation)
- the audit tip matches the current passport when an audit exists
- a reused command ID describes exactly the same before/after hashes

The command ID remains durable in the audit note after the short-lived journal is cleared. This gives callers an idempotency key without changing the frozen v1 passport or audit schema.

The commit journal records the intended audit entry and target passport state before the audit/passport files are changed. If the process crashes after the journal is durable, `repairPendingCommit()` can safely finish the missing side:

- audit missing, passport old: append audit and write passport
- audit present, passport old: write passport without duplicating audit
- audit missing, passport new: append audit
- both present: clear the stale journal
- either file moved on independently: return `conflict` and leave the journal for operator review

Malformed audit JSON and broken `prev_hash` chains fail closed. This is not a distributed transaction. It is a small, inspectable recovery protocol for local files, with compare-and-swap and command-level idempotency for concurrent local processes.

The package-local CLI exposes this as:

```bash
seed-id status --passport ./passport.json
seed-id repair --passport ./passport.json
```

The future top-level `seed` CLI should wrap these as `seed id status` and `seed id repair`.

## Verification

The readiness gate is:

```bash
npm run typecheck
npm test
npm run build && npm pack --dry-run
node dist/cli.js --help
```

## Coherence

Coherence checks are useful, but they should be layered:

1. deterministic schema and commitment checks
2. explicit audit trail and repairable write journal for identity writes
3. rule-based warnings for obvious contradictions
4. optional embedding-backed semantic drift

The default package path must work without Ollama, local embedding models, or network access.

## Design Guardrail

`id` is not a memory database and not an agent brain.

It is the agent's portable self-state.
