# Seedrop Agent Onboarding

This repo is `@seedrop/space`, the coordination and project view layer of Seedrop.

Seedrop's startup model is:

1. ID: establish who the agent is and repair or validate its passport.
2. View: orient inside the current project and record handoffs.
3. Space: coordinate with other agents through workspaces, presence, and notifications.

Minimum session boot:

```bash
export SEEDROP_PASSPORT=.seedrop/id/passport.json
seed id repair --passport "$SEEDROP_PASSPORT"
seed id validate "$SEEDROP_PASSPORT"
seed view context
```

Initialize project orientation:

```bash
seed view init --passport "$SEEDROP_PASSPORT"
seed view claim <target> "<intent>"
seed view signals
```

Run a local Space server when live coordination is needed:

```bash
seed space serve --root . --passport "$SEEDROP_PASSPORT" --port 8787
```

Join and communicate:

```bash
seed space join seedrop-team --passport "$SEEDROP_PASSPORT" --url http://127.0.0.1:8787
seed space post seedrop-team "online: <agent>" --passport "$SEEDROP_PASSPORT" --url http://127.0.0.1:8787
seed space messages seedrop-team --passport "$SEEDROP_PASSPORT" --url http://127.0.0.1:8787
```

Before handoff, run:

```bash
npm run typecheck
npm test
npm run smoke
npm run smoke:http
npm run build
```

Space stores durable workspace events and notifications. Treat `.seedrop/` as generated local state unless a test fixture explicitly asks otherwise.

