# Wave 7 PR-15 corpus receipt

**Captured:** 2026-08-13<br>
**Contract:** `id/benchmarks/resumption/pr15-contract.json` (`seedrop.pr15.resumption.v1`)<br>
**Local manifest:** `~/.seedrop/benchmarks/pr15/wave7-2026-08-13-b/review-manifest.json`<br>
**Manifest SHA-256:** `e48e17966932502bda456c576d47778b22c28336c457e5a1a2dbae6612b1ea9b`

The frozen fixture bodies remain machine-local because they contain evidence
from private working repositories. This committed receipt contains aggregate
distribution and integrity results only.

## Result

The unchanged preregistered readiness contract passes:

| Measure | Observed | Required |
|---|---:|---:|
| Eligible independent ground truths | 101 | at least 100 |
| Eligible physical Git repositories | 15 | at least 5 |
| Largest repository share | 10.89% | at most 40% |
| Successful Situation fixtures | 89 | at least 10 |
| Explicit-refusal fixtures | 12 | at least 10 |
| Duplicate independence keys | 0 | 0 |
| Invalid probe metadata | 0 | 0 |
| Legacy or unbound fixtures | 0 | 0 |
| Future ground truths | 0 | 0 |

Probe-class distribution:

| Class | Count | Required |
|---|---:|---:|
| Current intent | 23 | at least 10 |
| Unsafe condition | 11 | at least 10 |
| Delivery state | 22 | at least 10 |
| Relevant failed attempt | 14 | at least 10 |
| Evidence gap | 20 | at least 10 |
| Safest next action | 11 | at least 10 |

All 101 adapter Situation envelopes are below the 4 KiB product ceiling: 2,246
bytes minimum, 3,157 bytes median, and 3,380 bytes maximum. The execution gate
measures the Situation envelope itself; combined repository-plus-Situation arm
bytes remain reported separately as experiment economics.

## Method

`scripts/pr15-corpus.mjs` discovers passport-linked Views, canonicalizes nested
Views against their physical Git repository, and explicitly excludes
`seedrop_db` and the ephemeral elevation probe. For every admitted View it:

1. recomputes Git delivery outcomes read-only;
2. imports the current v1 View history into the v2 shadow project model;
3. compiles the real bounded Situation and read-only adapter projection;
4. binds each independently scored fact to source-tree, commit, cutoff,
   Situation, decision, semantic, and sanitation digests;
5. deterministically redacts secret-shaped material before publication;
6. freezes each candidate through the no-overwrite PR-15 freezer; and
7. reruns the unchanged readiness contract over the frozen outputs.

The first pass produced 77 eligible facts and failed three gates: total facts,
unsafe-condition coverage, and explicit-refusal coverage. No threshold was
lowered. The second pass made real refusal reasons and blocking evidence
requests scoreable and separated distinct goal and validation facts. It then
passed at 101 facts. This history is retained in the adjacent machine-local
`wave7-2026-08-13-a` and `wave7-2026-08-13-b` directories.

## Honest limitations

- This is internal, current-snapshot dogfood evidence, not external design-partner validation.
- Candidate facts are selected from deterministic v2 projections and bound to
  their imported source tree. That proves resumption behavior against the
  product's frozen output, but it is not an independent audit of every semantic
  choice made by the Situation compiler.
- The deterministic scanner found no secret-shaped material in the passing
  corpus, but the fixture bodies remain local and must not be published.
- Passing readiness authorizes the controlled model experiment. It does not
  imply that any product threshold has passed, and it does not authorize the
  design-partner pilot before the internal result is analyzed.
