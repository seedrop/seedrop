# Wave 7 product questions

**Frozen:** 2026-08-14  
**Governing task:** `0bd55150` (`v2:live-situation-then-two-questions`)  
**Status:** questions locked into the runner; provider spend is not authorized

Wave 7 is no longer a 24-result or 4,040-result pass/fail on a repaired harness.
It answers two product questions about the **live** Situation object that boot
serves. Packet-only is a first-class arm, not a side measurement.

A prompt that names `refuse=true` as a required output may exist as a control
arm. It is not a v2 win condition.

## Preconditions

1. `seed boot --v2-situation --json` in this repo serves `mode=v2` without
   `--situation-file`.
2. CLI and MCP return the same `situation_id` and `decision_id` for that live
   compile.
3. Compile failure or digest mismatch still serves v1.
4. Live compile finishes within 8s without spawning `outcome-layer`, and the
   full CLI boot finishes inside the MCP 15s default spawn window.
5. The benchmark `v2_situation` arm is that live object, or a sealed replay of
   it, not a brochure fixture that boot does not serve. Freeze now requires
   `compileAdapterSituation` of a bounded Situation; `packet_only` is that JSON
   without repo evidence. Re-sealed 2026-08-14 through
   `compileLiveBoundedSituation` at
   `~/.seedrop/benchmarks/pr15/wave7-2026-08-14-live-intent` (100 fixtures,
   `ready_for_model_spend: true`). The 2026-08-13-b and
   2026-08-14-live-boot corpora are not this compiler+intent seal. Gate A was
   authorized 2026-08-21 at 8 calls / 8 attempts / $1 USD.

Until those are true, no provider calls.

The runner now scores the two questions in
`id/benchmarks/resumption/pr15-wave7-questions.json` and
`id/benchmarks/resumption/wave7-questions.ts`:

- Q1 uses the **untutored** prompt on served work and compares `v2_situation`
  against `packet_only` and `current_v1`. Tutored `refuse=true` results are
  excluded.
- Q2 scores the same refused fixtures under both prompt modes. A refusal that
  appears only after tutoring is attributed to tutoring, not to v2.
- `wave7_v2_win` stays false until an operator-authorized canary supplies those
  results. The failed-attempt and 24-result repair canaries do not answer
  these questions.

## Question 1 — served replacement economics

On **served** work (the Situation decision is `recommend`, not refuse):

Does live v2 Situation beat `packet_only` and `current_v1` on safe next action,
missed uncommitted work, and dead-work repeat **without extra tutoring**?

If `packet_only` wins, invest in the brief (what to omit, graves, delivery
axis), not a richer ledger.

## Question 2 — refusal provenance

On frozen evidence-gap / needs-evidence cases:

Does refusal appear because the Situation decision is already `refuse` or
`needs_evidence`, or only because the prompt names `refuse=true`?

Score those as different arms. Tutoring may be measured. It must not be counted
as Seedrop v2 causing the refusal.

## Spend lock

| Action | Authorization |
| --- | --- |
| Gate A failed-attempt compatibility canary (4 results / 8 calls) | **AUTHORIZED 2026-08-21**: 8 logical calls / 8 provider attempts / max $1 USD — see [authorization receipt](../proofs/wave-7-gate-a-authorization-2026-08-21.md) |
| Gate B 24-result repair canary | forbidden; that contract still tutors and does not score Q1/Q2 |
| 4,040-result screen | forbidden |
| Token-cap increase | forbidden |
| Design-partner pilot | forbidden |
| Inferring spend from implementation or task creation | forbidden |

`seedrop_db` remains off-trajectory.

## What a pass is not

A green canary after louder refusal instructions is harness hygiene. It does
not prove that a cold agent takes the correct next action because Seedrop
compiled a Situation.
