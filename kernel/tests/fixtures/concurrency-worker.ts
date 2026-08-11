import {
  NATIVE_WORK_COMMANDS,
  ProtocolError,
  buildProjectEvent,
  buildProjectTransaction,
  generateCanonicalId,
} from "@seedrop/protocol";
import type {
  CanonicalIdKind,
  OutboxDeliveryReceipt,
  OutboxEffect,
  ProjectTransactionDigest,
} from "@seedrop/protocol";
import {
  commitProjectTransaction,
  reduceProjectTransactions,
  scanProjectTransactions,
} from "@seedrop/project";
import {
  createKernelCommandExecutor,
  createNativeWorkCommandDefinitions,
} from "../../src/index.js";
import type { KernelCommandRequest, KernelEffectOutbox } from "../../src/index.js";

type Scenario = "cas-append" | "duplicate-open" | "lease-race";

interface WorkerInput {
  scenario: Scenario;
  root: string;
  ordinal: number;
}

const input = parseInput(process.argv.slice(2));
const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff);
const id = <K extends CanonicalIdKind>(kind: K, seed: number) => generateCanonicalId(kind, {
  now: 1_723_379_696_000 + seed,
  entropy: entropy(seed),
});
const PROJECT = id("project", 1);
const PRINCIPAL = id("principal", 2);
let releaseInitialSnapshot: (() => void) | null = null;
const initialSnapshotReleased = new Promise<void>((resolve) => {
  releaseInitialSnapshot = resolve;
});

process.on("message", (message) => {
  if (message === "commit") {
    releaseInitialSnapshot?.();
    return;
  }
  if (message !== "start") return;
  void run().then(
    (result) => {
      process.send?.({ type: "result", result: { ...result, pid: process.pid } });
      process.disconnect?.();
    },
    (error: unknown) => {
      process.send?.({
        type: "fatal",
        error: {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof ProtocolError ? error.code : null,
        },
      });
      process.disconnect?.();
      process.exitCode = 1;
    },
  );
});

process.send?.({ type: "ready", pid: process.pid });

async function run() {
  if (input.scenario === "cas-append") return appendWithRetry();
  if (input.scenario === "duplicate-open") return executeDuplicateOpen();
  return executeLeaseRace();
}

async function appendWithRetry() {
  const commandId = id("command", 10_000 + input.ordinal);
  let conflicts = 0;
  for (let attempt = 1; attempt <= 256; attempt += 1) {
    const projection = reduceProjectTransactions(await scanProjectTransactions(input.root, PROJECT));
    if (!projection.lag.complete) throw new Error("project projection became incomplete during CAS stress");
    const previous = projection.source_high_watermark;
    if (attempt === 1) {
      process.send?.({ type: "snapshot", high_watermark: previous });
      await initialSnapshotReleased;
    }
    const transaction = buildProjectTransaction({
      command_id: commandId,
      command_version: "1.0.0",
      command_name: "seedrop.proof.concurrent_append",
      principal_id: PRINCIPAL,
      project_id: PROJECT,
      idempotency_key: `cas-append:${input.ordinal}`,
      input_digest: digestFor(input.ordinal),
      previous_transaction_digest: previous,
      recorded_at: new Date(Date.parse("2026-08-11T15:00:00.000Z") + input.ordinal).toISOString(),
      events: [buildProjectEvent({
        event_id: id("event", 20_000 + input.ordinal),
        event_type: "seedrop.proof.concurrent_append",
        subject_id: commandId,
        occurred_at: new Date(Date.parse("2026-08-11T15:00:00.000Z") + input.ordinal).toISOString(),
        payload: { ordinal: input.ordinal },
      })],
    });
    try {
      const receipt = await commitProjectTransaction({
        root: input.root,
        transaction,
        expected_high_watermark: previous,
      });
      return {
        scenario: input.scenario,
        status: "committed",
        ordinal: input.ordinal,
        command_id: commandId,
        transaction_digest: receipt.transaction.digest,
        attempts: attempt,
        conflicts,
      };
    } catch (error) {
      if (!(error instanceof ProtocolError)
        || error.code !== "seedrop.protocol.project_transaction_conflict") throw error;
      conflicts += 1;
      await delay(1 + ((input.ordinal + attempt) % 11));
    }
  }
  throw new Error(`CAS retry budget exhausted for writer ${input.ordinal}`);
}

async function executeDuplicateOpen() {
  const request = openRequest({
    ordinal: input.ordinal,
    idempotencyKey: "duplicate-open:shared",
    sharedPayload: true,
    target: "proof/duplicate-target",
  });
  const outcome = await executor(30_000 + input.ordinal).execute(request);
  return {
    scenario: input.scenario,
    status: "completed",
    ordinal: input.ordinal,
    requested_command_id: request.command_id,
    command_id: outcome.command_id,
    transaction_digest: outcome.transaction_digest,
    idempotent_replay: outcome.idempotent_replay,
  };
}

async function executeLeaseRace() {
  const request = openRequest({
    ordinal: input.ordinal,
    idempotencyKey: `lease-race:${input.ordinal}`,
    sharedPayload: false,
    target: "proof/shared-lease-target",
  });
  try {
    const outcome = await executor(40_000 + input.ordinal).execute(request);
    return {
      scenario: input.scenario,
      status: "completed",
      ordinal: input.ordinal,
      command_id: outcome.command_id,
      transaction_digest: outcome.transaction_digest,
      error_code: null,
    };
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    return {
      scenario: input.scenario,
      status: "conflict",
      ordinal: input.ordinal,
      command_id: request.command_id,
      transaction_digest: null,
      error_code: error.code,
      reason: typeof error.details.reason === "string" ? error.details.reason : null,
    };
  }
}

function executor(seed: number) {
  let tick = 0;
  let kernelId = seed;
  let workId = seed + 1_000;
  const clock = {
    now: () => new Date(Date.parse("2026-08-11T14:00:00.000Z") + seed + tick++).toISOString(),
  };
  return createKernelCommandExecutor({
    feature_enabled: true,
    project_root: input.root,
    project_id: PROJECT,
    definitions: createNativeWorkCommandDefinitions({
      clock,
      ids: { event: () => id("event", workId++) },
    }),
    principal_resolver: {
      resolve: async (principalId) => ({ principal_id: principalId, active: true, attributes: {} }),
    },
    authorizer: { authorize: async () => ({ allowed: true, reason_code: "allowed" }) },
    outbox: new NoEffectOutbox(),
    clock,
    ids: {
      event: () => id("event", kernelId++),
      receipt: () => id("receipt", kernelId++),
    },
  });
}

class NoEffectOutbox implements KernelEffectOutbox {
  async dispatch(_effect: OutboxEffect): Promise<OutboxDeliveryReceipt> {
    throw new Error("open command must not dispatch an outbox effect");
  }
}

function openRequest(options: {
  ordinal: number;
  idempotencyKey: string;
  sharedPayload: boolean;
  target: string;
}): KernelCommandRequest {
  const payloadSeed = options.sharedPayload ? 50_000 : 50_000 + (options.ordinal * 10);
  return {
    command_id: id("command", 60_000 + options.ordinal),
    command_version: "1.0.0",
    command_name: NATIVE_WORK_COMMANDS.open,
    principal_id: PRINCIPAL,
    project_id: PROJECT,
    idempotency_key: options.idempotencyKey,
    expected_state_version: null,
    payload: {
      intent_id: id("intent", payloadSeed),
      episode_id: id("episode", payloadSeed + 1),
      scope_claim_id: id("claim", payloadSeed + 2),
      receipt_id: id("receipt", payloadSeed + 3),
      lease_id: id("lease", payloadSeed + 4),
      title: options.sharedPayload ? "Shared duplicate command" : `Lease contender ${options.ordinal}`,
      goal: options.sharedPayload ? "Resolve one logical duplicate" : `Acquire target as writer ${options.ordinal}`,
      scope_statement: `Own ${options.target}`,
      target: options.target,
      lease_expires_at: "2026-08-11T16:00:00.000Z",
    },
  };
}

function parseInput(argv: readonly string[]): WorkerInput {
  const [scenario, root, ordinalText] = argv;
  const ordinal = Number(ordinalText);
  if ((scenario !== "cas-append" && scenario !== "duplicate-open" && scenario !== "lease-race")
    || !root || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("usage: concurrency-worker <cas-append|duplicate-open|lease-race> <root> <ordinal>");
  }
  return { scenario, root, ordinal };
}

function digestFor(ordinal: number): ProjectTransactionDigest {
  return `sha256:${ordinal.toString(16).padStart(64, "0")}` as ProjectTransactionDigest;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
