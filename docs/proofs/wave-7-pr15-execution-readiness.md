# Wave 7 PR-15 execution-readiness receipt

**Frozen:** 2026-08-13<br>
**Corpus:** `wave7-2026-08-13-b` (101 independent ground truths)<br>
**Execution contract:** `id/benchmarks/resumption/pr15-openai-2026-08-13.json`<br>
**Canonical contract SHA-256:** `514ee796d300070f6c285b92f4ff65b17af2a1bc1afcd8ef94baf2abc926576e`<br>
**OpenCode screen SHA-256:** `569f5d1192a0ee111ae2660e3ee827d83e3c9d356950bc321501811ed30e7f9d`

## Result

The internal PR-15 proof path is mechanically ready for an explicitly approved
provider spend. No model call has been made and no product threshold has yet
passed.

An economical full-matrix screening contract is also frozen at
`id/benchmarks/resumption/pr15-opencode-go-2026-08-13.json`. It uses the same
8,080 logical-call matrix through the OpenCode Go subscription already proven
by Outer Agent: DeepSeek V4 Pro primary, DeepSeek V4 Flash weak ablation, and
Flash judge. This screen is now the first execution cohort; the OpenAI contract
remains the reproducible confirmation cohort if the screen clears the product
gate.

The formal matrix uses dated provider snapshots:

| Role | Snapshot | Reasoning | Output cap |
|---|---|---:|---:|
| Primary | `gpt-5.5-2026-04-23` | none | 256 tokens |
| Weak ablation | `gpt-5.4-nano-2026-03-17` | none | 256 tokens |
| Judge | `gpt-5.5-2026-04-23` | none | 128 tokens |

GPT-5.6 is deliberately excluded from the formal gate. Its official model pages
did not list dated snapshots at freeze time, so an alias-only run would not meet
the reproducibility contract. A contemporary GPT-5.6 cohort may be reported
later as supplementary evidence, never as a replacement for this formal run.

## Spend and recovery controls

- Exact approval is required for 8,080 logical calls and 32,320 maximum provider
  attempts, plus a positive operator-chosen USD ceiling.
- The harness refuses every uncapped request and checks a conservative cost
  reservation before the provider call. Provider-reported usage is then used to
  reconcile actual cost.
- The approximately $85.63 standard-request estimate assumes current published
  token prices and the frozen corpus. It is not a quote or authorization.
- A digested append-only journal writes a conservative reservation before every
  provider call, settles returned usage, makes each completed probe restartable,
  and binds resume data to the corpus, benchmark, execution contract, profiles,
  retries, spend approval, and call plan. Interrupted reservations continue to
  consume the ceiling because their billing state is unknowable locally.
- An existing final receipt aborts before provider import or credential access.
- Returned backend system fingerprints, exact dated model IDs, token usage,
  retries, provider attempts, and calculated cost are retained in the receipt.

## Honest limitations

- The primary model also judges the answers. That is consistent and pinned, but
  it is not independent model-family replication.
- Chat Completions `seed` is deprecated and best-effort rather than guaranteed
  determinism. Dated snapshots and retained system fingerprints reduce, but do
  not eliminate, backend reproducibility risk.
- The corpus is internal machine evidence. Passing it is necessary before the
  design-partner pilot, not sufficient evidence of external product value.
- The database experiment remains outside this trajectory.
- The latest OpenAI Node SDK (`7.4.0`) requires Node 22 and is incompatible with
  Seedrop's Node 20 floor. The execution contract therefore pins the newest
  verified Node-20-compatible client, `openai@6.49.0`.
- OpenCode Go publishes mutable model aliases, not dated model revisions. The
  screening contract therefore binds the observed public model catalog and
  retains response fingerprints, but it cannot make a formal reproducibility
  claim.
- OpenCode's official limits are dollar-metered. The exact frozen matrix dry
  simulation is approximately $4.20 without cache when every output consumes
  its cap (and $14.56 under the harness's intentionally extreme one-token-per-
  byte reservation accounting), so it fits below the current $12 rolling
  five-hour provider allowance by the tokenized estimate. The hard local USD
  ceiling remains mandatory and fail-closed.

## Preflight evidence

The real 101-fixture CLI path reran readiness and refused before provider import
when spend approval was absent, reporting the exact required ceiling:

```text
PR-15 spend is not approved; no model calls made.
Exact approval required: 8080 logical calls, 32320 provider attempts, and a
positive USD ceiling.
```

Package validation at this checkpoint: TypeScript typecheck passed; all 31 ID
test files passed (269 tests, 3 skipped); the ID build and root architecture
checks passed.
