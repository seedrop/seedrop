# Wave 7 questions locked into the PR-15 runner — 2026-08-14

**Task:** `0bd55150`  
**Authority:** runner lock only; no provider spend

The two Wave 7 product questions are now executable runner contracts, not
documentation. `summarizePr15().gate_passed` and the tutored repair canary are
not Wave 7 answers.

## Arrange / Act / Assert

| Gate | Assert |
| --- | --- |
| `id/tests/resumption-wave7-questions.test.ts` | Q1 prompt has no `set refuse=true`; Q2 control still does |
| same | Q1 excludes tutored results; requires `v2_situation`, `packet_only`, `current_v1` on served work |
| same | Q2 attributes refusal to tutoring when the untutored v2 arm does not refuse |
| same | failed-attempt and 24-result repair canaries `canaryAnswersWave7Questions === false` |
| `npm test -w @seedrop/id` | 287 passed |

`wave7_v2_win` is hardcoded false. A green comparison on synthetic results is
not a product win. Gate A/B still need an exact operator ceiling, and Gate B's
existing 24-result contract still does not score these questions.

No provider calls were made.
