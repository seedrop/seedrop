# Changelog

All notable changes to `@seedrop/id` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0-alpha.4] — 2026-06-11

### Changed
- Release alignment with the 0.2.0-alpha.4 docs-final sweep (no code changes).

## [0.2.0-alpha.3] — 2026-06-11

### Fixed
- README: removed the stale "Not yet published" install note and local absolute paths; clarified that `@seedrop/id` is normally installed transitively via `@seedrop/cli`.

## [0.2.0-alpha.2] — 2026-06-10
_Supersedes 0.2.0-alpha.1 (first public cut; undocumented)._

### Added
- npm metadata: `repository`, `homepage`, `bugs` fields linking back to the GitHub monorepo.


### Changed
- All `seed-id` subcommands now default the passport path to `$SEEDROP_PASSPORT` or `~/.seedrop/id/passport.json` when `--passport` is omitted. Per-repo passports are no longer the implicit default; identity is per-agent, machine-wide.
- `seed-id init` defaults `--out` to the same global path.

### Fixed
- `process.argv[1]` script-detection guard in `cli.ts` now resolves through symlinks (`realpath`), so the binary works when launched through the npm `.bin/seed-id` symlink.

### Added
- Exported `defaultPassportPath()` helper.

---

## [0.1.0-alpha.8] — 2026-05-15

### Added
- `seed-id init` for first-run passport creation with default `.seedrop/id/passport.json` output, `--out`, `--agent-id`, and overwrite protection via `--force`.
- `seed-id validate`, `seed-id show`, and `seed-id audit` for local identity inspection from the shell.
- `Identity.upsertActiveProject()` and `seed-id project link` for audited project/view attachment in `active_projects`.

---

## [0.1.0-alpha.7] — 2026-05-14

### Added
- Architecture note reframing `@seedrop/id` as portable agent self-state rather than embedding-first identity drift.
- Example self-state passport at `examples/passport.self-state.json`.
- Optional passport fields for operational persistence:
  - `active_projects`
  - `credential_refs`
  - `continuity`
- Public schemas and types for `ActiveProject`, `CredentialRef`, and `ContinuityState`.
- Repairable passport commit journal:
  - `defaultCommitJournalPath()`
  - `createCommitJournalRecord()`
  - `writeCommitJournal()`
  - `readCommitJournal()`
  - `clearCommitJournal()`
  - `repairPendingCommit()`
  - `Identity.repairPendingCommit()`
- Package-local `seed-id` CLI with `status` and `repair` commands for pending passport commit journals.

### Changed
- README now centers agent self-state, project references, credential references, and continuity. Embedding-backed coherence is described as an optional diagnostic.
- `Identity.passport` now returns a defensive clone so external callers cannot silently mutate internal identity state outside the audit path.
- Build now cleans `dist/` before compiling to prevent stale package artifacts.
- `commitSession({ write: true })` now writes a short-lived commit journal before mutating audit/passport artifacts so interrupted commits can be completed safely.

---

## [0.1.0-alpha.6] — 2026-05-14

### Added — Slice 6: Commitment-erosion benchmark
- `benchmarks/erosion/` harness: 10 hand-authored tasks, 2 arms (`protected` vs `unprotected`), N seeds, Wilson 95% CIs, and a YES/NO judge-LLM verdict per run.
- `npm run bench:erosion` script — runs the benchmark against any OpenAI-compatible endpoint (Groq, Fireworks, OpenAI, Ollama with `/v1`) using only `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `SEEDROP_BENCH_MODEL`. The `openai` SDK is loaded lazily so it's not a hard dependency for library users.
- `benchmarks/erosion/README.md` — reproducer doc with quickstart (clone → install → set env → run), configuration table, output schema, honest limitations section.
- Output JSONs land in `benchmarks/erosion/results/<timestamp>.json` (gitignored — operators commit their own results when reproducing a baseline).
- Re-usable Wilson interval and overlap helpers, plus runner/summary primitives (`runTask`, `runBenchmark`, `summarize`) — bench-internal; not part of the public package API.

### Changed
- `LLMRequest` gains an optional `seed?: number` field (OpenAI-compatible). Used by the benchmark runner to enable seed-controlled reruns; library users may pass it through. Non-breaking.

### Tooling
- New devDep `tsx` so the benchmark runs straight from TypeScript source.
- New `tsconfig.typecheck.json` so `npm run typecheck` covers `src/` AND `benchmarks/` (`tests/` excluded because vitest already typechecks them).

### Tests
- 141 tests across 19 files (22 new — stats/runner unit tests + Slice 6 integration). 100% line / statement / function coverage on `src/`; 97.74% branch.
- Ship-criterion (PRD §9.6) satisfied:
  - 10 task fixtures load, each well-formed (unique id, exactly 5 user turns, valid check).
  - End-to-end harness exercises every (task, arm, seed) tuple against deterministic mocks and produces per-arm n/held/rate/Wilson CIs, delta in percentage points, and a CI-overlap verdict.
  - With a divergent mock (protected always holds, unprotected always caves), the harness reports Δ = 100pp with non-overlapping CIs — proving the harness can resolve a real signal.
  - Reproducer doc and `npm run bench:erosion` script verified to fail with a clear error on missing env, and to invoke the runner cleanly.

---

## [0.1.0-alpha.5] — 2026-05-14

### Added — Slice 5: Recovery (harvester)
- `session.harvest(options?)` — async, scans every boundary-channel message in history and promotes those whose embedding has cosine similarity ≥ `threshold` (default `0.85`) to the passport identity vector. Promoted messages are re-channelled to `commitments` in place — their `index` stays stable — and flagged with `recovered: true`.
- New types: `HarvestOptions` (`{ threshold? }`) and `HarvestResult` (`{ promoted, scanned, precision }`). Both exported from `@seedrop/id`.
- `RecordedMessage` gains an optional `recovered?: boolean` field for messages surfaced by the harvester.
- Identity vector and per-message embedding caches are shared with `coherence()`: a harvested message is embedded once and stays cached, so a subsequent `coherence()` call reflects the promotion without re-embedding.
- Harvester never demotes — commitments stay commitments. Repeat calls are idempotent: a promoted message is no longer scanned because its channel changed.

### Tests
- 119 tests across 16 files (17 new — 12 harvester unit tests + Slice 5 integration). 100% line / statement / function coverage; 97.74% branch coverage.
- Ship-criterion (PRD §9.5) satisfied by `tests/integration-slice-5.test.ts`:
  - On a 50-message synthetic test with 5 wrongly-quarantined commitments interleaved with 45 noise messages, harvest promotes ≥3 of 5 with 0 false positives.
  - A gated real-Ollama arm (skipped unless `SEEDROP_INTEGRATION_OLLAMA=1` plus URL and model env vars) asserts the same against a live embedder. Run via `npm run test:integration`.

---

## [0.1.0-alpha.4] — 2026-05-14

### Added — Slice 4: Coherence monitor
- `session.coherence()` — async, returns the cosine distance between the passport identity vector and the centroid of commitment-channel message vectors. Returns `0` when no commitment messages have been recorded.
- `embeddings?: EmbeddingProvider` option on `SessionOptions`. Required for `coherence()`; calling without it raises `IdentityConfigError`.
- `EmbeddingProvider` interface — `embed(texts: readonly string[]): Promise<number[][]>`. Implement against any backend.
- `OllamaEmbeddings` class — default provider, posts to `${baseURL}/api/embed` with `{ model, input }`. Defaults: `baseURL = "http://localhost:11434"`, `model = "nomic-embed-text"`. Returns `[]` for empty input without calling fetch. Throws on non-ok response and on count-mismatch with the request.
- Vector utilities exported for downstream tooling: `cosineSimilarity`, `cosineDistance`, `meanVector`.
- Embedding cache inside `Session`: the identity prompt is embedded once per session; each commitment message is embedded once and keyed by its index. Repeat `coherence()` calls only embed messages added since the previous call.

### Tests
- 102 tests across 13 files (27 new — vectors, embeddings, coherence, Slice 4 integration). 100% line / statement / function coverage; 97.36% branch coverage.
- Ship-criterion (PRD §9.4) satisfied by `tests/integration-slice-4.test.ts`:
  - Baseline drift after `Identity.fromPassport()` with no input is `≤ 0.05`.
  - Drift grows monotonically as off-topic commitment-channel messages accumulate without recovery.
  - A gated real-embedder arm (skipped unless `SEEDROP_INTEGRATION_OLLAMA=1` plus URL and model env vars) asserts the same behavior against a live Ollama backend. Run via `npm run test:integration`.

---

## [0.1.0-alpha.3] — 2026-05-14

### Added — Slice 3: LLM-backed identity guard
- `classifier: "rule" | "llm" | "hybrid"` option on `SessionOptions`. Defaults to `"rule"` (Slice 2 behavior preserved).
- `llm: { client, model, systemPrompt? }` option on `SessionOptions`. Required when `classifier` is `"llm"` or `"hybrid"`; the `client` shape matches the OpenAI SDK so `new OpenAI(...)` can be passed directly.
- Public classes: `RuleClassifier`, `LLMClassifier`, `HybridClassifier`. Public types: `Classifier`, `ClassifierKind`, `LLMClient`, `LLMConfig`, `LLMRequest`, `LLMResponse`.
- `LLMClassifier` builds a deterministic identity-router prompt from the session slots (agent name, purpose, hard constraints) and asks the model to reply with a single channel word. On any failure (network error, gibberish response, null content) it falls back to the configured router.
- `HybridClassifier` routes non-user roles through the rule path and user-role messages through the LLM — minimising token cost while keeping the LLM in the loop where adversarial pressure actually enters.
- `IdentityConfigError` raised when `classifier` is `"llm"` or `"hybrid"` but `llm` is missing.

### Changed (breaking, alpha)
- **`Session.record(...)` is now `async`** and returns `Promise<RecordedMessage>`. Existing call sites must add `await`. Justified by the LLM-backed routing path; rule-only callers see no behavioral change.

### Tests
- 74 tests across 10 files (16 new classifier tests + 3-arm integration suite). 100% line / 100% statement / 100% function / 98.96% branch coverage.
- Ship-criterion (PRD §9.3) satisfied:
  - `classifier: "rule"` reproduces Slice 2 routing on all 20 hand-labeled experiences (`tests/integration-slice-3.test.ts`).
  - With an oracle LLM mock, the `classifier: "llm"` path routes 20/20 correctly — proves the plumbing.
  - A gated real-LLM arm (skipped unless `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `SEEDROP_INTEGRATION_MODEL` are set) asserts the ≥85% accuracy requirement against a live backend. Run via `npm run test:integration`.

### Added — npm script
- `test:integration` — runs only the integration suites.

---

## [0.1.0-alpha.2] — 2026-05-14

### Added — Slice 2: `Identity.session()` + slot-seeded working memory
- `id.session(options?)` — returns a `Session` whose typed slots are seeded from the passport.
- `SessionSlots` typed shape (`name`, `current_goal`, `hard_constraints`, `priorities`, `project_conventions`, `boundary_seed`, `blocked_paths`).
- `Session.record(message, { channel? })` — append-only history with per-message routing to `commitments` or `boundary`. Default router sends every message to `commitments`; a custom `router` callback or an explicit `channel` override at record-time both work, with the override winning.
- `Session.reconstruct()` — returns OpenAI-compatible `Message[]` with the passport-seeded system prompt first, then every message routed to `commitments` in order. Boundary messages are excluded.
- `Session.systemPrompt` — read-only, deterministic system prompt containing every `core_commitment` verbatim. Empty sections are omitted; section order is stable.
- New exported types: `Message`, `Role`, `Channel`, `RecordedMessage`, `SessionSlots`, `SessionOptions`, `RecordOptions`, `Router`.

### Tests
- 56 tests across 8 files (23 new). 100% line / statement / function coverage; 98.38% branch coverage.
- Ship-criterion (PRD §9.2) satisfied by `tests/integration-slice-2.test.ts`: load passport → record 10 mixed messages → reconstruct → asserts every `core_commitment` appears verbatim in the system prompt and that boundary-routed messages are excluded.

---

## [0.1.0-alpha.1] — 2026-05-14

### Added — Slice 1: passport.json schema + I/O
- `PassportSchema` (and `PassportSchemaV1`) — Zod schema for passport v1.0, strict mode, with `superRefine` enforcing unique `value_anchors.name` and `value_anchors.priority`.
- `Passport` TypeScript type inferred from the schema.
- `Identity.fromPassport(path)` — loads, parses, and validates a passport from disk; returns an `Identity` instance.
- `Identity.savePassport(passport, path)` — validates and writes a passport with stable JSON formatting (2-space indent, trailing newline).
- Typed error hierarchy: `PassportError`, `PassportNotFoundError`, `PassportParseError`, `PassportValidationError`. Validation errors expose the full `ZodIssue[]` and the source path.

### Tests
- 33 tests across 4 files. 100% line / statement / function coverage; 97.22% branch coverage. Includes round-trip, all error paths, strict-mode unknown-key rejection, and value_anchor uniqueness invariants.

### Build
- ESM output to `dist/` with `.d.ts` and sourcemaps. `noUncheckedIndexedAccess` enabled; strict mode clean.

---

## [0.1.0-alpha.0] — 2026-05-14

### Added
- Initial repo scaffold: `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE` (MIT), `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`.
- Empty `src/` and `tests/` directories.

### Notes
- No application code in this release. Public API is intent only — see `README.md`.
- Source of design: `/Users/mc/Projects/memo/knowledge/projects/seedrop/id/prd.md`.
- Algorithms will be ported from the CCL research substrate at `/Volumes/MC/Apps/ccl/` by re-implementation (no code imports).
