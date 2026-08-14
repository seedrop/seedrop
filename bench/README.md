# Seedrop Bench

Seedrop Bench is the **power-user / developer** workbench for project, View, and agent state across this machine.

For the everyday human installer and viewer, use **Seedrop Desktop** instead (`desktop/` in this monorepo). Bench stays available for dense continuity inspection; feature work is frozen unless Desktop needs a change in the shared `@seedrop/observer` collector.

Bench is intentionally local and observer-first: it turns passport `active_projects`, repo View context, and daemon inbox state into the project groups a Codex-style workbench can render. State collection lives in `@seedrop/observer`.

V0 is observer-first. It can surface evidence and suggested commands, but it does not mutate Seedrop state.

## Launch

```bash
seed-bench --open
seed bench --open
```

Both commands start a loopback HTTP server and print the localhost URL. The default port is `18792`; use `--port 0` for an ephemeral port.
