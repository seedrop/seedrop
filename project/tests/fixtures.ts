import {
  buildProjectTransaction,
  generateCanonicalId,
} from "@seedrop/protocol";
import type {
  CanonicalId,
  ProjectTransaction,
  ProjectTransactionDigest,
} from "@seedrop/protocol";

const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => (seed + index) & 0xff);
export const makeId = <K extends "principal" | "project" | "command" | "event" | "intent">(
  kind: K,
  seed: number,
) => generateCanonicalId(kind, { now: 1_723_379_696_000 + seed, entropy: entropy(seed) });

export const PROJECT_ID = makeId("project", 100);
export const OTHER_PROJECT_ID = makeId("project", 101);
export const PRINCIPAL_ID = makeId("principal", 102);

export function makeTransaction(
  sequence: number,
  previous: ProjectTransactionDigest | null,
  options: {
    projectId?: CanonicalId<"project">;
    commandId?: CanonicalId<"command">;
    eventId?: CanonicalId<"event">;
  } = {},
): ProjectTransaction {
  const suffix = sequence.toString(16).padStart(2, "0");
  return buildProjectTransaction({
    command_id: options.commandId ?? makeId("command", 110 + sequence),
    command_version: "1.0.0",
    command_name: "project.fixture_recorded",
    principal_id: PRINCIPAL_ID,
    project_id: options.projectId ?? PROJECT_ID,
    idempotency_key: `fixture-${sequence}`,
    input_digest: `sha256:${suffix.repeat(32)}`,
    previous_transaction_digest: previous,
    recorded_at: `2026-08-11T06:30:${sequence.toString().padStart(2, "0")}.000Z`,
    events: [{
      event_id: options.eventId ?? makeId("event", 130 + sequence),
      event_type: "project.fixture_recorded",
      subject_id: makeId("intent", 150 + sequence),
      occurred_at: `2026-08-11T06:30:${sequence.toString().padStart(2, "0")}.000Z`,
      payload: { sequence, label: `transaction-${sequence}` },
    }],
  });
}
