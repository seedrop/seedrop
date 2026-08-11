import {
  ProtocolError,
  COMMAND_EXECUTION_EVENT_TYPES,
  assertOutboxDeliveryReceipt,
  assertOutboxEffect,
  assertRepairJournal,
  assertRepairReceipt,
  assertSupportedVersion,
  buildCommandAuditTrail,
  buildCommandCommitReceipt,
  buildOutboxEffect,
  buildProjectEvent,
  buildProjectTransaction,
  canonicalJson,
  canonicalJsonDigest,
  generateCanonicalId,
  parseCanonicalId,
  projectTransactionDigest,
  protocolError,
} from "@seedrop/protocol";
import type {
  BuildProjectEventInput,
  CanonicalId,
  CommandAuditEntry,
  CommandAuditError,
  CommandRecoveryPlan,
  JsonValue,
  OutboxDeliveryReceipt,
  OutboxEffect,
  ProjectEventEnvelope,
  ProjectTransaction,
  ProjectTransactionDigest,
  ProtocolVersion,
  RepairReceipt,
} from "@seedrop/protocol";
import {
  commitProjectTransaction,
  projectProjectionDigest,
  rebuildProjectProjection,
  reduceProjectTransactions,
  scanProjectTransactions,
} from "@seedrop/project";
import type { ProjectLogScan, ProjectProjection, ProjectStoredTransaction } from "@seedrop/project";
import type {
  KernelAuthorizationContext,
  KernelCommandContext,
  KernelCommandDefinition,
  KernelCommandExecutor,
  KernelCommandOutcome,
  KernelCommandPlan,
  KernelCommandRequest,
  KernelExecutorOptions,
  KernelIdFactory,
  KernelRecoveryRequest,
  KernelResolvedPrincipal,
} from "./types.js";

const DEFAULT_RECOVERY_WINDOW_MS = 60_000;
const DEFAULT_ATTEMPT_LIMIT = 3;
const GENESIS_STATE_VERSION = "project:genesis";
const RESERVED_EVENT_TYPES = new Set<string>(Object.values(COMMAND_EXECUTION_EVENT_TYPES));

interface NormalizedOptions extends KernelExecutorOptions {
  clock: NonNullable<KernelExecutorOptions["clock"]>;
  ids: KernelIdFactory;
  recovery_window_ms: number;
  attempt_limit: number;
}

interface LifecycleMetadata {
  accepted: ProjectEventEnvelope;
  executing: ProjectEventEnvelope;
  committed: ProjectEventEnvelope;
  receipt_ids: {
    completed: CanonicalId<"receipt">;
    effects_pending: CanonicalId<"receipt">;
    needs_repair: CanonicalId<"receipt">;
  };
  governed_effect_count: number;
  repair_receipt_id: CanonicalId<"receipt"> | null;
}

export function createKernelCommandExecutor(input: KernelExecutorOptions): KernelCommandExecutor {
  const options = normalizeOptions(input);
  const definitions = commandDefinitions(options.definitions);

  return Object.freeze({
    execute: async (request: KernelCommandRequest) => execute(options, definitions, request),
    recover: async (request: KernelRecoveryRequest) => recover(options, definitions, request),
  });
}

async function execute(
  options: NormalizedOptions,
  definitions: ReadonlyMap<string, KernelCommandDefinition>,
  request: KernelCommandRequest,
): Promise<KernelCommandOutcome> {
  assertFeature(options);
  const definition = validateRequest(options, definitions, request);
  const principal = await resolveAndAuthorize(options, {
    operation: "execute",
    principalId: request.principal_id,
    projectId: request.project_id,
    commandId: request.command_id,
    commandName: request.command_name,
    commandVersion: request.command_version,
    commandKind: definition.kind,
  });
  const inputDigest = canonicalJsonDigest(request.payload) as ProjectTransactionDigest;
  const scan = await scanProjectTransactions(options.project_root, options.project_id);
  const existing = findIdempotentTransaction(scan.transactions, request);
  if (existing) {
    if (existing.transaction.input_digest !== inputDigest
      || existing.transaction.command_version !== request.command_version) {
      throw protocolError("seedrop.protocol.command_idempotency_conflict", {
        original_command_id: existing.transaction.command_id,
        requested_command_id: request.command_id,
        input_digest: inputDigest,
        original_input_digest: existing.transaction.input_digest,
      });
    }
    return materializeOutcome(options, existing, true, false);
  }

  const projection = reduceProjectTransactions(scan);
  if (!projection.lag.complete) {
    throw protocolError("seedrop.protocol.project_transaction_conflict", {
      reason: "projection_incomplete_before_execution",
      quarantine_count: projection.quarantined.length,
    });
  }
  const context: KernelCommandContext = Object.freeze({
    request,
    principal,
    input_digest: inputDigest,
    project_scan: scan,
    project_projection: projection,
  });
  await definition.validate(context);
  await options.fault?.("after_validation");
  if (projection.source_high_watermark !== request.expected_state_version) {
    throw protocolError("seedrop.protocol.project_transaction_conflict", {
      reason: "expected_state_version_mismatch",
      expected: request.expected_state_version,
      observed: projection.source_high_watermark,
    });
  }

  const plan = normalizePlan(await definition.plan(context), definition, request);
  if (plan.repair_receipt) {
    assertRepairJournal([...repairReceipts(scan.transactions), plan.repair_receipt]);
  }
  const transaction = buildTransaction(options, request, inputDigest, plan);
  await options.fault?.("before_commit");
  try {
    await commitProjectTransaction({
      root: options.project_root,
      transaction,
      expected_high_watermark: request.expected_state_version,
    });
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "seedrop.protocol.project_transaction_conflict") {
      const rescanned = await scanProjectTransactions(options.project_root, options.project_id);
      const winner = findIdempotentTransaction(rescanned.transactions, request);
      if (winner && winner.transaction.input_digest === inputDigest
        && winner.transaction.command_version === request.command_version) {
        return materializeOutcome(options, winner, true, false);
      }
    }
    throw error;
  }
  await options.fault?.("after_commit");
  const digest = projectTransactionDigest(transaction);
  return materializeOutcome(options, {
    digest,
    relative_path: "",
    byte_length: 0,
    transaction,
  }, false, false);
}

async function recover(
  options: NormalizedOptions,
  definitions: ReadonlyMap<string, KernelCommandDefinition>,
  request: KernelRecoveryRequest,
): Promise<KernelCommandOutcome> {
  assertFeature(options);
  parseCanonicalId(request.command_id, "command");
  parseCanonicalId(request.actor_principal_id, "principal");
  const scan = await scanProjectTransactions(options.project_root, options.project_id);
  const matches = scan.transactions.filter((entry) => entry.transaction.command_id === request.command_id);
  if (matches.length !== 1) {
    throw protocolError("seedrop.protocol.command_request_invalid", {
      field: "command_id",
      reason: matches.length === 0 ? "not_found" : "duplicate",
    });
  }
  const stored = matches[0]!;
  const definition = definitions.get(definitionKey(stored.transaction.command_name, stored.transaction.command_version));
  if (!definition) {
    throw protocolError("seedrop.protocol.command_definition_not_found", {
      command_name: stored.transaction.command_name,
      command_version: stored.transaction.command_version,
    });
  }
  await resolveAndAuthorize(options, {
    operation: "recover",
    principalId: request.actor_principal_id,
    projectId: stored.transaction.project_id,
    commandId: stored.transaction.command_id,
    commandName: stored.transaction.command_name,
    commandVersion: stored.transaction.command_version,
    commandKind: definition.kind,
  });
  return materializeOutcome(options, stored, false, true);
}

function buildTransaction(
  options: NormalizedOptions,
  request: KernelCommandRequest,
  inputDigest: ProjectTransactionDigest,
  plan: KernelCommandPlan,
): ProjectTransaction {
  const nextTimestamp = monotonicClock(options.clock.now);
  const acceptedAt = nextTimestamp();
  const executingAt = nextTimestamp();
  const accepted = buildProjectEvent({
    event_id: options.ids.event(),
    event_type: COMMAND_EXECUTION_EVENT_TYPES.accepted,
    subject_id: request.command_id,
    occurred_at: acceptedAt,
    payload: {
      command_name: request.command_name,
      command_version: request.command_version,
      expected_state_version: request.expected_state_version ?? GENESIS_STATE_VERSION,
      input_digest: inputDigest,
    },
  });
  const executing = buildProjectEvent({
    event_id: options.ids.event(),
    event_type: COMMAND_EXECUTION_EVENT_TYPES.executing,
    subject_id: request.command_id,
    occurred_at: executingAt,
    payload: { attempt: 1 },
  });
  const effects = plan.effects.map((effect) => buildOutboxEffect({
    effect_id: effect.effect_id,
    effect_key: effect.effect_key,
    command_id: request.command_id,
    project_id: request.project_id,
    effect_type: effect.effect_type,
    declared_at: effect.declared_at,
    required: effect.required,
    payload: effect.payload,
  }));
  const receiptIds = Object.freeze({
    completed: options.ids.receipt(),
    effects_pending: options.ids.receipt(),
    needs_repair: options.ids.receipt(),
  });
  const committedAt = nextTimestampAfter([
    executingAt,
    ...plan.events.map((event) => event.occurred_at),
    ...effects.map((effect) => effect.declared_at),
    ...(plan.repair_receipt ? [plan.repair_receipt.issued_at] : []),
  ], options.clock.now);
  const committed = buildProjectEvent({
    event_id: options.ids.event(),
    event_type: COMMAND_EXECUTION_EVENT_TYPES.committed,
    subject_id: request.command_id,
    occurred_at: committedAt,
    payload: {
      receipt_ids: receiptIds,
      governed_outbox_effect_count: effects.filter((effect) => effect.required).length,
      repair_receipt_id: plan.repair_receipt?.receipt_id ?? null,
    },
  });
  const outboxEvents = effects.map((effect): ProjectEventEnvelope => buildProjectEvent({
    event_id: effect.effect_id,
    event_type: COMMAND_EXECUTION_EVENT_TYPES.outbox_declared,
    subject_id: request.command_id,
    occurred_at: effect.declared_at,
    payload: effect as unknown as JsonValue,
  }));
  const repairEvents: ProjectEventEnvelope[] = plan.repair_receipt ? [buildProjectEvent({
    event_id: options.ids.event(),
    event_type: COMMAND_EXECUTION_EVENT_TYPES.repair_recorded,
    subject_id: plan.repair_receipt.receipt_id,
    occurred_at: plan.repair_receipt.issued_at,
    payload: plan.repair_receipt as unknown as JsonValue,
  })] : [];
  return buildProjectTransaction({
    command_id: request.command_id,
    command_version: request.command_version,
    command_name: request.command_name,
    principal_id: request.principal_id,
    project_id: request.project_id,
    idempotency_key: request.idempotency_key,
    input_digest: inputDigest,
    previous_transaction_digest: request.expected_state_version,
    recorded_at: committedAt,
    events: [accepted, executing, ...plan.events, ...outboxEvents, ...repairEvents, committed],
  });
}

async function materializeOutcome(
  options: NormalizedOptions,
  stored: ProjectStoredTransaction,
  idempotentReplay: boolean,
  recovered: boolean,
): Promise<KernelCommandOutcome> {
  const currentScan = await scanProjectTransactions(options.project_root, options.project_id);
  const currentProjection = reduceProjectTransactions(currentScan);
  if (!currentProjection.lag.complete || currentProjection.source_high_watermark === null) {
    throw protocolError("seedrop.protocol.project_projection_inconsistent", {
      reason: "cannot_materialize_committed_command",
      quarantine_count: currentProjection.quarantined.length,
    });
  }
  await rebuildProjectProjection(options.project_root, options.project_id);
  const projection = projectionAtTransaction(currentScan, currentProjection, stored.digest);
  const lifecycle = lifecycleMetadata(stored.transaction);
  const effects = extractEffects(stored.transaction);
  const deliveries: OutboxDeliveryReceipt[] = [];
  const pending: OutboxEffect[] = [];
  const deliveryFailures = new Map<string, CommandAuditError>();
  for (const effect of effects) {
    await options.fault?.("before_effect", effect.effect_key);
    try {
      const receipt = await options.outbox.dispatch(effect);
      assertDeliveryMatches(effect, receipt);
      deliveries.push(receipt);
    } catch (error) {
      if (error instanceof ProtocolError && !error.retryable) {
        deliveryFailures.set(effect.effect_key, {
          code: error.code,
          message: error.message,
          retryable: false,
          evidence_digest: null,
        });
      } else {
        pending.push(effect);
      }
    }
    await options.fault?.("after_effect", effect.effect_key);
  }
  const governed = effects.filter((effect) => effect.required);
  if (lifecycle.governed_effect_count !== governed.length) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", {
      reason: "governed_effect_count_mismatch",
      declared: lifecycle.governed_effect_count,
      observed: governed.length,
    });
  }
  const governedDeliveries = deliveries.filter((receipt) => (
    governed.some((effect) => effect.effect_key === receipt.effect_key)
  ));
  const deadLetter = governedDeliveries.find((receipt) => receipt.state === "dead_letter");
  const deliveryFailure = governed.map((effect) => deliveryFailures.get(effect.effect_key)).find(Boolean) ?? null;
  const deliveredCount = governedDeliveries.filter((receipt) => receipt.state === "delivered").length;
  const governedPending = governed.filter((effect) => (
    pending.some((item) => item.effect_key === effect.effect_key)
    || !governedDeliveries.some((receipt) => receipt.effect_key === effect.effect_key)
  ));
  const outcome = deadLetter || deliveryFailure ? "needs_repair" : governedPending.length > 0 ? "effects_pending" : "completed";
  const phase = outcome === "needs_repair" ? "recovery_pending" : outcome;
  const projectionDigest = projectProjectionDigest(projection);
  const finalAt = latestTimestamp([
    lifecycle.committed.occurred_at,
    ...governedDeliveries.map((receipt) => receipt.recorded_at),
  ]);
  const recovery = outcome === "completed" ? null : recoveryPlan(
    stored.transaction.principal_id,
    stored.transaction.command_id,
    finalAt,
    options,
  );
  const error: CommandAuditError | null = deadLetter?.error ?? deliveryFailure ?? (outcome === "needs_repair" ? {
    code: "outbox_dead_letter",
    message: "A required outbox effect entered dead-letter state.",
    retryable: false,
    evidence_digest: deadLetter?.evidence_digest ?? null,
  } : null);
  const audit = buildAudit(
    stored.transaction,
    stored.digest,
    projectionDigest,
    lifecycle,
    phase,
    finalAt,
    recovery,
    error,
    options,
  );
  await options.fault?.("before_receipt");
  const receiptId = lifecycle.receipt_ids[outcome];
  const receipt = buildCommandCommitReceipt({
    receipt_id: receiptId,
    command_id: stored.transaction.command_id,
    principal_id: stored.transaction.principal_id,
    project_id: stored.transaction.project_id,
    command_name: stored.transaction.command_name,
    idempotency_key: stored.transaction.idempotency_key,
    input_digest: stored.transaction.input_digest,
    transaction_digest: stored.digest,
    projection_digest: projectionDigest,
    outcome,
    outbox_effect_count: governed.length,
    outbox_delivered_count: deliveredCount,
    recorded_at: finalAt,
    recovery,
    error,
  });
  return deepFreeze({
    command_id: stored.transaction.command_id,
    project_id: stored.transaction.project_id,
    transaction: stored.transaction,
    transaction_digest: stored.digest,
    projection: {
      project_id: projection.project_id,
      projection_version: projection.projection_version,
      source_high_watermark: projection.source_high_watermark,
      source_digest: projection.source_digest,
    },
    audit,
    receipt,
    effects,
    deliveries,
    idempotent_replay: idempotentReplay,
    recovered,
  });
}

function projectionAtTransaction(
  scan: ProjectLogScan,
  current: ProjectProjection,
  target: ProjectTransactionDigest,
): ProjectProjection {
  const index = current.applied.findIndex((entry) => entry.transaction_digest === target);
  if (index < 0) {
    throw protocolError("seedrop.protocol.project_projection_inconsistent", {
      reason: "command_transaction_not_applied",
      transaction_digest: target,
    });
  }
  if (index === current.applied.length - 1) return current;
  const included = new Set(current.applied.slice(0, index + 1).map((entry) => entry.transaction_digest));
  const transactions = scan.transactions.filter((entry) => included.has(entry.digest));
  const paths = new Set(transactions.map((entry) => entry.relative_path));
  return reduceProjectTransactions({
    project_id: scan.project_id,
    transactions,
    sources: scan.sources.filter((source) => paths.has(source.path)),
    diagnostics: [],
  });
}

function buildAudit(
  transaction: ProjectTransaction,
  transactionDigest: ProjectTransactionDigest,
  projectionDigest: ProjectTransactionDigest,
  lifecycle: LifecycleMetadata,
  phase: "completed" | "effects_pending" | "recovery_pending",
  finalAt: string,
  recovery: CommandRecoveryPlan | null,
  error: CommandAuditError | null,
  options: Pick<NormalizedOptions, "recovery_window_ms" | "attempt_limit">,
) {
  const expected = transaction.previous_transaction_digest ?? GENESIS_STATE_VERSION;
  const provisionalRecovery = recoveryPlan(
    transaction.principal_id,
    transaction.command_id,
    finalAt,
    options,
  );
  const entries: CommandAuditEntry[] = [
    {
      event_id: lifecycle.accepted.event_id,
      phase: "accepted",
      recorded_at: lifecycle.accepted.occurred_at,
      expected_state_version: expected,
      result_state_version: null,
      result_digest: null,
      attempt: 0,
      error: null,
      recovery: provisionalRecovery,
    },
    {
      event_id: lifecycle.executing.event_id,
      phase: "executing",
      recorded_at: lifecycle.executing.occurred_at,
      expected_state_version: expected,
      result_state_version: null,
      result_digest: null,
      attempt: 1,
      error: null,
      recovery: provisionalRecovery,
    },
    {
      event_id: lifecycle.committed.event_id,
      phase,
      recorded_at: finalAt,
      expected_state_version: expected,
      result_state_version: transactionDigest,
      result_digest: projectionDigest,
      attempt: 1,
      error,
      recovery,
    },
  ];
  return buildCommandAuditTrail({
    command_id: transaction.command_id,
    command_version: transaction.command_version,
    command_name: transaction.command_name,
    principal_id: transaction.principal_id,
    project_id: transaction.project_id,
    idempotency_key: transaction.idempotency_key,
    input_digest: transaction.input_digest,
    accepted_at: lifecycle.accepted.occurred_at,
    entries,
  });
}

function normalizePlan(
  input: KernelCommandPlan,
  definition: KernelCommandDefinition,
  request: KernelCommandRequest,
): KernelCommandPlan {
  canonicalJson(input);
  if (!input || typeof input !== "object" || !Array.isArray(input.events) || !Array.isArray(input.effects)
    || !("repair_receipt" in input)) {
    throw protocolError("seedrop.protocol.command_request_invalid", { field: "plan", reason: "shape" });
  }
  assertExactKeys(input as unknown as Record<string, unknown>, ["events", "effects", "repair_receipt"], "plan");
  const events = input.events.map((event) => buildProjectEvent(event));
  for (const event of events) {
    if (RESERVED_EVENT_TYPES.has(event.event_type)) {
      throw protocolError("seedrop.protocol.command_request_invalid", {
        field: "plan.events.event_type",
        reason: "reserved",
        event_type: event.event_type,
      });
    }
  }
  const effects = input.effects.map((effect) => Object.freeze({ ...effect }));
  const effectKeys = effects.map((effect) => effect.effect_key);
  const effectIds = effects.map((effect) => effect.effect_id);
  if (new Set(effectKeys).size !== effectKeys.length || new Set(effectIds).size !== effectIds.length) {
    throw protocolError("seedrop.protocol.command_request_invalid", { field: "plan.effects", reason: "duplicate" });
  }
  const repair = input.repair_receipt;
  if (definition.kind === "repair") {
    if (!repair) throw protocolError("seedrop.protocol.command_request_invalid", { field: "repair_receipt", reason: "required" });
    assertRepairReceipt(repair);
    if (repair.repair_command_id !== request.command_id || repair.project_id !== request.project_id
      || repair.actor_principal_id !== request.principal_id
      || repair.command.name !== request.command_name
      || repair.command.input_digest !== canonicalJsonDigest(request.payload)) {
      throw protocolError("seedrop.protocol.command_request_invalid", { field: "repair_receipt", reason: "identity_mismatch" });
    }
  } else if (repair !== null) {
    throw protocolError("seedrop.protocol.command_request_invalid", { field: "repair_receipt", reason: "not_permitted" });
  }
  return deepFreeze({ events, effects, repair_receipt: repair });
}

function lifecycleMetadata(transaction: ProjectTransaction): LifecycleMetadata {
  const accepted = singleEvent(transaction, COMMAND_EXECUTION_EVENT_TYPES.accepted);
  const executing = singleEvent(transaction, COMMAND_EXECUTION_EVENT_TYPES.executing);
  const committed = singleEvent(transaction, COMMAND_EXECUTION_EVENT_TYPES.committed);
  if (accepted.subject_id !== transaction.command_id || executing.subject_id !== transaction.command_id
    || committed.subject_id !== transaction.command_id
    || !(accepted.occurred_at < executing.occurred_at && executing.occurred_at < committed.occurred_at)) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", { reason: "lifecycle_envelope_mismatch" });
  }
  const acceptedPayload = asExactRecord(accepted.payload, [
    "command_name", "command_version", "expected_state_version", "input_digest",
  ], "accepted.payload");
  if (acceptedPayload.command_name !== transaction.command_name
    || acceptedPayload.command_version !== transaction.command_version
    || acceptedPayload.input_digest !== transaction.input_digest
    || acceptedPayload.expected_state_version !== (transaction.previous_transaction_digest ?? GENESIS_STATE_VERSION)) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", { reason: "accepted_payload_mismatch" });
  }
  const executingPayload = asExactRecord(executing.payload, ["attempt"], "executing.payload");
  if (executingPayload.attempt !== 1) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", { reason: "executing_attempt_mismatch" });
  }
  const payload = asExactRecord(committed.payload, [
    "receipt_ids", "governed_outbox_effect_count", "repair_receipt_id",
  ], "committed.payload");
  const receiptIds = asRecord(payload.receipt_ids, "committed.payload.receipt_ids");
  assertExactKeys(receiptIds, ["completed", "effects_pending", "needs_repair"], "committed.payload.receipt_ids");
  const completed = parseCanonicalId(String(receiptIds.completed), "receipt").value;
  const effectsPending = parseCanonicalId(String(receiptIds.effects_pending), "receipt").value;
  const needsRepair = parseCanonicalId(String(receiptIds.needs_repair), "receipt").value;
  if (!Number.isSafeInteger(payload.governed_outbox_effect_count) || (payload.governed_outbox_effect_count as number) < 0) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", { reason: "governed_effect_count_invalid" });
  }
  const repairReceiptId = payload.repair_receipt_id === null
    ? null
    : parseCanonicalId(String(payload.repair_receipt_id), "receipt").value;
  const repairEvents = transaction.events.filter((event) => event.event_type === COMMAND_EXECUTION_EVENT_TYPES.repair_recorded);
  if ((repairReceiptId === null) !== (repairEvents.length === 0) || repairEvents.length > 1) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", { reason: "repair_event_count_mismatch" });
  }
  if (repairReceiptId !== null) {
    const repair = repairEvents[0]!.payload as unknown as RepairReceipt;
    assertRepairReceipt(repair);
    if (repair.receipt_id !== repairReceiptId || repairEvents[0]!.subject_id !== repairReceiptId
      || repair.repair_command_id !== transaction.command_id || repair.project_id !== transaction.project_id
      || repair.actor_principal_id !== transaction.principal_id) {
      throw protocolError("seedrop.protocol.command_audit_inconsistent", { reason: "repair_event_mismatch" });
    }
  }
  return deepFreeze({
    accepted,
    executing,
    committed,
    receipt_ids: { completed, effects_pending: effectsPending, needs_repair: needsRepair },
    governed_effect_count: payload.governed_outbox_effect_count as number,
    repair_receipt_id: repairReceiptId,
  });
}

function extractEffects(transaction: ProjectTransaction): readonly OutboxEffect[] {
  const effects = transaction.events
    .filter((event) => event.event_type === COMMAND_EXECUTION_EVENT_TYPES.outbox_declared)
    .map((event) => {
      const effect = event.payload as unknown as OutboxEffect;
      assertOutboxEffect(effect);
      if (effect.effect_id !== event.event_id || effect.command_id !== transaction.command_id
        || effect.project_id !== transaction.project_id || effect.declared_at !== event.occurred_at) {
        throw protocolError("seedrop.protocol.outbox_effect_invalid", { field: "event", reason: "envelope_mismatch" });
      }
      return effect;
    });
  const keys = effects.map((effect) => effect.effect_key);
  if (new Set(keys).size !== keys.length) {
    throw protocolError("seedrop.protocol.outbox_effect_invalid", { field: "effect_key", reason: "duplicate" });
  }
  return Object.freeze(effects);
}

function repairReceipts(transactions: readonly ProjectStoredTransaction[]): readonly RepairReceipt[] {
  return transactions.flatMap((entry) => entry.transaction.events
    .filter((event) => event.event_type === COMMAND_EXECUTION_EVENT_TYPES.repair_recorded)
    .map((event) => {
      const receipt = event.payload as unknown as RepairReceipt;
      assertRepairReceipt(receipt);
      return receipt;
    }));
}

function assertDeliveryMatches(effect: OutboxEffect, receipt: OutboxDeliveryReceipt): void {
  try {
    assertOutboxDeliveryReceipt(receipt);
  } catch (error) {
    if (error instanceof ProtocolError && error.code !== "seedrop.protocol.outbox_delivery_invalid") {
      throw protocolError("seedrop.protocol.outbox_delivery_invalid", {
        field: "receipt",
        reason: "invalid_protocol_shape",
        cause_code: error.code,
      });
    }
    throw error;
  }
  if (receipt.effect_id !== effect.effect_id || receipt.effect_key !== effect.effect_key
    || receipt.command_id !== effect.command_id || receipt.project_id !== effect.project_id
    || receipt.recorded_at < effect.declared_at) {
    throw protocolError("seedrop.protocol.outbox_delivery_invalid", { field: "receipt", reason: "effect_mismatch" });
  }
}

async function resolveAndAuthorize(
  options: NormalizedOptions,
  input: {
    operation: KernelAuthorizationContext["operation"];
    principalId: CanonicalId<"principal">;
    projectId: CanonicalId<"project">;
    commandId: CanonicalId<"command">;
    commandName: string;
    commandVersion: ProtocolVersion;
    commandKind: KernelCommandDefinition["kind"];
  },
): Promise<KernelResolvedPrincipal> {
  await options.fault?.("before_authorization");
  const principal = await options.principal_resolver.resolve(input.principalId, input.projectId);
  canonicalJson(principal);
  assertExactKeys(principal as unknown as Record<string, unknown>, ["principal_id", "active", "attributes"], "principal");
  parseCanonicalId(principal.principal_id, "principal");
  if (typeof principal.active !== "boolean") invalidRequest("principal.active", "boolean_required");
  canonicalJson(principal.attributes);
  if (principal.principal_id !== input.principalId || !principal.active) {
    throw protocolError("seedrop.protocol.command_unauthorized", {
      reason: principal.active ? "resolved_principal_mismatch" : "principal_inactive",
    });
  }
  const decision = await options.authorizer.authorize({
    operation: input.operation,
    principal,
    project_id: input.projectId,
    command_id: input.commandId,
    command_name: input.commandName,
    command_version: input.commandVersion,
    command_kind: input.commandKind,
  });
  canonicalJson(decision);
  assertExactKeys(decision as unknown as Record<string, unknown>, ["allowed", "reason_code"], "authorization");
  if (typeof decision.allowed !== "boolean" || typeof decision.reason_code !== "string"
    || decision.reason_code.trim().length === 0) {
    invalidRequest("authorization", "invalid_decision");
  }
  if (!decision.allowed) {
    throw protocolError("seedrop.protocol.command_unauthorized", { reason: decision.reason_code });
  }
  return principal;
}

function validateRequest(
  options: NormalizedOptions,
  definitions: ReadonlyMap<string, KernelCommandDefinition>,
  request: KernelCommandRequest,
): KernelCommandDefinition {
  canonicalJson(request);
  assertExactKeys(request as unknown as Record<string, unknown>, [
    "command_id", "command_version", "command_name", "principal_id", "project_id",
    "idempotency_key", "expected_state_version", "payload",
  ], "request");
  parseCanonicalId(request.command_id, "command");
  parseCanonicalId(request.principal_id, "principal");
  parseCanonicalId(request.project_id, "project");
  if (request.project_id !== options.project_id) invalidRequest("project_id", "executor_project_mismatch");
  const version = assertSupportedVersion("command", request.command_version);
  if (typeof request.command_name !== "string" || request.command_name.trim().length === 0) invalidRequest("command_name", "required");
  if (typeof request.idempotency_key !== "string" || request.idempotency_key.trim().length === 0) invalidRequest("idempotency_key", "required");
  if (request.expected_state_version !== null && !/^sha256:[0-9a-f]{64}$/.test(request.expected_state_version)) {
    invalidRequest("expected_state_version", "sha256_or_null_required");
  }
  canonicalJson(request.payload);
  const definition = definitions.get(definitionKey(request.command_name, version));
  if (!definition) {
    throw protocolError("seedrop.protocol.command_definition_not_found", {
      command_name: request.command_name,
      command_version: version,
    });
  }
  return definition;
}

function findIdempotentTransaction(
  transactions: readonly ProjectStoredTransaction[],
  request: KernelCommandRequest,
): ProjectStoredTransaction | null {
  const matches = transactions.filter((entry) => (
    entry.transaction.project_id === request.project_id
    && entry.transaction.principal_id === request.principal_id
    && entry.transaction.command_name === request.command_name
    && entry.transaction.idempotency_key === request.idempotency_key
  ));
  if (matches.length > 1) {
    throw protocolError("seedrop.protocol.project_transaction_conflict", {
      reason: "duplicate_idempotency_scope",
      match_count: matches.length,
    });
  }
  return matches[0] ?? null;
}

function commandDefinitions(definitions: readonly KernelCommandDefinition[]): ReadonlyMap<string, KernelCommandDefinition> {
  const result = new Map<string, KernelCommandDefinition>();
  for (const definition of definitions) {
    if (!definition || typeof definition.command_name !== "string" || definition.command_name.trim().length === 0) {
      invalidRequest("definitions.command_name", "required");
    }
    const version = assertSupportedVersion("command", definition.command_version);
    if (definition.kind !== "mutation" && definition.kind !== "repair") invalidRequest("definitions.kind", "unknown");
    const key = definitionKey(definition.command_name, version);
    if (result.has(key)) invalidRequest("definitions", "duplicate");
    result.set(key, Object.freeze({ ...definition, command_version: version }));
  }
  return result;
}

function normalizeOptions(input: KernelExecutorOptions): NormalizedOptions {
  if (typeof input.feature_enabled !== "boolean") invalidRequest("feature_enabled", "boolean_required");
  parseCanonicalId(input.project_id, "project");
  if (typeof input.project_root !== "string" || input.project_root.trim().length === 0) invalidRequest("project_root", "required");
  if (!Array.isArray(input.definitions)) invalidRequest("definitions", "array_required");
  if (!input.principal_resolver || typeof input.principal_resolver.resolve !== "function") invalidRequest("principal_resolver", "required");
  if (!input.authorizer || typeof input.authorizer.authorize !== "function") invalidRequest("authorizer", "required");
  if (!input.outbox || typeof input.outbox.dispatch !== "function") invalidRequest("outbox", "required");
  const recoveryWindow = positiveInteger(input.recovery_window_ms, DEFAULT_RECOVERY_WINDOW_MS, "recovery_window_ms");
  const attemptLimit = positiveInteger(input.attempt_limit, DEFAULT_ATTEMPT_LIMIT, "attempt_limit");
  if (attemptLimit < 2) invalidRequest("attempt_limit", "minimum_two");
  return Object.freeze({
    ...input,
    definitions: Object.freeze([...input.definitions]),
    clock: input.clock ?? { now: () => new Date().toISOString() },
    ids: input.ids ?? {
      event: () => generateCanonicalId("event"),
      receipt: () => generateCanonicalId("receipt"),
    },
    recovery_window_ms: recoveryWindow,
    attempt_limit: attemptLimit,
  });
}

function recoveryPlan(
  owner: CanonicalId<"principal">,
  commandId: CanonicalId<"command">,
  from: string,
  options: Pick<NormalizedOptions, "recovery_window_ms" | "attempt_limit">,
): CommandRecoveryPlan {
  return Object.freeze({
    owner_principal_id: owner,
    action: `recover command ${commandId}`,
    recover_by: new Date(Date.parse(from) + options.recovery_window_ms).toISOString(),
    attempt_limit: options.attempt_limit,
  });
}

function singleEvent(transaction: ProjectTransaction, eventType: string): ProjectEventEnvelope {
  const events = transaction.events.filter((event) => event.event_type === eventType);
  if (events.length !== 1) {
    throw protocolError("seedrop.protocol.command_audit_inconsistent", {
      reason: "lifecycle_event_count",
      event_type: eventType,
      count: events.length,
    });
  }
  return events[0]!;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRequest(field, "object_required");
  return value as Record<string, unknown>;
}

function asExactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const record = asRecord(value, field);
  assertExactKeys(record, keys, field);
  return record;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidRequest(field, "exact_shape_required");
  }
}

function nextTimestampAfter(values: readonly string[], now: () => string): string {
  const latest = latestTimestamp(values);
  const candidate = canonicalTimestamp(now());
  return new Date(Math.max(Date.parse(candidate), Date.parse(latest) + 1)).toISOString();
}

function monotonicClock(now: () => string): () => string {
  let previous = -1;
  return () => {
    const candidate = Date.parse(canonicalTimestamp(now()));
    previous = Math.max(candidate, previous + 1);
    return new Date(previous).toISOString();
  };
}

function canonicalTimestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalidRequest("clock", "invalid_timestamp");
  return new Date(value).toISOString();
}

function latestTimestamp(values: readonly string[]): string {
  if (values.length === 0) invalidRequest("timestamps", "nonempty_required");
  return new Date(Math.max(...values.map((value) => Date.parse(canonicalTimestamp(value))))).toISOString();
}

function definitionKey(name: string, version: string): string {
  return `${name}\u0000${version}`;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) invalidRequest(field, "positive_integer_required");
  return result;
}

function assertFeature(options: NormalizedOptions): void {
  if (!options.feature_enabled) throw protocolError("seedrop.protocol.command_feature_disabled", { feature: "seedrop_v2_kernel" });
}

function invalidRequest(field: string, reason: string): never {
  throw protocolError("seedrop.protocol.command_request_invalid", { field, reason });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
