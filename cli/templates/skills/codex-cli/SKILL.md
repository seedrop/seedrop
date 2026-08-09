---
name: seedrop
description: Use when Codex needs to operate Seedrop-native continuity, View context, run journals, inbox, Spaces, handoffs, or task coordination; when working in a repo with `.seedrop/view/`; when the user asks about Seedrop, startup state, durable coordination, native Seedrop extension work, or where prior work left off.
---

# Seedrop

## Operating Rule

Use Seedrop MCP tools first. Prefer the `mcp__seedrop__` namespace over shelling out to `seed`. Use CLI commands only when the matching MCP tool is unavailable, when inspecting CLI-specific behavior, or when the user explicitly asks for CLI output.

To see the full surface at a glance, call `seedrop_capabilities` once (CLI equivalent: `seed capabilities`) and cache it — it returns the complete command → MCP-tool map (what exists, what is MCP-exposed vs CLI-only). Route tool choices from that map instead of guessing.

## Startup Reflex

At the start of Seedrop-related work, orient before editing:

1. Call `seedrop_boot` with the repo `cwd` when available.
2. Consume the returned Situation packet, then call `seedrop_continuity_ack` with `continuity_page.ack_token` when the page is complete. Boot is read-only until this explicit acknowledgement; retrying the same token is safe.
3. Call `seedrop_view_context` to read the stable repo View state.
4. Call `seedrop_view_preflight` to catch missing or stale View setup.
5. Call `seedrop_inbox` to check unacked mentions addressed to the active passport.
6. Call `seedrop_daemon_status` only if continuity, preflight, or direct HTTP/daemon evidence disagree about daemon health.

If the repo has no `.seedrop/view/`, use `seedrop_bootstrap` when linking the repo is clearly required. Otherwise report the missing View and continue with normal local context.

## Work Reflex

For meaningful work, create durable Seedrop state:

- Start or attach to a run journal with `seedrop_run_start`. Use `new: true` only when a fresh run is clearly needed; otherwise let the tool attach/open the active run.
- Use `seedrop_run_log` to record material progress and changed paths as work proceeds.
- Use `seedrop_run_verify` for each meaningful validation command, including skipped validation with a reason.
- A handoff is a task assigned to the recipient (ADR 0001): use `seedrop_run_finish` with `handoff_to`, or `seedrop_task_assign`, for unfinished work another agent must continue; the recipient sees it in their task queue.
- Use `seedrop_space_join`, `seedrop_space_messages`, `seedrop_space_presence`, `seedrop_space_register`, and `seedrop_space_post` for multi-agent coordination that should be visible in a Space.
- Finish with `seedrop_run_finish` when the run reaches `completed`, `blocked`, or `failed`.

Always log changed paths and validation evidence before finishing. If the task cannot finish cleanly, leave a continuity packet with `seedrop_view_log` including the mission, summary, changed paths, validation status, decisions, assumptions, and open threads.

## Native Extension Guidance

When building Seedrop-native extensions, keep the integration surface Seedrop-first:

- Prefer MCP affordances and structured JSON outputs over parsing CLI text.
- Keep extension behavior grounded in Seedrop concepts: passport identity, repo View, run journal, inbox, Space, task, and handoff.
- Use Seedrop task tools when they are exposed by MCP; otherwise use handoff artifacts and Space posts for durable coordination instead of transient chat notes.
- If a CLI path is required, verify the corresponding MCP behavior too, or explain why MCP coverage is missing.

## Completion Checklist

Before final response:

- Confirm the active run was logged or explain why no run was appropriate.
- Confirm changed paths were recorded when files changed.
- Confirm validation was recorded with command and status.
- Finish the run or leave a continuity packet/handoff for unfinished work.
- Mention any daemon, View, inbox, or migration caveats that remain actionable.
