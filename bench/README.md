# Seedrop Bench

Seedrop Bench is the local workbench for project, View, and agent state across this machine.

Bench is intentionally local and observer-first: it turns passport `active_projects`, repo View context, and daemon inbox state into the project groups a Codex-style workbench can render.

V0 is observer-first. It can surface evidence and suggested commands, but it does not mutate Seedrop state.

## Launch

```bash
seed-bench --open
seed bench --open
```

Both commands start a loopback HTTP server and print the localhost URL. The default port is `18792`; use `--port 0` for an ephemeral port.
