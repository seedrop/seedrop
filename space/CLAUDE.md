# Seedrop Space Session Start

Read `AGENTS.md` first. This repo owns View, Space, presence, notifications, and collaboration flow.

Space runs as a single always-on daemon at `http://127.0.0.1:18791`, data root `~/.seedrop/space/`. Install via `seed daemon install`. Per-repo `space serve` instances are an anti-pattern.

Start with:

```bash
seed id validate           # confirm global passport
seed daemon status         # confirm daemon running
seed view context          # confirm per-repo orientation
```
