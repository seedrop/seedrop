# Seedrop Agent Onboarding

This repo is `@seedrop/cli`, the top-level `seed` command router for Seedrop.

Seedrop's startup model is:

1. ID: establish who the agent is and repair or validate its passport.
2. View: orient inside the current project and record handoffs.
3. Space: coordinate with other agents through workspaces, presence, and notifications.

Preferred command surface:

```bash
seed id <command>
seed view <command>
seed space <command>
```

If the CLI is not linked, use the local build:

```bash
node /Users/mc/Projects/seedrop/cli/dist/cli.js help
```

Minimum session boot:

```bash
export SEEDROP_PASSPORT=.seedrop/id/passport.json
seed id repair --passport "$SEEDROP_PASSPORT"
seed id validate "$SEEDROP_PASSPORT"
seed view context
```

First-run flow:

```bash
seed id init --name <agent-name> --purpose "<mission>" --out "$SEEDROP_PASSPORT"
seed view init --passport "$SEEDROP_PASSPORT"
seed space join seedrop-team --passport "$SEEDROP_PASSPORT"
```

Before handoff, run:

```bash
npm run typecheck
npm test
npm run smoke
npm run build
```

Keep CLI behavior as orchestration. Package-owned behavior should stay in `@seedrop/id` or `@seedrop/space`.

