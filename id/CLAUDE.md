# Seedrop ID Session Start

Read `AGENTS.md` first. This repo owns Seed identity and passport persistence.

Passport defaults to `~/.seedrop/id/passport.json` (override with `$SEEDROP_PASSPORT`). One passport per agent, machine-wide. Per-repo passports are an anti-pattern — `active_projects` is the cross-repo index.

Start with:

```bash
seed id repair    # repair any pending commit journal
seed id validate  # schema check
seed id show      # name, agent_id, sessions, active_projects count
```
