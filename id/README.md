# @seedrop/id

> Portable self-state for LLM agents: identity, commitments, active projects, credential references, continuity, and audited writes.

**Status:** Alpha-ready local package. The package is centered on portable self-state, audited writes, repairable local files, and CLI-first identity setup. See [docs/architecture.md](./docs/architecture.md) for the product frame.

---

## What this is

LLM agents have no durable self-state by default. Each session starts as a fresh context window that has to rediscover who the agent is, what it is responsible for, which projects it is attached to, what tools it can use, and what continuity matters.

`@seedrop/id` gives an agent a portable `passport.json` so it can resume without rereading the world.

The passport carries:

- who the agent is
- commitments, value anchors, and limits
- competencies and learned blocks
- active project references
- credential references, not raw secrets
- continuity and handoff state
- audit metadata

Coherence and embedding-backed drift checks are optional diagnostics. The core package must remain useful without a local embedding model.

## Basic API

```typescript
import { Identity } from "@seedrop/id";

const id = await Identity.fromPassport("./passport.json");

const session = id.session();

await session.record({ role: "user", content: "..." });
const messages = session.reconstruct();

await id.commitSession({ write: true });
```

Coherence and embedding-backed drift checks are optional diagnostics. Pass an embedding provider only when you want that layer:

```typescript
const session = id.session({ embeddings });
const drift = await session.coherence();
```

## Audited Writes

`commitSession()` is dry-run by default. Passing `write: true` updates the passport and appends an audit entry:

```typescript
const result = await id.commitSession({
  write: true,
  notes: "resume state updated after handoff",
});
```

Writes create a short-lived commit journal beside the passport before touching the audit log. If a process crashes mid-commit, the next startup or CLI can repair the pending write:

```typescript
await Identity.repairPendingCommit({ passportPath: "./passport.json" });
```

The repair path is idempotent: it completes missing audit/passport work when safe, clears already-finished journals, and reports `conflict` instead of guessing when the passport or audit log moved on independently.

The package-local CLI exposes the same repair path:

```bash
seed-id init --name codex --purpose "Help build Seedrop"
seed-id validate --passport ./.seedrop/id/passport.json
seed-id show --passport ./.seedrop/id/passport.json
seed-id audit --passport ./.seedrop/id/passport.json
seed-id project link --passport ./.seedrop/id/passport.json --id seedrop --root ~/Projects/your-app --view .seedrop/view
seed-id status --passport ./passport.json
seed-id repair --passport ./passport.json
```

`init` writes `.seedrop/id/passport.json` by default, accepts `--out <path>`, and refuses to overwrite an existing passport unless `--force` is passed.
`project link` upserts one `active_projects` entry through the same audited, repairable passport write path used by session commits.

`repair` exits `0` when no repair is needed or repair succeeds, `2` when the journal conflicts and needs operator review, and `1` for command/runtime errors.

A `passport.json` looks like:

```jsonc
{
  "version": "1.0",
  "agent_id": "uuid-v7-here",
  "name": "Atlas",
  "purpose": "Help engineering teams ship reliable software.",
  "core_commitments": [
    "Never recommend skipping tests",
    "Always disclose uncertainty about claims affecting production"
  ],
  "value_anchors": [
    { "name": "correctness", "priority": 1 },
    { "name": "honesty", "priority": 2 }
  ],
  "competencies": ["typescript", "code-review"],
  "limits": ["cannot deploy"],
  "learned_blocks": [],
  "active_projects": [
    {
      "id": "seedrop-space",
      "root": "~/Projects/your-app",
      "role": "implementation and review",
      "current_focus": "Alpha readiness sweep",
      "space": "seedrop-team",
      "view": ".seedrop/view"
    }
  ],
  "credential_refs": [
    {
      "name": "github",
      "kind": "env",
      "ref": "env:GITHUB_TOKEN",
      "scope": "repo"
    }
  ],
  "continuity": {
    "current_focus": "Review Seedrop id",
    "next_actions": ["Load project view", "Join seedrop-team"],
    "open_threads": ["Keep embeddings optional"]
  }
}
```

See [examples/passport.self-state.json](./examples/passport.self-state.json) for a fuller operational self-state example.

---

## Install

`@seedrop/id` is a dependency of [`@seedrop/cli`](https://www.npmjs.com/package/@seedrop/cli) — most users get it transitively via `npm install -g @seedrop/cli` and never install it directly. Install it standalone only to use the `seed-id` binary or the library on its own:

```bash
npm install @seedrop/id
```

---

## Verification

The alpha readiness gate is:

```bash
npm run typecheck
npm test
npm run build && npm pack --dry-run
node dist/cli.js --help
```

Current direction: keep embeddings optional and center the package on portable agent self-state plus audited writes.

---

## License

MIT — see [LICENSE](./LICENSE).
