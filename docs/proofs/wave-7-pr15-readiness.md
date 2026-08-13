# Wave 7 PR-15 corpus-readiness receipt

**Observed:** 2026-08-13

**Contract:** `id/benchmarks/resumption/pr15-contract.json`

**Command:** `npm run bench:resumption:readiness -w @seedrop/id -- --corpus --allow-not-ready`

Wave 7 starts with a deliberate no-spend decision. The current corpus yields 14
legacy handoff fixtures and 18 independent observed probes across six repos:

| Legacy probe type | Independent observations |
|---|---:|
| standing decision | 12 |
| failed/dead attempt | 6 |

None is yet eligible for PR-15 because the legacy fixture shape does not bind a
repo commit, evidence cutoff, source digest, Situation/decision/semantic identity,
projection and policy versions, sanitation receipt, explicit independence key,
or served/refused outcome. Current eligible ground truths are therefore zero,
not eighteen.

The frozen readiness floor is 100 eligible independent ground truths, all six
product probe classes, at least five eligible repositories, no repository above
40% of the corpus, at least ten served and ten explicitly refused Situations,
and task-linked ground truth for every safest-next-action probe. A failing report
exits 2 unless `--allow-not-ready` is supplied for an observational audit.

This receipt proves the gate rejects today's underpowered corpus. It is not a
claim that the corpus can never become ready, and it is not permission to weaken
the thresholds after seeing model results.
