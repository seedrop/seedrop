# Seedrop Session Start

Read `AGENTS.md` first. Seedrop uses a persistent-identity model: one passport per agent, per-repo View, one always-on Space daemon.

Minimum boot:

```bash
# First time on this machine only:
seed bootstrap --name claude --purpose "Build Seedrop"
seed daemon install

# Every session in a new repo:
seed bootstrap         # idempotent; re-links cwd
seed id show
seed view context
```

Defaults: passport is `~/.seedrop/id/passport.json`; space daemon is on `http://127.0.0.1:18791`; per-repo orientation lives in `<repo>/.seedrop/view/`.
