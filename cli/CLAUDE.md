# Seedrop CLI Session Start

Read `AGENTS.md` first. This repo owns the top-level `seed` command routing surface.

```bash
seed help
seed bootstrap --name <name> --purpose "<mission>"   # first-time machine setup
seed bootstrap                                        # idempotent re-link in new repo
seed daemon install | status | uninstall              # launchd management
seed id show
seed view context
seed space messages <space>
```

The CLI is an ergonomics layer. It composes `@seedrop/id` and `@seedrop/space` via spawned subprocesses; both are real runtime dependencies and resolve via `import.meta.resolve`.
