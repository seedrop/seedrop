import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  WORK_EVENT_TYPES,
  assertWorkDomainEvent,
  buildClaimRecord,
  buildIntentRecord,
  buildLeaseRecord,
  buildLeaseTransition,
  buildProjectEvent,
  buildWorkCorrection,
  buildWorkLifecycleTransition,
  buildWorkReceipt,
  generateCanonicalId,
} from "../src/index.js";
import type { CanonicalIdKind, ProjectTransactionDigest } from "../src/index.js";

const entropy = (seed: number) => Uint8Array.from({ length: 10 }, (_, index) => seed + index);
const id = <K extends CanonicalIdKind>(kind: K, seed: number) => generateCanonicalId(kind, {
  now: 1_723_379_696_000 + seed,
  entropy: entropy(seed),
});
const PROJECT = id("project", 1);
const PRINCIPAL = id("principal", 2);
const INTENT = id("intent", 3);
const EPISODE = id("episode", 4);
const CLAIM = id("claim", 5);
const RECEIPT = id("receipt", 6);
const LEASE = id("lease", 7);
const COMMAND = id("command", 8);
const EVENT = id("event", 9);
const AT = "2026-08-11T13:00:00.000Z";
const DIGEST = `sha256:${"aa".repeat(32)}` as ProjectTransactionDigest;

describe("native work protocol", () => {
  it("builds canonical Intent, Claim, Receipt, and Lease records", () => {
    expect(buildIntentRecord({
      intent_id: INTENT, project_id: PROJECT, title: "Ship the slice", state: "queued",
      created_by: PRINCIPAL, created_at: AT,
    }).intent_version).toBe("1.0.0");
    expect(buildClaimRecord({
      claim_id: CLAIM, project_id: PROJECT, intent_id: INTENT, episode_id: EPISODE,
      claim_kind: "outcome", statement: "All checks passed", evidence_digests: [DIGEST],
      corrects_claim_id: null, recorded_by: PRINCIPAL, recorded_at: AT,
    }).evidence_digests).toEqual([DIGEST]);
    expect(buildWorkReceipt({
      receipt_id: RECEIPT, receipt_kind: "episode_finished", command_id: COMMAND,
      principal_id: PRINCIPAL, project_id: PROJECT, subject_id: EPISODE, issued_at: AT,
      summary: "Episode finished", evidence_digest: DIGEST,
    }).receipt_version).toBe("1.0.0");
    expect(buildLeaseRecord({
      lease_id: LEASE, project_id: PROJECT, target: "src/work.ts", holder_principal_id: PRINCIPAL,
      intent_id: INTENT, episode_id: EPISODE, state: "active", acquired_at: AT,
      expires_at: "2026-08-11T13:01:00.000Z",
    }).state).toBe("active");
  });

  it("consumes the generated transition table and rejects invalid lifecycle edges", () => {
    expect(buildWorkLifecycleTransition({
      lifecycle: "intent", subject_id: INTENT, from: "queued", to: "active", reason: "episode_started",
      actor_principal_id: PRINCIPAL, recorded_at: AT,
    }).to).toBe("active");
    expect(() => buildWorkLifecycleTransition({
      lifecycle: "intent", subject_id: INTENT, from: "reported_complete", to: "active", reason: "silent_reopen",
      actor_principal_id: PRINCIPAL, recorded_at: AT,
    })).toThrowError(ProtocolError);
  });

  it("requires terminal reopen to be an explicit correction Event", () => {
    const correction = buildWorkCorrection({
      lifecycle: "episode", subject_id: EPISODE, corrects_event_id: EVENT,
      from: "failed", to: "active", reason: "failure report targeted the wrong build",
      actor_principal_id: PRINCIPAL, recorded_at: AT,
    });
    const envelope = buildProjectEvent({
      event_id: id("event", 10), event_type: WORK_EVENT_TYPES.episode_corrected,
      subject_id: EPISODE, occurred_at: AT, payload: correction,
    });
    expect(assertWorkDomainEvent(envelope)).toEqual(correction);
  });

  it("binds explicit Lease expiry state to the Event envelope", () => {
    const expiry = buildLeaseTransition({
      lease_id: LEASE, from: "active", to: "expired", reason: "ttl_elapsed",
      actor_principal_id: PRINCIPAL, recorded_at: AT,
    });
    const event = buildProjectEvent({
      event_id: id("event", 11), event_type: WORK_EVENT_TYPES.lease_expired,
      subject_id: LEASE, occurred_at: AT, payload: expiry,
    });
    expect(assertWorkDomainEvent(event)).toEqual(expiry);
    expect(() => assertWorkDomainEvent({ ...event, subject_id: INTENT })).toThrowError(ProtocolError);
  });

  it("rejects unknown fields and contradictory initial state", () => {
    expect(() => buildIntentRecord({
      intent_id: INTENT, project_id: PROJECT, title: "x", state: "active" as "queued",
      created_by: PRINCIPAL, created_at: AT,
    })).toThrowError(ProtocolError);
    expect(() => buildWorkReceipt({
      receipt_id: RECEIPT, receipt_kind: "episode_started", command_id: COMMAND,
      principal_id: PRINCIPAL, project_id: PROJECT, subject_id: EPISODE, issued_at: AT,
      summary: "started", evidence_digest: null, extra: true,
    } as never)).toThrowError(ProtocolError);
  });
});
