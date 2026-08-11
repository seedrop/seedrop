import { describe, expect, it } from "vitest";
import {
  WORK_EVENT_TYPES,
  buildClaimRecord,
  buildEpisodeRecord,
  buildIntentRecord,
  buildLeaseRecord,
  buildProjectEvent,
  buildProjectTransaction,
  buildWorkLifecycleTransition,
  buildWorkReceipt,
  canonicalJson,
  projectTransactionDigest,
} from "@seedrop/protocol";
import type { ProjectLogScan, ProjectStoredTransaction } from "../src/index.js";
import { queryWorkReceipts, reduceWorkProjection } from "../src/index.js";
import { PRINCIPAL_ID, PROJECT_ID, makeId } from "./fixtures.js";

const AT = "2026-08-11T13:00:00.000Z";

describe("native work projection", () => {
  it("deterministically reduces all five nouns and preserves Receipt provenance", () => {
    const transaction = openTransaction();
    const entry = stored(transaction);
    const projection = reduceWorkProjection(scan([entry]));
    const rebuilt = reduceWorkProjection(scan([entry]));

    expect(canonicalJson(rebuilt)).toBe(canonicalJson(projection));
    expect(projection.intents[0]?.state).toBe("active");
    expect(projection.episodes[0]?.state).toBe("active");
    expect(projection.claims).toHaveLength(1);
    expect(projection.leases[0]?.state).toBe("active");
    expect(queryWorkReceipts(projection, { receipt_kind: "episode_started" })).toMatchObject([
      { transaction_digest: entry.digest, receipt: { subject_id: makeId("episode", 301) } },
    ]);
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("rejects a second active Lease for the same target", () => {
    const first = stored(openTransaction());
    const secondTransaction = openTransaction(400, first.digest, "shared/target");
    const second = stored(secondTransaction);
    expect(() => reduceWorkProjection(scan([second, first]))).toThrowError(expect.objectContaining({
      code: "seedrop.protocol.lease_conflict",
    }));
  });
});

function openTransaction(seed = 300, previous = null as ProjectStoredTransaction["digest"] | null, target = "shared/target") {
  const intentId = makeId("intent", seed);
  const episodeId = makeId("episode", seed + 1);
  const claimId = makeId("claim", seed + 2);
  const receiptId = makeId("receipt", seed + 3);
  const leaseId = makeId("lease", seed + 4);
  const commandId = makeId("command", seed + 5);
  const intent = buildIntentRecord({
    intent_id: intentId, project_id: PROJECT_ID, title: `Intent ${seed}`, state: "queued",
    created_by: PRINCIPAL_ID, created_at: AT,
  });
  const transition = buildWorkLifecycleTransition({
    lifecycle: "intent", subject_id: intentId, from: "queued", to: "active", reason: "episode_started",
    actor_principal_id: PRINCIPAL_ID, recorded_at: AT,
  });
  const episode = buildEpisodeRecord({
    episode_id: episodeId, project_id: PROJECT_ID, intent_id: intentId, goal: `Episode ${seed}`,
    state: "active", started_by: PRINCIPAL_ID, started_at: AT,
  });
  const claim = buildClaimRecord({
    claim_id: claimId, project_id: PROJECT_ID, intent_id: intentId, episode_id: episodeId,
    claim_kind: "scope", statement: target, evidence_digests: [], corrects_claim_id: null,
    recorded_by: PRINCIPAL_ID, recorded_at: AT,
  });
  const lease = buildLeaseRecord({
    lease_id: leaseId, project_id: PROJECT_ID, target, holder_principal_id: PRINCIPAL_ID,
    intent_id: intentId, episode_id: episodeId, state: "active", acquired_at: AT,
    expires_at: "2026-08-11T13:01:00.000Z",
  });
  const receipt = buildWorkReceipt({
    receipt_id: receiptId, receipt_kind: "episode_started", command_id: commandId,
    principal_id: PRINCIPAL_ID, project_id: PROJECT_ID, subject_id: episodeId,
    issued_at: AT, summary: "Episode started", evidence_digest: null,
  });
  const values = [
    [WORK_EVENT_TYPES.intent_created, intentId, intent],
    [WORK_EVENT_TYPES.intent_transitioned, intentId, transition],
    [WORK_EVENT_TYPES.episode_started, episodeId, episode],
    [WORK_EVENT_TYPES.claim_recorded, claimId, claim],
    [WORK_EVENT_TYPES.lease_acquired, leaseId, lease],
    [WORK_EVENT_TYPES.receipt_recorded, receiptId, receipt],
  ] as const;
  return buildProjectTransaction({
    command_id: commandId, command_version: "1.0.0", command_name: "seedrop.work.open",
    principal_id: PRINCIPAL_ID, project_id: PROJECT_ID, idempotency_key: `open-${seed}`,
    input_digest: `sha256:${seed.toString(16).padStart(2, "0").slice(-2).repeat(32)}`,
    previous_transaction_digest: previous, recorded_at: AT,
    events: values.map(([event_type, subject_id, payload], index) => buildProjectEvent({
      event_id: makeId("event", seed + 20 + index), event_type, subject_id, occurred_at: AT, payload,
    })),
  });
}

function stored(transaction: ReturnType<typeof openTransaction>): ProjectStoredTransaction {
  const digest = projectTransactionDigest(transaction);
  return { digest, relative_path: `transactions/${digest.slice(7)}.json`, byte_length: 1, transaction };
}

function scan(transactions: readonly ProjectStoredTransaction[]): ProjectLogScan {
  return {
    project_id: PROJECT_ID,
    transactions,
    sources: transactions.map((entry) => ({
      path: entry.relative_path, expected_digest: entry.digest, actual_digest: entry.digest, status: "valid",
    })),
    diagnostics: [],
  };
}
