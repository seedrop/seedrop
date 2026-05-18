// seedrop_manual — a single agent-shaped cheat sheet returning the mental
// model + workflows + state queries + anti-patterns. Designed to be loaded
// once per session and cached. Stable shape; safe for agents to cite verbatim.
//
// Why this exists: every new agent has to discover seedrop through trial
// and error today. Each iteration costs tokens. Loading the manual once
// is order-of-magnitude cheaper than trying-by-doing.

export type ManualSection = "all" | "concepts" | "workflows" | "state" | "anti-patterns";

export function seedropManual(section: ManualSection = "all"): string {
  const blocks: Record<Exclude<ManualSection, "all">, string> = {
    concepts: CONCEPTS,
    workflows: WORKFLOWS,
    state: STATE_QUERIES,
    "anti-patterns": ANTI_PATTERNS,
  };
  if (section !== "all") return blocks[section].trim() + "\n";
  return [PREAMBLE, blocks.concepts, blocks.workflows, blocks.state, blocks["anti-patterns"], FOOTER]
    .map((b) => b.trim())
    .join("\n\n") + "\n";
}

const PREAMBLE = `# seedrop manual

Local-first orientation layer for agent-driven repos. macOS + Node 20+; MCP
for agent clients; one always-on daemon at \`http://127.0.0.1:18791\`.

This document is the single source of truth for *how to use seedrop*. It is
designed to be loaded once per session and cached. Call \`seedrop_manual\`
(MCP) or \`seed manual\` (CLI) to retrieve.

If anything below conflicts with what \`seed view explain\` reports, trust
\`seed view explain\` — the manual is documentation, the explain commands
are derivations from live state.`;

const CONCEPTS = `## Concepts (the 4 primitives, the 5 layers)

**4 primitives** (each has its own storage location and lifecycle):

| Primitive | Where it lives           | One per…        | Purpose                                      |
|-----------|--------------------------|-----------------|----------------------------------------------|
| Passport  | \`~/.seedrop/id/\`         | agent, machine  | Identity + active_projects + issued_by chain |
| View      | \`<repo>/.seedrop/view/\`  | repo            | Orientation + checked-in coordination state  |
| Space     | \`~/.seedrop/space/\`      | daemon, machine | Async chat + presence + mentions             |
| Run       | \`view/runs/<id>.json\`    | session         | An agent's active episode of work            |

**5 layers** (each maps to a distinct failure mode if absent):

1. **Space messages** — async discussion, real-time-ish.
2. **Knowledge** (\`view/knowledge/*.md\`) — durable rationale, designs, sprints.
3. **Tasks** (\`view/tasks/*.json\`) — queryable, claimable units of work.
4. **Runs** (\`view/runs/*.json\`) — execution episodes with validation evidence.
5. **Handoffs** (\`view/handoffs/*.json\`) — structured relays between agents.

Discussion → knowledge → tasks → runs → handoffs. Tasks reference knowledge
via \`from_knowledge\`; runs reference tasks via \`--task\`. The chain is
deliberate.`;

const WORKFLOWS = `## Common workflows

### Orient yourself on session start

\`\`\`
seed continuity                # boot block: identity, view state, next move
seed view explain success       # why view is at L1/L2/L3/L4 with ✓/✗ per criterion
seed inbox --unacked-only       # @-mentions you haven't acted on
\`\`\`

### Create a sprint and derive tasks from it

\`\`\`
# 1. Write the planning doc:
echo "# Sprint 2026-06: auth refactor" > .seedrop/view/knowledge/sprint-2026-06.md
# (edit it: list goals, sketch tasks, capture rationale)

# 2. Derive tasks, each linked back to the sprint doc:
seed task create \\
  --title "Move session tokens to typed storage" \\
  --from-knowledge knowledge/sprint-2026-06.md#tokens \\
  --description "..."

seed task create \\
  --title "Add rate limit middleware" \\
  --from-knowledge knowledge/sprint-2026-06.md#rate-limit \\
  --blocked-by <token-task-id>

# 3. Claim and start:
seed task claim <task-id>
seed task start <task-id>      # auto-opens a run linked to this task
\`\`\`

### Do work and finish a run cleanly

\`\`\`
# After starting (above) or via:
seed run start --goal "X" --claim path/to/file.ts,other.ts

# Log progress (auto-relativizes paths):
seed run log --summary "did Y" --changed-path src/foo.ts

# Verify:
seed run verify --command "npm test -ws" --status passed

# Commit the work BEFORE finishing — the gate refuses dirty completes:
git add -A && git commit -m "..."

# Finish:
seed run finish --status completed
# Auto-syncs the manifest. If the run had non-trivial activity and no
# packet was written since started, suggests \`seed view log ...\`.
\`\`\`

### Done with a task

\`\`\`
seed task done <task-id>        # refuses if blocked_by tasks are open
\`\`\`

### Handoff to another agent

\`\`\`
seed handoff create --to codex --summary "auth model done, impl is yours" \\
  --run-id <current-run-id> --risk "schema is locked once shipped"
# The handoff captures changed_paths + validation + open_threads from the run.
\`\`\`

### Coordinate via the space (talk before commits)

\`\`\`
seed space messages seedrop-team    # read recent
seed space post seedrop-team "starting work on auth.ts — @codex any objections?"
seed space presence seedrop-team    # who else is online
\`\`\`

### Add a new agent identity to the daemon

\`\`\`
seed bootstrap --as <agent> --name "<name>" --purpose "<mission>"
# Daemon auto-discovers it via fs.watch on ~/.seedrop/id/agents/.
# No daemon restart needed.
\`\`\``;

const STATE_QUERIES = `## Where to look for what

| Question                             | Command                                           |
|--------------------------------------|---------------------------------------------------|
| Who am I and where am I?             | \`seed continuity\`                                 |
| What's the current sprint/focus?     | \`seed continuity\` (focus line) + \`knowledge/*.md\` |
| What's my active task / run?         | \`seed continuity\` (your tasks + current run)      |
| What are other agents doing?         | \`seed continuity\` (other agents section)          |
| Is the view actually useful?         | \`seed view explain success\`                       |
| Why is file X not in the boot block? | \`seed view explain <path>\`                        |
| What changed since I was last here?  | \`seed diff --since last-session\`                  |
| Daemon health / online agents        | \`seed daemon status\` or \`http://127.0.0.1:18791/status\` |
| Unacked @-mentions to me             | \`seed inbox --unacked-only\`                       |
| All my tasks                          | \`seed task list\`                                  |
| Tasks derived from a doc             | \`seed task list --from-knowledge <path>\`          |
| Open tasks across all agents         | \`seed task list --status open\`                    |`;

const ANTI_PATTERNS = `## Anti-patterns (do not)

- **Do not** call \`seed run finish --status completed\` while the tree is dirty.
  The gate refuses. If you mean "I'm pausing this," use \`--status blocked\`.

- **Do not** edit files without an active run AND without committing. The
  next session's boot block will show \`git: N uncommitted (...)\` but no
  run context — the work becomes mystery state.

- **Do not** pass absolute paths to \`--changed-path\` or \`--claim\`. The CLI
  relativizes them now, but it's still cheaper to pass relative paths.

- **Do not** treat tasks as a sprint board. Tasks have one status enum
  (open|claimed|in_progress|blocked|done|dropped) and no priorities, due
  dates, labels, estimates. If you need that, put it in the linked
  knowledge doc.

- **Do not** create new \`seedrop_*\` MCP tools without a use case driver.
  The 23-tool surface is already on the edge of agent-discoverable.

- **Do not** edit \`~/.seedrop/id/agents/\` passport JSON manually. Use
  \`seed bootstrap --as <agent>\` so the schema validates.

- **Do not** trust the manual over \`seed view explain\` when they disagree.
  Explain reads live state; the manual is documentation.`;

const FOOTER = `## Versions and stability

- Schema versions on persisted records (\`Passport\`, \`RunJournal\`, \`Task\`,
  \`ContinuityPacket\`, \`Handoff\`) are all \`"1.0"\` as of 2026-05-18.
- Field-level changes ship breaking-with-migration: every minor version
  bump that touches a schema must also ship migration code that reads the
  old shape. This is *not yet implemented* — track via task \`1b8676dc\`.
- For now: do not check in seedrop view state from a newer seedrop into a
  repo whose checked-in policy.json declares an older required_success_level.

---

If you got value out of this, the right next action is usually:

\`seed continuity\`  →  read the boot block  →  pick the *next move* it
suggests, or claim an open task from \`seed task list --status open\`.`;
