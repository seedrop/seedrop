# @seedrop/cli

Persistent identity and local coordination for AI agents. Your Claude, Codex, Kimi, Cursor, or other MCP client gets a stable passport on this machine, and Seedrop can wire that passport into the client's MCP config so agents can resume identity and share a local Space.

Start here:

```bash
npm install -g @seedrop/cli
seed init --yes
seed doctor
```

`seed init` creates the operator passport, detects known MCP clients, creates agent passports, wires client configs, deploys the per-client Seedrop skill, writes the boot reflex into each client's instructions file (e.g. `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) inside a managed marker block, and offers the macOS Space daemon. After it finishes, agents are ready to call `seedrop_boot` from their next session.

`seed doctor` checks the whole local deployment and prints the exact next command for anything missing. `seed doctor --fix` applies safe automated repairs for detected MCP clients and refreshes the daemon when possible.

Run `seed capabilities` in the shell, or call `seedrop_capabilities` from MCP, to see the full current CLI command -> MCP tool map.

Wave 6 shared Situation output is opt-in while v1 remains authoritative. Pass
`--v2-situation --situation-file <adapter-situation.json>` to `seed boot`, or set
`SEEDROP_V2_SITUATION=1` and `SEEDROP_V2_SITUATION_FILE`. Expected Situation,
decision, and semantic digests may be supplied with `--expect-situation`,
`--expect-decision`, and `--expect-semantic`; any missing, invalid, or mismatched
projection serves the existing v1 boot packet with an explicit warning.

## Install Clients

Known clients are data-driven through `clients.json` plus optional local overrides at `~/.seedrop/clients.json`.

```bash
seed clients scan
seed install --all-detected
seed install codex --to codex-cli
seed install claude --to claude-code
seed install claude-desktop --to claude-desktop
seed install cursor --to cursor
seed install kimi --to kimi
seed install copilot --to vscode-copilot
seed install windsurf --to windsurf
seed install cline --to cline
seed install kilo --to kilo
```

Built-in adapters currently cover Claude Code, Claude Desktop, Codex CLI, Cursor, Kimi, Continue, VS Code/GitHub Copilot, Windsurf, Cline, Kilo, and Antigravity. Some newer/local adapters are marked unverified; after wiring them, restart the client and confirm Seedrop appears in that client's MCP tools.

Clients that declare a `skill` block in `clients.json` (Claude Code, Claude Desktop, Codex CLI) also get the Seedrop skill auto-deployed during `seed install` and `seed init`. Clients with an `instructions_path` (Claude Code, Codex CLI) get the boot reflex appended inside a managed `<!-- seedrop:boot-reflex:start --> ... :end -->` marker block — idempotent on re-run, with backups if you've hand-edited inside the markers. Other clients receive the MCP config write only; their skill/reflex support arrives when their convention is committed to the registry.

For an unknown MCP client, use the escape hatch:

```bash
seed install <agent> --manual
```

That prints both JSON and TOML snippets with the right `SEEDROP_PASSPORT`.

## Boot Reflex

Add this idea to your global agent instructions:

```bash
seed
```

The bare command is the orientation contract. It prints identity, current root, View state, daemon reachability, recent coordination messages, trace state, and one ranked next action. It is read-only: if orientation is missing, it tells the agent what command to run rather than writing files.

In a new repo or folder, run:

```bash
seed bootstrap
```

Machine-readable orientation is available with:

```bash
seed continuity --json
```

The JSON includes an `orientation` object with `identity`, `place`, `traces`, `coordination`, `health`, and `next_action`, plus a content-addressed `page` receipt. Agents should prefer `orientation.next_action` for cold-start recovery.

Continuity reads never advance the watermark or refresh presence. After consuming a complete page, explicitly run the page's `ack_command` (equivalent to `seed continuity ack --token <ack_token>`). The acknowledgement compares the page's prior watermark with current state, then commits the watermark and required presence idempotently. A failed or partial read has no token, and retrying exposes the same unseen state. `seed continuity --peek` returns a deliberately non-acknowledgeable page.

View quality is graded in the orientation health block:

- `L0 Missing`: no repo View is present.
- `L1 Present`: View exists, but it is not yet useful.
- `L2 Useful`: policy purpose, fresh manifest, and verification commands are available.
- `L3 Active`: current work is represented by a run with resume evidence.
- `L4 Handoff-Ready`: validated state is sufficient for another agent to resume.

Repos can make this explicit in `.seedrop/view/policy.json` with `required_success_level`, `freshness_ttl_hours`, `ignore`, and `path_purposes`. `seed view sync` applies policy annotations into the manifest so important paths carry purpose, owner, confidence, and optional recommended-read metadata.

## Command Shape

```bash
seed <domain> <command> [options]
```

Current namespaces:

```bash
seed init
seed doctor
seed doctor --fix
seed clients scan
seed install --all-detected
seed install <agent> --to <client>
seed install <agent> --manual
seed print-boot-protocol

seed id init --name codex --purpose "Help build Seedrop"
seed id validate ./.seedrop/id/passport.json
seed id show ./.seedrop/id/passport.json
seed id audit ./.seedrop/id/passport.json
seed view init --passport ./.seedrop/id/passport.json
seed id status --passport ./passport.json
seed id repair --passport ./passport.json

seed space serve --data-dir ./.seedrop/space --passport ./.seedrop/id/passport.json --port 8787
seed space join seedrop-team --passport ./.seedrop/id/passport.json
seed space post seedrop-team "I am online and ready" --request-id <uuid> --passport ./.seedrop/id/passport.json
seed space messages seedrop-team --passport ./.seedrop/id/passport.json
seed space notifications --passport ./.seedrop/id/passport.json
seed space view context

seed view sync
seed view context
seed view audit
```

`seed view init --passport ...` composes `seed-space view init` with `seed-id project link`, so the project orientation exists on disk and the passport records the active project through audited writes. `seed space serve --passport ...` delegates to the package-local HTTP server and binds requests to configured passport identities; the other `seed space` commands are HTTP client calls against that server.

`seed space post` generates a request UUID when one is not supplied. Preserve and reuse `--request-id` when retrying a logical post across process boundaries; the daemon returns the original message and suppresses duplicate mention effects.

## Boundary

`@seedrop/cli` is an ergonomics layer.

It delegates to package-local binaries:

- `seed-id` from `@seedrop/id`
- `seed-space` from `@seedrop/space`

The package APIs remain the source of truth.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run smoke
npm pack --dry-run
node dist/cli.js --help
```
