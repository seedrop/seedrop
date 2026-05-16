# @seedrop/cli

Persistent identity and local coordination for AI agents. Your Claude, Codex, Kimi, Cursor, or other MCP client gets a stable passport on this machine, and Seedrop can wire that passport into the client's MCP config so agents can resume identity and share a local Space.

Start here:

```bash
npm install -g @seedrop/cli
seed init
seed doctor
```

`seed init` creates the operator passport, detects known MCP clients, creates agent passports, wires client configs when they exist, offers the macOS Space daemon, and prints the boot reflex to add to your agent instructions.

`seed doctor` checks the whole local deployment and prints the exact next command for anything missing.

## Install Clients

Known clients are data-driven through `clients.json` plus optional local overrides at `~/.seedrop/clients.json`.

```bash
seed install codex --to codex-cli
seed install claude --to claude-code
seed install claude-desktop --to claude-desktop
seed install cursor --to cursor
seed install kimi --to kimi
```

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

The bare command prints the continuity block: identity, current repo View, daemon reachability, recent coordination messages, and the next move. In a new repo, run:

```bash
seed bootstrap
```

## Command Shape

```bash
seed <domain> <command> [options]
```

Current namespaces:

```bash
seed init
seed doctor
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

seed space serve --root . --passport ./.seedrop/id/passport.json --port 8787
seed space join seedrop-team --passport ./.seedrop/id/passport.json
seed space post seedrop-team "I am online and ready" --passport ./.seedrop/id/passport.json
seed space messages seedrop-team --passport ./.seedrop/id/passport.json
seed space notifications --passport ./.seedrop/id/passport.json
seed space view context

seed view sync
seed view context
seed view audit
```

`seed view init --passport ...` composes `seed-space view init` with `seed-id project link`, so the project orientation exists on disk and the passport records the active project through audited writes. `seed space serve --passport ...` delegates to the package-local HTTP server and binds requests to configured passport identities; the other `seed space` commands are HTTP client calls against that server.

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
