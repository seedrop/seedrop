import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_WORK_COMMANDS,
  ProtocolError,
  buildOutboxDeliveryReceipt,
  generateCanonicalId,
} from "@seedrop/protocol";
import type {
  CanonicalId,
  CanonicalIdKind,
  OutboxDeliveryReceipt,
  OutboxEffect,
  ProjectTransactionDigest,
} from "@seedrop/protocol";
import {
  queryWorkReceipts,
  reduceWorkProjection,
  scanProjectTransactions,
} from "@seedrop/project";
import {
  createKernelCommandExecutor,
  createNativeWorkCommandDefinitions,
} from "../src/index.js";
import type {
  KernelCommandRequest,
  KernelEffectOutbox,
} from "../src/index.js";

const roots: string[] = [];
const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff);
const id = <K extends CanonicalIdKind>(kind: K, seed: number) => generateCanonicalId(kind, {
  now: 1_723_379_696_000 + seed,
  entropy: entropy(seed),
});
const PROJECT = id("project", 1);
const PRINCIPAL = id("principal", 2);
const RECIPIENT = id("principal", 3);
const DIGEST = `sha256:${"ab".repeat(32)}` as ProjectTransactionDigest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Intent Episode Claim Receipt Lease vertical slice", () => {
  it("opens all five native nouns in one canonical command and exposes a queryable Receipt", async () => {
    const root = await tempRoot();
    const harness = executor(root);
    const payload = openPayload(10, "src/native.ts");
    const outcome = await harness.execute(command(10, NATIVE_WORK_COMMANDS.open, payload, null));
    const projection = await readProjection(root);

    expect(outcome.receipt.outcome).toBe("completed");
    expect(projection.intents).toMatchObject([{ state: "active", record: { intent_id: payload.intent_id } }]);
    expect(projection.episodes).toMatchObject([{ state: "active", record: { episode_id: payload.episode_id } }]);
    expect(projection.claims).toMatchObject([{ claim_id: payload.scope_claim_id, claim_kind: "scope" }]);
    expect(projection.leases).toMatchObject([{ state: "active", record: { lease_id: payload.lease_id, target: "src/native.ts" } }]);
    const receipts = queryWorkReceipts(projection, { command_id: outcome.command_id });
    expect(receipts).toMatchObject([{ transaction_digest: outcome.transaction_digest, receipt: {
      receipt_id: payload.receipt_id, receipt_kind: "episode_started", subject_id: payload.episode_id,
    } }]);
  });

  it("finishes atomically, releases its Lease, records outcome truth, and dispatches a handoff", async () => {
    const root = await tempRoot();
    const outbox = new FakeOutbox();
    const harness = executor(root, outbox);
    const openedPayload = openPayload(20, "kernel/src/work.ts");
    const opened = await harness.execute(command(20, NATIVE_WORK_COMMANDS.open, openedPayload, null));
    const finishedPayload = finishPayload(30, openedPayload, true);
    const finished = await harness.execute(command(30, NATIVE_WORK_COMMANDS.finish, finishedPayload, opened.transaction_digest, "finish-once"));
    const projection = await readProjection(root);

    expect(finished.receipt.outcome).toBe("completed");
    expect(finished.effects).toMatchObject([{ effect_type: "seedrop.handoff.requested", required: true }]);
    expect(projection.intents[0]?.state).toBe("reported_complete");
    expect(projection.episodes[0]?.state).toBe("reported_complete");
    expect(projection.leases[0]?.state).toBe("released");
    expect(projection.claims.find((claim) => claim.claim_id === finishedPayload.outcome_claim_id)).toMatchObject({
      claim_kind: "outcome", evidence_digests: [DIGEST],
    });
    expect(queryWorkReceipts(projection, { receipt_kind: "episode_finished" })).toHaveLength(1);
    expect(outbox.receipts.size).toBe(1);

    const replay = await harness.execute(command(31, NATIVE_WORK_COMMANDS.finish, finishedPayload, opened.transaction_digest, "finish-once"));
    expect(replay.transaction_digest).toBe(finished.transaction_digest);
    expect(replay.idempotent_replay).toBe(true);
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(2);
  });

  it("makes simultaneous Lease acquisition one-winner and reports existing target ownership", async () => {
    const root = await tempRoot();
    const harness = executor(root);
    const first = openPayload(40, "shared/target");
    const second = openPayload(50, "shared/target");
    const results = await Promise.allSettled([
      harness.execute(command(40, NATIVE_WORK_COMMANDS.open, first, null)),
      harness.execute(command(50, NATIVE_WORK_COMMANDS.open, second, null)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const projection = await readProjection(root);
    expect(projection.leases.filter((lease) => lease.state === "active")).toHaveLength(1);

    const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "seedrop.protocol.project_transaction_conflict" });
    const next = openPayload(60, "shared/target");
    await expect(harness.execute(command(60, NATIVE_WORK_COMMANDS.open, next, projection.source_high_watermark)))
      .rejects.toMatchObject({ code: "seedrop.protocol.lease_conflict" });
  });

  it("expires a Lease only after its TTL and records explicit expiry evidence", async () => {
    const root = await tempRoot();
    const harness = executor(root);
    const openedPayload = openPayload(70, "expiring/target", "2026-08-11T14:01:00.000Z");
    const opened = await harness.execute(command(70, NATIVE_WORK_COMMANDS.open, openedPayload, null));
    const earlyPayload = {
      lease_id: openedPayload.lease_id, receipt_id: id("receipt", 79),
      observed_at: "2026-08-11T14:00:59.999Z", reason: "ttl_elapsed",
    };
    await expect(harness.execute(command(79, NATIVE_WORK_COMMANDS.expire_lease, earlyPayload, opened.transaction_digest)))
      .rejects.toMatchObject({ code: "seedrop.protocol.lease_conflict" });
    const expiredPayload = { ...earlyPayload, receipt_id: id("receipt", 80), observed_at: "2026-08-11T14:01:00.000Z" };
    await harness.execute(command(80, NATIVE_WORK_COMMANDS.expire_lease, expiredPayload, opened.transaction_digest));
    const projection = await readProjection(root);
    expect(projection.leases[0]?.state).toBe("expired");
    expect(queryWorkReceipts(projection, { receipt_kind: "lease_expired" })).toMatchObject([
      { receipt: { receipt_id: expiredPayload.receipt_id, subject_id: openedPayload.lease_id } },
    ]);
  });

  it("reopens terminal work only through paired correction Events and a fresh Lease", async () => {
    const root = await tempRoot();
    const harness = executor(root);
    const openedPayload = openPayload(90, "corrected/target");
    const opened = await harness.execute(command(90, NATIVE_WORK_COMMANDS.open, openedPayload, null));
    const finished = await harness.execute(command(91, NATIVE_WORK_COMMANDS.finish, finishPayload(190, openedPayload, false), opened.transaction_digest));
    const terminal = await readProjection(root);
    const correctedPayload = {
      intent_id: openedPayload.intent_id,
      episode_id: openedPayload.episode_id,
      intent_event_id: terminal.intents[0]!.state_event_id,
      episode_event_id: terminal.episodes[0]!.state_event_id,
      correction_claim_id: id("claim", 100),
      receipt_id: id("receipt", 101),
      lease_id: id("lease", 102),
      target: "corrected/target",
      lease_expires_at: "2026-08-11T15:00:00.000Z",
      reason: "The completion report referenced the wrong build.",
    };
    const denied = executor(root, new FakeOutbox(), true);
    await expect(denied.execute(command(99, NATIVE_WORK_COMMANDS.correct, correctedPayload, finished.transaction_digest)))
      .rejects.toMatchObject({ code: "seedrop.protocol.command_unauthorized", details: { reason: "reopen_authority_required" } });
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(2);
    await harness.execute(command(100, NATIVE_WORK_COMMANDS.correct, correctedPayload, finished.transaction_digest));
    const corrected = await readProjection(root);
    expect(corrected.intents[0]).toMatchObject({ state: "active", correction_event_ids: [expect.any(String)] });
    expect(corrected.episodes[0]).toMatchObject({ state: "active", correction_event_ids: [expect.any(String)] });
    expect(corrected.leases).toMatchObject([
      { state: "released" },
      { state: "active", record: { lease_id: correctedPayload.lease_id } },
    ]);
    expect(queryWorkReceipts(corrected, { receipt_kind: "correction_applied" })).toHaveLength(1);

    const stale = { ...correctedPayload, correction_claim_id: id("claim", 103), receipt_id: id("receipt", 104), lease_id: id("lease", 105) };
    await expect(harness.execute(command(103, NATIVE_WORK_COMMANDS.correct, stale, corrected.source_high_watermark)))
      .rejects.toMatchObject({ code: "seedrop.protocol.work_state_conflict" });
  });

  it("resumes a pending finish effect without replanning or duplicating project truth", async () => {
    const root = await tempRoot();
    const outbox = new FakeOutbox("throw");
    const harness = executor(root, outbox);
    const openedPayload = openPayload(110, "handoff/target");
    const opened = await harness.execute(command(110, NATIVE_WORK_COMMANDS.open, openedPayload, null));
    const payload = finishPayload(210, openedPayload, true);
    const pending = await harness.execute(command(111, NATIVE_WORK_COMMANDS.finish, payload, opened.transaction_digest));
    expect(pending.receipt.outcome).toBe("effects_pending");
    outbox.mode = "delivered";
    const recovered = await harness.recover({ command_id: pending.command_id, actor_principal_id: PRINCIPAL });
    expect(recovered.receipt.outcome).toBe("completed");
    expect(recovered.transaction_digest).toBe(pending.transaction_digest);
    expect(recovered.recovered).toBe(true);
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(2);
  });
});

class FakeOutbox implements KernelEffectOutbox {
  readonly receipts = new Map<string, OutboxDeliveryReceipt>();
  mode: "delivered" | "throw";
  private sequence = 500;
  constructor(mode: "delivered" | "throw" = "delivered") { this.mode = mode; }
  async dispatch(effect: OutboxEffect): Promise<OutboxDeliveryReceipt> {
    const existing = this.receipts.get(effect.effect_key);
    if (existing) return existing;
    if (this.mode === "throw") throw new Error("outbox unavailable");
    const receipt = buildOutboxDeliveryReceipt({
      receipt_id: id("receipt", this.sequence++), effect_id: effect.effect_id,
      effect_key: effect.effect_key, command_id: effect.command_id, project_id: effect.project_id,
      state: "delivered", attempt: 1,
      recorded_at: new Date(Date.parse(effect.declared_at) + 1_000).toISOString(),
      evidence_digest: effect.payload_digest, error: null,
    });
    this.receipts.set(effect.effect_key, receipt);
    return receipt;
  }
}

function executor(root: string, outbox: KernelEffectOutbox = new FakeOutbox(), denyCorrection = false) {
  let tick = 0;
  let kernelId = 1_000;
  let workId = 2_000;
  const clock = { now: () => new Date(Date.parse("2026-08-11T14:00:00.000Z") + tick++).toISOString() };
  return createKernelCommandExecutor({
    feature_enabled: true,
    project_root: root,
    project_id: PROJECT,
    definitions: createNativeWorkCommandDefinitions({
      clock,
      ids: { event: () => id("event", workId++) },
    }),
    principal_resolver: { resolve: async (principalId) => ({ principal_id: principalId, active: true, attributes: {} }) },
    authorizer: {
      authorize: async (context) => context.command_name === NATIVE_WORK_COMMANDS.correct && denyCorrection
        ? { allowed: false, reason_code: "reopen_authority_required" }
        : { allowed: true, reason_code: "allowed" },
    },
    outbox,
    clock,
    ids: {
      event: () => id("event", kernelId++),
      receipt: () => id("receipt", kernelId++),
    },
  });
}

function command(
  seed: number,
  commandName: string,
  payload: KernelCommandRequest["payload"],
  expected: ProjectTransactionDigest | null,
  key = `${commandName}:${seed}`,
): KernelCommandRequest {
  return {
    command_id: id("command", seed), command_version: "1.0.0", command_name: commandName,
    principal_id: PRINCIPAL, project_id: PROJECT, idempotency_key: key,
    expected_state_version: expected, payload,
  };
}

function openPayload(seed: number, target: string, expiresAt = "2026-08-11T14:30:00.000Z") {
  return {
    intent_id: id("intent", seed), episode_id: id("episode", seed + 1),
    scope_claim_id: id("claim", seed + 2), receipt_id: id("receipt", seed + 3),
    lease_id: id("lease", seed + 4), title: `Intent ${seed}`, goal: `Episode ${seed}`,
    scope_statement: `Own ${target}`, target, lease_expires_at: expiresAt,
  };
}

function finishPayload(seed: number, opened: ReturnType<typeof openPayload>, handoff: boolean) {
  return {
    intent_id: opened.intent_id, episode_id: opened.episode_id, lease_id: opened.lease_id,
    outcome_claim_id: id("claim", seed + 1), receipt_id: id("receipt", seed + 2),
    summary: "Vertical slice completed", evidence_digests: [DIGEST],
    handoff: handoff ? { recipient_principal_id: RECIPIENT, message: "Continue with the proof matrix." } : null,
  };
}

async function readProjection(root: string) {
  return reduceWorkProjection(await scanProjectTransactions(root, PROJECT));
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-native-work-"));
  roots.push(root);
  return root;
}
