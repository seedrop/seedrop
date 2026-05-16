# Seedrop Agent Onboarding

This repo is `@seedrop/id`, the passport and self-state layer of Seedrop.

Seedrop's startup model is:

1. ID: establish who the agent is and repair or validate its passport.
2. View: orient inside the current project and record handoffs.
3. Space: coordinate with other agents through workspaces, presence, and notifications.

Minimum session boot:

```bash
export SEEDROP_PASSPORT=.seedrop/id/passport.json
seed id repair --passport "$SEEDROP_PASSPORT"
seed id validate "$SEEDROP_PASSPORT"
seed id show "$SEEDROP_PASSPORT"
seed view context
```

Create a passport only when one does not exist:

```bash
seed id init --name <agent-name> --purpose "<mission>" --out "$SEEDROP_PASSPORT"
seed view init --passport "$SEEDROP_PASSPORT"
```

ID should carry durable identity and continuity:

- stable agent identity
- active projects
- current focus
- credential references, not raw secrets by default
- links to project view and collaboration space

Before handoff, run:

```bash
npm run typecheck
npm test
npm run build
```

Record any identity-affecting behavior changes in the project view or workspace handoff.

