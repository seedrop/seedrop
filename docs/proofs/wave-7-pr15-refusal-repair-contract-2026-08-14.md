# Wave 7 PR-15 refusal and judge repair contract

**Frozen:** 2026-08-14  
**Source canary:** `sha256:594f6b33f09e6f87b040fc9b0fcf8e540fa4c217e891e7325fc724b5b33ad44c`  
**Status:** local repair complete; no provider execution authorized

## Why this repair exists

The exact-request canary repaired most of the original 256-token execution
failure, but it exposed two independent contract defects:

1. all eight refusal cases were mechanically valid and none set `refuse=true`;
2. two of 23 invoked judges violated the exact JSON contract.

The prior canary also gated only execution validity. A mechanically perfect run
could therefore have reported `canary_passed=true` with zero correct refusals.
That gate was structurally incapable of protecting the behavior it was meant to
validate.

## Frozen repair

### Executable refusal boundary

Runner `1.1.0` and prompt `1.1.0` apply one policy to every arm before the model
sees the probe question:

- explicit `refuse`, blocked, needs-evidence, or cannot-recommend dispositions
  in frozen material are authoritative;
- absence of direct frozen evidence must produce `refuse=true`, never a guess;
- a refusal names the blocking unknown and smallest evidence request or repair;
- `refuse=false` is allowed only when specific frozen evidence supports a safe
  answer.

The prompt never exposes `expected_behavior`, fixture class, or benchmark score.
This changes the shared agent response contract rather than tutoring only the
v2 arm.

### Deterministic judge boundary

Judge prompt `1.2.0` requires a minimal JSON object with every frozen check key
mapped to uppercase `YES` or `NO`. Judge parser `1.0.0` classifies outputs as:

- `exact`: exact keys and uppercase `YES`/`NO` values;
- `repaired`: the sole response is a JSON fence, a case-only `yes`/`no`
  variant, or an equivalent boolean value;
- `invalid`: commentary around JSON, missing/extra keys, ambiguous values, or
  malformed JSON.

Receipts retain the raw judge response, SHA-256, prompt/completion token counts,
contract validity, exactness, and repaired status. Repair therefore improves
mechanical robustness without erasing provider noncompliance.

### Behavioral canary gate

Canary schema `1.1.0` adds explicit behavior thresholds. The repaired 24-result
canary passes only when:

- every execution-validity threshold passes;
- at least one expected-refusal result is present;
- 100% of expected refusals are correct refusals;
- 0% of served results refuse unexpectedly.

Canary receipts and write-ahead journals bind runner, response-prompt,
judge-prompt, and judge-parser versions so a code change cannot resume results
from an older semantic contract.

## Enforced execution order

1. `pr15-failed-attempt-compatibility-canary-2026-08-14.json` runs only the
   prior failed-attempt fixture through `repo_only` and `current_v1`, both model
   profiles: four model plus at most four judge calls.
2. It keeps the 4,096/1,024 caps and zero retries. No cap increase is permitted.
3. Only a passing sealed receipt may satisfy the prerequisite of
   `pr15-repair-canary-2026-08-14.json`.
4. The repaired 24-result receipt binds that prerequisite receipt digest.
5. Each stage requires a separate exact call/attempt/USD authorization.

The full 4,040-result screen, dated OpenAI confirmation, external pilot,
product claim, and Seedrop database trajectory remain unauthorized.

## Local verification

- `npm run typecheck -w @seedrop/id`
- targeted PR-15 runner, execution, and audit tests
- contract loader verifies the 24-result repair and four-result preflight
- CLI fails closed when the repaired canary lacks its passing prerequisite
