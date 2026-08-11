import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProtocolError,
  buildOutboxDeliveryReceipt,
  buildRepairReceipt,
  canonicalJsonDigest,
  generateCanonicalId,
  protocolError,
} from "@seedrop/protocol";
import type {
  CanonicalId,
  OutboxDeliveryReceipt,
  OutboxEffect,
  ProjectTransactionDigest,
} from "@seedrop/protocol";
import { scanProjectTransactions } from "@seedrop/project";
import {
  createKernelCommandExecutor,
} from "../src/index.js";
import type {
  KernelCommandDefinition,
  KernelCommandRequest,
  KernelEffectOutbox,
  KernelExecutorOptions,
} from "../src/index.js";

const roots: string[] = [];
const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff);
const id = <K extends "principal" | "project" | "command" | "event" | "receipt" | "intent" | "claim">(
  kind: K,
  seed: number,
) => generateCanonicalId(kind, { now: 1_723_379_696_000 + seed, entropy: entropy(seed) });

const PROJECT = id("project", 1);
const PRINCIPAL = id("principal", 2);
const INTENT = id("intent", 3);
const DIGEST_A = `sha256:${"aa".repeat(32)}` as ProjectTransactionDigest;
const DIGEST_B = `sha256:${"bb".repeat(32)}` as ProjectTransactionDigest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("feature-gated kernel command execution", () => {
  it("creates no project truth while the v2 feature is disabled", async () => {
    const root = await tempRoot();
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox(), { feature_enabled: false }));
    await expect(executor.execute(request(10))).rejects.toMatchObject({ code: "seedrop.protocol.command_feature_disabled" });
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(0);
  });

  it("resolves identity, authorizes, and validates before any durable effect", async () => {
    const root = await tempRoot();
    const denied = createKernelCommandExecutor(options(root, new FakeOutbox(), {
      authorizer: { authorize: async () => ({ allowed: false, reason_code: "membership_required" }) },
    }));
    await expect(denied.execute(request(11))).rejects.toMatchObject({
      code: "seedrop.protocol.command_unauthorized",
      details: { reason: "membership_required" },
    });
    const invalidDefinition = definition({
      validate: () => { throw protocolError("seedrop.protocol.command_request_invalid", { field: "payload" }); },
    });
    const invalid = createKernelCommandExecutor(options(root, new FakeOutbox(), { definitions: [invalidDefinition] }));
    await expect(invalid.execute(request(12))).rejects.toMatchObject({ code: "seedrop.protocol.command_request_invalid" });
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(0);
  });

  it("commits one canonical transaction and returns terminal audit and Receipt truth", async () => {
    const root = await tempRoot();
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox()));
    const outcome = await executor.execute(request(13));
    expect(outcome.receipt.outcome).toBe("completed");
    expect(outcome.audit.entries.map((entry) => entry.phase)).toEqual(["accepted", "executing", "completed"]);
    expect(outcome.projection.source_high_watermark).toBe(outcome.transaction_digest);
    expect(outcome.idempotent_replay).toBe(false);
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(1);
  });

  it("binds one scoped idempotency key to the original command and payload", async () => {
    const root = await tempRoot();
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox()));
    const first = await executor.execute(request(14, { idempotency_key: "same-key" }));
    const replay = await executor.execute(request(15, { idempotency_key: "same-key" }));
    expect(replay.command_id).toBe(first.command_id);
    expect(replay.transaction_digest).toBe(first.transaction_digest);
    expect(replay.idempotent_replay).toBe(true);
    await expect(executor.execute(request(16, {
      idempotency_key: "same-key",
      payload: { title: "different" },
    }))).rejects.toMatchObject({ code: "seedrop.protocol.command_idempotency_conflict" });
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(1);
  });

  it("returns a committed replay before applying newer domain validation", async () => {
    const root = await tempRoot();
    let reject = false;
    const replayDefinition = definition({
      validate: () => {
        if (reject) throw protocolError("seedrop.protocol.command_request_invalid", { field: "payload", reason: "new_policy" });
      },
    });
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox(), { definitions: [replayDefinition] }));
    const command = request(161, { idempotency_key: "stable-replay" });
    const first = await executor.execute(command);
    reject = true;
    const replay = await executor.execute({ ...command, command_id: id("command", 162) });
    expect(replay.command_id).toBe(first.command_id);
    expect(replay.idempotent_replay).toBe(true);
  });

  it("keeps an older command Receipt byte-stable after later project commits", async () => {
    const root = await tempRoot();
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox()));
    const firstCommand = request(163, { idempotency_key: "historical-first" });
    const first = await executor.execute(firstCommand);
    await executor.execute(request(164, {
      idempotency_key: "historical-second",
      expected_state_version: first.transaction_digest,
    }));
    const replay = await executor.execute({ ...firstCommand, command_id: id("command", 165) });
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.projection).toEqual(first.projection);
    expect(replay.projection.source_high_watermark).toBe(first.transaction_digest);
  });

  it("lets one of two distinct expected-version writers win without a fork", async () => {
    const root = await tempRoot();
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox()));
    const results = await Promise.allSettled([
      executor.execute(request(17, { idempotency_key: "writer-a" })),
      executor.execute(request(18, { idempotency_key: "writer-b" })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const scan = await scanProjectTransactions(root, PROJECT);
    expect(scan.transactions).toHaveLength(1);
    expect(scan.diagnostics).toEqual([]);
  });

  it("collapses a concurrent duplicate storm to one logical command", async () => {
    const root = await tempRoot();
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox()));
    const outcomes = await Promise.all([
      executor.execute(request(19, { idempotency_key: "storm" })),
      executor.execute(request(20, { idempotency_key: "storm" })),
      executor.execute(request(21, { idempotency_key: "storm" })),
    ]);
    expect(new Set(outcomes.map((outcome) => outcome.command_id)).size).toBe(1);
    expect(new Set(outcomes.map((outcome) => outcome.transaction_digest)).size).toBe(1);
    expect(outcomes.filter((outcome) => outcome.idempotent_replay)).toHaveLength(2);
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(1);
  });
});

describe("outbox and restart recovery", () => {
  it.each([
    ["before_authorization", false],
    ["after_validation", false],
    ["before_commit", false],
    ["after_commit", true],
    ["before_effect", true],
    ["after_effect", true],
    ["before_receipt", true],
  ] as const)("recovers the %s crash boundary with whole transaction visibility", async (target, committed) => {
    const root = await tempRoot();
    const outbox = new FakeOutbox();
    let injected = false;
    const command = request(50 + target.length, { idempotency_key: `fault:${target}` });
    const failing = createKernelCommandExecutor(options(root, outbox, {
      definitions: [definition({ effects: true })],
      fault: (boundary) => {
        if (!injected && boundary === target) {
          injected = true;
          throw new Error(`crash:${target}`);
        }
      },
    }));
    await expect(failing.execute(command)).rejects.toThrow(`crash:${target}`);
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(committed ? 1 : 0);
    const restarted = createKernelCommandExecutor(options(root, outbox, { definitions: [definition({ effects: true })] }));
    const outcome = committed
      ? await restarted.recover({ command_id: command.command_id, actor_principal_id: PRINCIPAL })
      : await restarted.execute(command);
    expect(outcome.receipt.outcome).toBe("completed");
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(1);
    expect(outbox.receipts.size).toBe(1);
  });

  it("commits the outbox declaration with project truth and resumes delivery after restart", async () => {
    const root = await tempRoot();
    const outbox = new FakeOutbox("throw");
    const executor = createKernelCommandExecutor(options(root, outbox, { definitions: [definition({ effects: true })] }));
    const pending = await executor.execute(request(30));
    expect(pending.receipt.outcome).toBe("effects_pending");
    expect(pending.effects).toHaveLength(1);
    expect(pending.audit.entries.at(-1)?.phase).toBe("effects_pending");
    outbox.mode = "delivered";
    const recovered = await executor.recover({ command_id: pending.command_id, actor_principal_id: PRINCIPAL });
    expect(recovered.receipt.outcome).toBe("completed");
    expect(recovered.recovered).toBe(true);
    expect(recovered.transaction_digest).toBe(pending.transaction_digest);
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(1);
  });

  it("recovers a crash after canonical commit without rerunning command planning", async () => {
    const root = await tempRoot();
    let crashed = false;
    const failing = createKernelCommandExecutor(options(root, new FakeOutbox(), {
      fault: (boundary) => {
        if (!crashed && boundary === "after_commit") {
          crashed = true;
          throw new Error("process died");
        }
      },
    }));
    const command = request(31);
    await expect(failing.execute(command)).rejects.toThrow("process died");
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(1);
    const restarted = createKernelCommandExecutor(options(root, new FakeOutbox()));
    const recovered = await restarted.recover({ command_id: command.command_id, actor_principal_id: PRINCIPAL });
    expect(recovered.receipt.outcome).toBe("completed");
    expect(recovered.recovered).toBe(true);
  });

  it("turns a governed dead letter into typed repair-required state", async () => {
    const root = await tempRoot();
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox("dead_letter"), {
      definitions: [definition({ effects: true })],
    }));
    const outcome = await executor.execute(request(32));
    expect(outcome.receipt.outcome).toBe("needs_repair");
    expect(outcome.receipt.error?.code).toBe("effect_poisoned");
    expect(outcome.audit.entries.at(-1)?.phase).toBe("recovery_pending");
  });

  it("treats malformed delivery evidence as repair-required, not transient pending", async () => {
    const root = await tempRoot();
    const corruptOutbox: KernelEffectOutbox = {
      dispatch: async () => ({ state: "delivered" }) as OutboxDeliveryReceipt,
    };
    const executor = createKernelCommandExecutor(options(root, corruptOutbox, {
      definitions: [definition({ effects: true })],
    }));
    const outcome = await executor.execute(request(33));
    expect(outcome.receipt.outcome).toBe("needs_repair");
    expect(outcome.receipt.error?.code).toBe("seedrop.protocol.outbox_delivery_invalid");
  });
});

describe("authorized repair commands", () => {
  it("records a validated repair Receipt inside the canonical transaction", async () => {
    const root = await tempRoot();
    const command = request(40, { command_name: "repair.quarantine.record" });
    const repair = buildRepairReceipt({
      receipt_id: id("receipt", 41),
      repair_command_id: command.command_id,
      project_id: PROJECT,
      actor_principal_id: PRINCIPAL,
      recovery_owner_principal_id: PRINCIPAL,
      issued_at: "2026-08-11T10:00:02.000Z",
      target: { kind: "quarantine", referent: "transactions/bad.json" },
      command: { name: command.command_name, input_digest: canonicalJsonDigest(command.payload) },
      evidence: [{
        record_id: id("claim", 42),
        role: "operator_authorization",
        digest: DIGEST_A,
        observed_at: "2026-08-11T10:00:01.000Z",
      }],
      before: { state_version: "state:1", digest: DIGEST_A },
      after: { state_version: "state:2", digest: DIGEST_B },
      outcome: "applied",
      failure: null,
      rollback: {
        mode: "manual",
        instruction: "append a compensating correction Receipt",
        artifact_digest: null,
        unavailable_reason: null,
      },
      journal: { sequence: 1, previous_receipt_digest: null },
    });
    const repairDefinition = definition({
      command_name: command.command_name,
      kind: "repair",
      repair,
    });
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox(), { definitions: [repairDefinition] }));
    const outcome = await executor.execute(command);
    expect(outcome.receipt.outcome).toBe("completed");
    expect(outcome.transaction.events.some((event) => event.event_type === "seedrop.repair.receipt_recorded")).toBe(true);

    const secondCommand = request(44, {
      command_name: command.command_name,
      expected_state_version: outcome.transaction_digest,
    });
    const { receipt_version: _receiptVersion, ...repairInput } = repair;
    const invalidSecond = buildRepairReceipt({
      ...repairInput,
      receipt_id: id("receipt", 45),
      repair_command_id: secondCommand.command_id,
      issued_at: "2026-08-11T10:00:03.000Z",
      command: { name: secondCommand.command_name, input_digest: canonicalJsonDigest(secondCommand.payload) },
      evidence: [{
        record_id: id("claim", 46),
        role: "operator_authorization",
        digest: DIGEST_A,
        observed_at: "2026-08-11T10:00:02.000Z",
      }],
      journal: { sequence: 1, previous_receipt_digest: null },
    });
    const invalidExecutor = createKernelCommandExecutor(options(root, new FakeOutbox(), {
      definitions: [definition({
        command_name: secondCommand.command_name,
        kind: "repair",
        repair: invalidSecond,
      })],
    }));
    await expect(invalidExecutor.execute(secondCommand)).rejects.toMatchObject({
      code: "seedrop.protocol.repair_journal_invalid",
    });
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(1);
  });

  it("denies repair authority before recording the repair or its evidence", async () => {
    const root = await tempRoot();
    const command = request(43, { command_name: "repair.quarantine.record" });
    const repairDefinition = definition({ command_name: command.command_name, kind: "repair" });
    const executor = createKernelCommandExecutor(options(root, new FakeOutbox(), {
      definitions: [repairDefinition],
      authorizer: {
        authorize: async (context) => ({
          allowed: context.command_kind !== "repair",
          reason_code: "repair_role_required",
        }),
      },
    }));
    await expect(executor.execute(command)).rejects.toMatchObject({
      code: "seedrop.protocol.command_unauthorized",
      details: { reason: "repair_role_required" },
    });
    expect((await scanProjectTransactions(root, PROJECT)).transactions).toHaveLength(0);
  });
});

class FakeOutbox implements KernelEffectOutbox {
  readonly receipts = new Map<string, OutboxDeliveryReceipt>();
  mode: "delivered" | "throw" | "dead_letter";
  private sequence = 200;

  constructor(mode: "delivered" | "throw" | "dead_letter" = "delivered") {
    this.mode = mode;
  }

  async dispatch(effect: OutboxEffect): Promise<OutboxDeliveryReceipt> {
    const existing = this.receipts.get(effect.effect_key);
    if (existing) return existing;
    if (this.mode === "throw") throw new Error("outbox unavailable");
    const dead = this.mode === "dead_letter";
    const receipt = buildOutboxDeliveryReceipt({
      receipt_id: id("receipt", this.sequence++),
      effect_id: effect.effect_id,
      effect_key: effect.effect_key,
      command_id: effect.command_id,
      project_id: effect.project_id,
      state: dead ? "dead_letter" : "delivered",
      attempt: dead ? 3 : 1,
      recorded_at: new Date(Date.parse(effect.declared_at) + 1_000).toISOString(),
      evidence_digest: effect.payload_digest,
      error: dead ? {
        code: "effect_poisoned",
        message: "effect failed permanently",
        retryable: false,
        evidence_digest: effect.payload_digest,
      } : null,
    });
    this.receipts.set(effect.effect_key, receipt);
    return receipt;
  }
}

function options(
  root: string,
  outbox: KernelEffectOutbox,
  overrides: Partial<KernelExecutorOptions> = {},
): KernelExecutorOptions {
  let idSequence = 80;
  let clockSequence = 0;
  return {
    feature_enabled: true,
    project_root: root,
    project_id: PROJECT,
    definitions: [definition()],
    principal_resolver: {
      resolve: async (principalId) => ({ principal_id: principalId, active: true, attributes: {} }),
    },
    authorizer: { authorize: async () => ({ allowed: true, reason_code: "allowed" }) },
    outbox,
    clock: { now: () => new Date(Date.parse("2026-08-11T10:00:00.000Z") + clockSequence++).toISOString() },
    ids: {
      event: () => id("event", idSequence++),
      receipt: () => id("receipt", idSequence++),
    },
    ...overrides,
  };
}

function definition(input: {
  command_name?: string;
  kind?: "mutation" | "repair";
  effects?: boolean;
  repair?: ReturnType<typeof buildRepairReceipt>;
  validate?: KernelCommandDefinition["validate"];
} = {}): KernelCommandDefinition {
  let planSequence = 120;
  return {
    command_name: input.command_name ?? "intent.fixture_create",
    command_version: "1.0.0",
    kind: input.kind ?? "mutation",
    validate: input.validate ?? (() => undefined),
    plan: (context) => ({
      events: [{
        event_id: id("event", planSequence++),
        event_type: "intent.fixture_created",
        subject_id: INTENT,
        occurred_at: "2026-08-11T10:00:02.000Z",
        payload: context.request.payload,
      }],
      effects: input.effects ? [{
        effect_id: id("event", planSequence++),
        effect_key: `notify:${context.request.idempotency_key}`,
        effect_type: "notification.intent.created",
        declared_at: "2026-08-11T10:00:02.000Z",
        required: true,
        payload: { intent_id: INTENT },
      }] : [],
      repair_receipt: input.repair ?? null,
    }),
  };
}

function request(
  seed: number,
  overrides: Partial<KernelCommandRequest> = {},
): KernelCommandRequest {
  return {
    command_id: id("command", seed),
    command_version: "1.0.0",
    command_name: "intent.fixture_create",
    principal_id: PRINCIPAL,
    project_id: PROJECT,
    idempotency_key: `command-${seed}`,
    expected_state_version: null,
    payload: { title: "fixture" },
    ...overrides,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seedrop-kernel-"));
  roots.push(root);
  return root;
}
