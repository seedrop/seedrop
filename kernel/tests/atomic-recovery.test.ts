import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_WORK_COMMANDS,
  buildOutboxDeliveryReceipt,
  generateCanonicalId,
} from "@seedrop/protocol";
import type {
  CanonicalIdKind,
  OutboxDeliveryReceipt,
  OutboxEffect,
  ProjectTransactionDigest,
} from "@seedrop/protocol";
import {
  queryWorkReceipts,
  reduceProjectTransactions,
  reduceWorkProjection,
  scanProjectTransactions,
} from "@seedrop/project";
import {
  KERNEL_ATOMIC_RECOVERY_MATRIX,
  createKernelCommandExecutor,
  createNativeWorkCommandDefinitions,
} from "../src/index.js";
import type {
  KernelAtomicRecoveryBoundary,
  KernelCommandRequest,
  KernelEffectOutbox,
  KernelExecutorOptions,
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
const EVIDENCE = `sha256:${"ab".repeat(32)}` as ProjectTransactionDigest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native command atomic crash and recovery matrix", () => {
  it("enumerates every kernel, commit, publish, and effect boundary exactly once", () => {
    const boundaries = KERNEL_ATOMIC_RECOVERY_MATRIX.map((entry) => entry.boundary);
    expect(Object.isFrozen(KERNEL_ATOMIC_RECOVERY_MATRIX)).toBe(true);
    expect(KERNEL_ATOMIC_RECOVERY_MATRIX.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(boundaries).toHaveLength(16);
    expect(new Set(boundaries).size).toBe(boundaries.length);
    expect(boundaries).toEqual([
      "kernel.before_authorization",
      "kernel.after_validation",
      "kernel.before_commit",
      "project.after_lock_acquired",
      "project.after_snapshot",
      "publish.before_temp_write",
      "publish.after_temp_write",
      "publish.after_file_sync",
      "publish.after_publish",
      "publish.after_directory_sync",
      "project.after_transaction_publish",
      "project.after_projection",
      "kernel.after_commit",
      "kernel.before_effect",
      "kernel.after_effect",
      "kernel.before_receipt",
    ]);
  });

  it.each(KERNEL_ATOMIC_RECOVERY_MATRIX)(
    "$boundary exposes $process_restart_visibility and recovers by $restart_action",
    async (proof) => {
      const root = await tempRoot();
      const outbox = new ProofOutbox();
      const openedPayload = openPayload();
      const opened = await executor(root, outbox, 1_000).execute(command(
        10,
        NATIVE_WORK_COMMANDS.open,
        openedPayload,
        null,
      ));
      const finishedPayload = finishPayload(openedPayload);
      const finish = command(
        20,
        NATIVE_WORK_COMMANDS.finish,
        finishedPayload,
        opened.transaction_digest,
        "finish-atomic-proof",
      );
      const failing = executor(root, outbox, 3_000, injectedFault(proof.boundary));

      await expect(failing.execute(finish)).rejects.toThrow(`crash:${proof.boundary}`);

      const afterCrash = await scanProjectTransactions(root, PROJECT);
      const committed = proof.process_restart_visibility === "whole";
      expect(afterCrash.transactions.filter((entry) => entry.transaction.command_id === finish.command_id))
        .toHaveLength(committed ? 1 : 0);
      expect(afterCrash.transactions).toHaveLength(committed ? 2 : 1);
      const crashedProject = reduceProjectTransactions(afterCrash);
      expect(crashedProject.quarantined).toEqual([]);
      expect(crashedProject.lag.complete).toBe(true);
      expect(afterCrash.diagnostics.some((item) => item.code === "uncommitted_temp"))
        .toBe(proof.boundary.startsWith("publish."));

      const crashedWork = reduceWorkProjection(afterCrash);
      expect(crashedWork.intents[0]?.state).toBe(committed ? "reported_complete" : "active");
      expect(crashedWork.episodes[0]?.state).toBe(committed ? "reported_complete" : "active");
      expect(crashedWork.leases[0]?.state).toBe(committed ? "released" : "active");
      expect(crashedWork.claims.some((claim) => claim.claim_id === finishedPayload.outcome_claim_id)).toBe(committed);
      expect(queryWorkReceipts(crashedWork, { receipt_kind: "episode_finished" }))
        .toHaveLength(committed ? 1 : 0);

      const restarted = executor(root, outbox, 5_000);
      const recovered = proof.restart_action === "recover"
        ? await restarted.recover({ command_id: finish.command_id, actor_principal_id: PRINCIPAL })
        : await restarted.execute(finish);

      expect(recovered.receipt.outcome).toBe("completed");
      expect(recovered.recovered).toBe(proof.restart_action === "recover");
      const finalScan = await scanProjectTransactions(root, PROJECT);
      expect(finalScan.transactions).toHaveLength(2);
      expect(finalScan.transactions.filter((entry) => entry.transaction.command_id === finish.command_id)).toHaveLength(1);
      expect(reduceProjectTransactions(finalScan).lag.complete).toBe(true);
      const finalWork = reduceWorkProjection(finalScan);
      expect(finalWork.intents[0]?.state).toBe("reported_complete");
      expect(finalWork.episodes[0]?.state).toBe("reported_complete");
      expect(finalWork.leases[0]?.state).toBe("released");
      expect(finalWork.claims.some((claim) => claim.claim_id === finishedPayload.outcome_claim_id)).toBe(true);
      expect(queryWorkReceipts(finalWork, { receipt_kind: "episode_finished" })).toHaveLength(1);
      expect(outbox.receipts.size).toBe(1);
      expect(outbox.logicalDeliveries).toBe(1);
      expect(outbox.dispatchCalls).toBe(
        proof.effect_state === "delivery_may_have_completed" ? 2 : 1,
      );
    },
  );
});

class ProofOutbox implements KernelEffectOutbox {
  readonly receipts = new Map<string, OutboxDeliveryReceipt>();
  dispatchCalls = 0;
  logicalDeliveries = 0;

  async dispatch(effect: OutboxEffect): Promise<OutboxDeliveryReceipt> {
    this.dispatchCalls += 1;
    const existing = this.receipts.get(effect.effect_key);
    if (existing) return existing;
    this.logicalDeliveries += 1;
    const receipt = buildOutboxDeliveryReceipt({
      receipt_id: id("receipt", 9_000 + this.logicalDeliveries),
      effect_id: effect.effect_id,
      effect_key: effect.effect_key,
      command_id: effect.command_id,
      project_id: effect.project_id,
      state: "delivered",
      attempt: 1,
      recorded_at: new Date(Date.parse(effect.declared_at) + 1_000).toISOString(),
      evidence_digest: effect.payload_digest,
      error: null,
    });
    this.receipts.set(effect.effect_key, receipt);
    return receipt;
  }
}

function executor(
  root: string,
  outbox: KernelEffectOutbox,
  idSeed: number,
  faults: Pick<KernelExecutorOptions, "fault" | "project_fault" | "publish_fault"> = {},
) {
  let tick = 0;
  let kernelId = idSeed;
  let workId = idSeed + 500;
  const clock = {
    now: () => new Date(Date.parse("2026-08-11T14:00:00.000Z") + idSeed + tick++).toISOString(),
  };
  return createKernelCommandExecutor({
    feature_enabled: true,
    project_root: root,
    project_id: PROJECT,
    definitions: createNativeWorkCommandDefinitions({
      clock,
      ids: { event: () => id("event", workId++) },
    }),
    principal_resolver: {
      resolve: async (principalId) => ({ principal_id: principalId, active: true, attributes: {} }),
    },
    authorizer: { authorize: async () => ({ allowed: true, reason_code: "allowed" }) },
    outbox,
    clock,
    ids: {
      event: () => id("event", kernelId++),
      receipt: () => id("receipt", kernelId++),
    },
    ...faults,
  });
}

function injectedFault(
  target: KernelAtomicRecoveryBoundary,
): Pick<KernelExecutorOptions, "fault" | "project_fault" | "publish_fault"> {
  let injected = false;
  const crash = (observed: KernelAtomicRecoveryBoundary) => {
    if (!injected && observed === target) {
      injected = true;
      throw new Error(`crash:${target}`);
    }
  };
  return {
    fault: (boundary) => crash(`kernel.${boundary}`),
    project_fault: (boundary) => crash(`project.${boundary}`),
    publish_fault: (boundary) => crash(`publish.${boundary}`),
  };
}

function command(
  seed: number,
  commandName: string,
  payload: KernelCommandRequest["payload"],
  expected: ProjectTransactionDigest | null,
  key = `${commandName}:${seed}`,
): KernelCommandRequest {
  return {
    command_id: id("command", seed),
    command_version: "1.0.0",
    command_name: commandName,
    principal_id: PRINCIPAL,
    project_id: PROJECT,
    idempotency_key: key,
    expected_state_version: expected,
    payload,
  };
}

function openPayload() {
  return {
    intent_id: id("intent", 100),
    episode_id: id("episode", 101),
    scope_claim_id: id("claim", 102),
    receipt_id: id("receipt", 103),
    lease_id: id("lease", 104),
    title: "Atomic recovery proof",
    goal: "Prove the native finish boundary",
    scope_statement: "Own kernel atomic recovery",
    target: "kernel/src/recovery-proof.ts",
    lease_expires_at: "2026-08-11T15:00:00.000Z",
  };
}

function finishPayload(opened: ReturnType<typeof openPayload>) {
  return {
    intent_id: opened.intent_id,
    episode_id: opened.episode_id,
    lease_id: opened.lease_id,
    outcome_claim_id: id("claim", 201),
    receipt_id: id("receipt", 202),
    summary: "All physical boundaries recover atomically.",
    evidence_digests: [EVIDENCE],
    handoff: {
      recipient_principal_id: RECIPIENT,
      message: "Continue with concurrency and idempotency proof.",
    },
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-kernel-atomic-recovery-"));
  roots.push(root);
  return root;
}
