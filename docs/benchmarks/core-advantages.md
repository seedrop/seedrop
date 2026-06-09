# Core Advantage Benchmarks

These benchmarks define the Seedrop behaviors that should keep getting stronger:

| Scenario | Advantage protected | Weakness it catches |
| --- | --- | --- |
| Situation packet | A fresh stateless agent gets purpose, last work, current state, next move, attention cues, evidence, confidence, and the underlying boot trace from `seed boot --json`. | Useful state can be present but spread across too many surfaces for a new run to act safely. |
| Decision trace | `next_action` is selected from evaluated candidates with evidence, modifiers, final priority, and rejection reasons. | Explanations can become plausible prose that does not actually prove why the winner was chosen. |
| Outcome score | A selected boot candidate carries objective terms, and post-run observations can score whether the decision reduced expected loss. | A trace can explain a choice without proving that the choice improved the next stateless run. |
| Cold start context | A fresh agent gets purpose, manifest, continuity, and resume proof from one View context fetch. | View can exist but still be too low-signal to resume from. |
| Interruption recovery | An active run preserves changed paths and next actions across session loss. | Agents can leave work that is visible but not actionable. |
| Multi-agent awareness | Another agent's claim is visible as structured state, not shared prose. | Coordination can silently devolve into markdown convention. |
| Stale knowledge guardrail | Superseded or stale notes are audit-visible before decisions depend on them. | Knowledge can rot while still looking authoritative. |

Executable coverage lives in `cli/tests/boot.test.ts`, `cli/tests/router.test.ts`, and `space/tests/core-advantages.test.ts`.
