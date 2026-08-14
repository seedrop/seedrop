# Wave 7 product questions

**Frozen:** 2026-08-14  
**Governing task:** `0bd55150` (`v2:live-situation-then-two-questions`)  
**Status:** questions locked; provider spend is not authorized

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
4. The benchmark `v2_situation` arm is that live object, or a sealed replay of
   it, not a brochure fixture that boot does not serve.

Until those are true, no provider calls.

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
| Gate A failed-attempt compatibility canary (4 results / 8 calls) | optional, exact operator call/attempt/USD ceiling only, and only after preconditions |
| Gate B 24-result repair canary | forbidden until both questions are locked into the runner and live Situation is the v2 arm |
| 4,040-result screen | forbidden |
| Token-cap increase | forbidden |
| Design-partner pilot | forbidden |
| Inferring spend from implementation or task creation | forbidden |

`seedrop_db` remains off-trajectory.

## What a pass is not

A green canary after louder refusal instructions is harness hygiene. It does
not prove that a cold agent takes the correct next action because Seedrop
compiled a Situation.
