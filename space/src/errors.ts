import type { ZodIssue } from "zod";
import type { NextAction } from "./types.js";

/**
 * Base error for the Workspace View layer. Carries a structured
 * `recovery` field — a list of suggested next actions (matching the
 * NextAction shape used elsewhere) that turn a thrown error into an
 * actionable next step. CLI prints them as a "Recovery:" block on
 * stderr; MCP gets them via the same passthrough; programmatic
 * consumers can read `err.recovery` directly.
 *
 * Implements kimi's design #4: every error is a recovery plan, not
 * just a description of what failed.
 */
export class WorkspaceViewError extends Error {
  public readonly recovery: NextAction[];
  constructor(message: string, options?: { cause?: unknown; recovery?: NextAction[] }) {
    super(message);
    this.name = "WorkspaceViewError";
    this.recovery = options?.recovery ?? [];
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class WorkspaceViewParseError extends WorkspaceViewError {
  constructor(
    public readonly path: string,
    cause: Error,
  ) {
    super(`Failed to parse workspace view JSON at ${path}: ${cause.message}`, {
      cause,
      recovery: [
        { kind: "read", path, risk: "low", requires_human: true, reason: "Inspect the file — the JSON is malformed." },
        { kind: "command", command: "seed view sync", risk: "low", requires_human: false, reason: "Regenerate the manifest after fixing or removing the broken file." },
      ],
    });
    this.name = "WorkspaceViewParseError";
  }
}

export class WorkspaceRunDirtyTreeError extends WorkspaceViewError {
  constructor(
    public readonly dirtyChangedPaths: string[],
    public readonly allChangedPaths: string[],
  ) {
    const lines = dirtyChangedPaths.map((p) => `  - ${p}`).join("\n");
    const sample = dirtyChangedPaths.slice(0, 3).join(" ");
    super(
      `Cannot mark run completed: ${dirtyChangedPaths.length} of ${allChangedPaths.length} changed_paths are uncommitted:\n${lines}\nCommit them, mark the run blocked/failed, or pass force=true to override.`,
      {
        recovery: [
          { kind: "command", command: `git add ${sample}${dirtyChangedPaths.length > 3 ? " ..." : ""} && git commit`, risk: "low", requires_human: true, reason: "Commit the work the run claimed before finishing." },
          { kind: "command", command: "seed run finish --status blocked", risk: "low", requires_human: false, reason: "Mark blocked instead of completed if the work isn't done." },
          { kind: "command", command: "seed run finish --status completed --force", risk: "medium", requires_human: true, reason: "Bypass the gate only when you intentionally leave this run's changed paths uncommitted." },
        ],
      },
    );
    this.name = "WorkspaceRunDirtyTreeError";
  }
}

export class WorkspaceRunUnloggedChangesError extends WorkspaceViewError {
  constructor(public readonly dirtyPaths: string[]) {
    const sample = dirtyPaths.slice(0, 3);
    const bullets = sample.map((p) => `  - ${p}`).join("\n");
    const more = dirtyPaths.length > sample.length ? `\n  ...and ${dirtyPaths.length - sample.length} more` : "";
    super(
      `Cannot mark run completed: the run logged no changed_paths but git has ${dirtyPaths.length} uncommitted file(s):\n${bullets}${more}\nThis is common for validation-only runs in a pre-existing dirty tree. Inspect the tree, log only files this run actually changed, mark the run blocked/failed, or pass force=true only when the dirty files pre-existed or are unrelated.`,
      {
        recovery: [
          { kind: "command", command: "git status --short", risk: "low", requires_human: false, reason: "Inspect whether the dirty files pre-existed this run or belong to the current work." },
          { kind: "command", command: `seed run log --summary "..." --changed-path ${sample[0] ?? "<file>"}`, risk: "low", requires_human: true, reason: "Record only files this run actually changed so the run journal reflects the work." },
          { kind: "command", command: "seed run finish --status blocked", risk: "low", requires_human: false, reason: "Mark blocked if the work isn't ready." },
          { kind: "command", command: "seed run finish --status completed --force", risk: "medium", requires_human: true, reason: "Override only if the dirty files pre-existed this run or are unrelated to it." },
        ],
      },
    );
    this.name = "WorkspaceRunUnloggedChangesError";
  }
}

/**
 * Thrown when a run is finished `failed` or `blocked` without a cause line.
 *
 * This is the only gate on a non-completed finish, and it is deliberately the
 * cheapest one in the system: no dirty-tree check, no changed_paths
 * requirement, no committed work. One sentence about why it died. A graveyard
 * of causeless corpses tells a later agent that something was tried here but
 * not what to avoid, which is worse than no record at all — it costs a read
 * and returns nothing.
 */
export class WorkspaceRunMissingCauseError extends WorkspaceViewError {
  constructor(public readonly status: "failed" | "blocked") {
    const verb = status === "failed" ? "failed" : "blocked";
    super(
      `Cannot mark run ${verb} without a cause. Pass one line saying what went wrong — that is the entire cost of recording this, and it is the only part a later agent needs.\n` +
        `A dead run with no cause is worse than no record: it proves something was tried here without saying what to avoid.`,
      {
        recovery: [
          {
            kind: "command",
            command: `seed run finish --status ${status} --cause "<what went wrong, one line>"`,
            risk: "low",
            requires_human: false,
            reason: "Record the cause of death. No other evidence is required — failing is cheaper than completing.",
          },
          {
            kind: "command",
            command: "seed run finish --status completed",
            risk: "low",
            requires_human: true,
            reason: "If the work actually succeeded, complete it instead (this path does gate on uncommitted changed paths).",
          },
        ],
      },
    );
    this.name = "WorkspaceRunMissingCauseError";
  }
}

export class TaskNotFoundError extends WorkspaceViewError {
  constructor(public readonly taskId: string) {
    super(`Task not found: ${taskId}`, {
      recovery: [
        { kind: "command", command: "seed task list", risk: "low", requires_human: false, reason: "List available tasks; check the id prefix is unique." },
      ],
    });
    this.name = "TaskNotFoundError";
  }
}

export interface TaskConflictContext {
  taskId?: string;
  owner?: string;
  status?: string;
  actor?: string;
}

export class TaskConflictError extends WorkspaceViewError {
  public readonly context?: TaskConflictContext;
  constructor(message: string, context?: TaskConflictContext) {
    const recovery: NextAction[] = [];
    if (context?.owner && context.actor && context.owner !== context.actor) {
      recovery.push({
        kind: "command",
        command: `seed login ${context.owner}`,
        risk: "low",
        requires_human: true,
        reason: `Switch identity to ${context.owner} (the task's owner) before retrying.`,
      });
      if (context.taskId) {
        recovery.push({
          kind: "command",
          command: `seed task assign ${context.taskId.slice(0, 8)} ${context.actor}`,
          risk: "low",
          requires_human: true,
          reason: `Reassign the task to ${context.actor} explicitly.`,
        });
      }
    } else if (context?.status === "done" || context?.status === "dropped") {
      recovery.push({
        kind: "command",
        command: "seed task list --status open",
        risk: "low",
        requires_human: false,
        reason: "Find an open task to act on instead.",
      });
    } else {
      recovery.push({
        kind: "command",
        command: "seed task show <id>",
        risk: "low",
        requires_human: false,
        reason: "Inspect the task to see why this action is forbidden in the current state.",
      });
    }
    super(message, { recovery });
    this.context = context;
    this.name = "TaskConflictError";
  }
}

export class TaskBlockedError extends WorkspaceViewError {
  constructor(
    public readonly taskId: string,
    public readonly openBlockers: string[],
  ) {
    const bullets = openBlockers.slice(0, 3).map((id) => `  - ${id}`).join("\n");
    super(`Task ${taskId} is blocked by ${openBlockers.length} open task(s):\n${bullets}`, {
      recovery: [
        { kind: "command", command: `seed task show ${openBlockers[0]?.slice(0, 8) ?? "<blocker>"}`, risk: "low", requires_human: false, reason: "Inspect the first blocker; finish or drop it before acting on this task." },
      ],
    });
    this.name = "TaskBlockedError";
  }
}

export class InvalidTaskTransitionError extends TaskConflictError {
  constructor(
    public readonly taskId: string,
    public readonly from: string,
    public readonly to: string,
    public readonly operation: string,
    actor?: string,
  ) {
    super(
      `Task ${taskId} cannot transition ${from} -> ${to} during ${operation}.`,
      { taskId, status: from, actor },
    );
    this.name = "InvalidTaskTransitionError";
  }
}

export class InvalidRunTransitionError extends WorkspaceViewError {
  constructor(
    public readonly runId: string,
    public readonly from: string,
    public readonly to: string,
    public readonly operation: string,
  ) {
    super(`Run ${runId} cannot transition ${from} -> ${to} during ${operation}.`, {
      recovery: [{
        kind: "command",
        command: "seed view context --json",
        risk: "low",
        requires_human: false,
        reason: "Inspect the canonical run state before choosing another action.",
      }],
    });
    this.name = "InvalidRunTransitionError";
  }
}

export class WorkspaceRunClaimConflictError extends WorkspaceViewError {
  constructor(
    public readonly conflicts: Array<{ path: string; owner: string; signalId: string; intent: string; expiresAt: string }>,
  ) {
    const bullets = conflicts.slice(0, 3).map((c) =>
      `  - ${c.path} (claimed by ${c.owner}, intent: "${c.intent}", expires ${c.expiresAt})`,
    ).join("\n");
    super(
      `Cannot start run: ${conflicts.length} path(s) are claimed by other agents:\n${bullets}\nCoordinate via \`seed space post\`, wait for the claims to expire, or pass --force.`,
      {
        recovery: [
          { kind: "command", command: `seed space post seedrop-team "starting work on ${conflicts[0]?.path ?? "<path>"} — @${conflicts[0]?.owner ?? "owner"} any objections?"`, risk: "low", requires_human: true, reason: "Coordinate with the current claim owner before stepping on their work." },
          { kind: "command", command: "seed run start --goal X --claim <paths> --force", risk: "medium", requires_human: true, reason: "Override the claim (only if you've coordinated)." },
        ],
      },
    );
    this.name = "WorkspaceRunClaimConflictError";
  }
}

export class WorkspaceRunTaskConflictError extends WorkspaceViewError {
  constructor(
    public readonly taskId: string,
    public readonly owner: string | undefined,
    public readonly status: string,
  ) {
    const recovery: NextAction[] = [];
    if (owner) {
      recovery.push({
        kind: "command",
        command: `seed login ${owner}`,
        risk: "low",
        requires_human: true,
        reason: `Switch identity to ${owner} (the task's owner).`,
      });
    }
    recovery.push({
      kind: "command",
      command: `seed task assign ${taskId.slice(0, 8)} <yourself>`,
      risk: "low",
      requires_human: true,
      reason: "Take ownership of the task explicitly.",
    });
    recovery.push({
      kind: "command",
      command: "seed run start --goal X --task <id> --force",
      risk: "medium",
      requires_human: true,
      reason: "Override (only if you've coordinated with the task's owner).",
    });
    super(
      `Cannot start run on task ${taskId}: owned by ${owner ?? "no one"}, status=${status}. Only the owner can start a run on an in-flight task. Pass --force to override.`,
      { recovery },
    );
    this.name = "WorkspaceRunTaskConflictError";
  }
}

export class WorkspaceRunOwnershipError extends WorkspaceViewError {
  constructor(
    public readonly runId: string,
    public readonly owner: string,
    public readonly resolvedAgent: string,
  ) {
    super(
      `Run ${runId.slice(0, 8)} is owned by ${owner}, but this session resolves as ${resolvedAgent}. ` +
        `Mutating another agent's run would misattribute the work. ` +
        `Re-run with --agent ${owner} (if you are acting on their behalf) or \`seed login ${owner}\`.`,
      {
        recovery: [
          {
            kind: "command",
            command: `seed run finish --agent ${owner} --status completed`,
            risk: "low",
            requires_human: true,
            reason: `Act explicitly as ${owner} (the run's owner) for this command only.`,
          },
          {
            kind: "command",
            command: `seed login ${owner}`,
            risk: "low",
            requires_human: true,
            reason: `Switch this shell's identity to ${owner} before retrying.`,
          },
        ],
      },
    );
    this.name = "WorkspaceRunOwnershipError";
  }
}

export class WorkspaceViewValidationError extends WorkspaceViewError {
  constructor(
    public readonly issues: ZodIssue[],
    public readonly path?: string,
  ) {
    const location = path ? ` at ${path}` : "";
    const shown = issues.slice(0, 3);
    const bullets = shown
      .map((issue) => `  - ${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`)
      .join("\n");
    const more = issues.length > shown.length ? `\n  ...and ${issues.length - shown.length} more` : "";
    const recovery: NextAction[] = [];
    if (path) {
      recovery.push({ kind: "read", path, risk: "low", requires_human: true, reason: "Inspect the file to see which field violates the schema." });
    }
    recovery.push({
      kind: "command",
      command: "seed view explain success",
      risk: "low",
      requires_human: false,
      reason: "See which checks the view fails and what each one needs.",
    });
    super(`Workspace view JSON failed validation${location}:\n${bullets}${more}`, { recovery });
    this.name = "WorkspaceViewValidationError";
  }
}

export class SpaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SpaceError";
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class SpaceParseError extends SpaceError {
  constructor(
    public readonly path: string,
    cause: Error,
  ) {
    super(`Failed to parse space JSON at ${path}: ${cause.message}`, { cause });
    this.name = "SpaceParseError";
  }
}

export class SpaceNotFoundError extends SpaceError {
  constructor(public readonly idOrName: string) {
    super(`Space not found: ${idOrName}`);
    this.name = "SpaceNotFoundError";
  }
}

export class SpaceAuthError extends SpaceError {
  constructor(
    message: string,
    public readonly statusCode: 401 | 403 = 401,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SpaceAuthError";
  }
}

export class SpaceRequestBodyTooLargeError extends SpaceError {
  constructor(
    public readonly limitBytes: number,
    public readonly receivedBytes: number,
  ) {
    super(`Request body exceeds the ${limitBytes}-byte limit.`);
    this.name = "SpaceRequestBodyTooLargeError";
  }
}

export class SpaceMentionDeliveryError extends SpaceError {
  public readonly requestId?: string;

  constructor(
    public readonly messageId: string,
    public readonly recipients: string[],
    requestIdOrOptions?: string | { cause?: unknown },
    maybeOptions?: { cause?: unknown },
  ) {
    const requestId = typeof requestIdOrOptions === "string" ? requestIdOrOptions : undefined;
    const options = typeof requestIdOrOptions === "string" ? maybeOptions : requestIdOrOptions;
    super(
      `Message ${messageId} was persisted but mention delivery failed for ${recipients.join(", ")}`
        + (requestId ? ` (request ${requestId})` : ""),
      options,
    );
    this.name = "SpaceMentionDeliveryError";
    this.requestId = requestId;
  }
}

export class SpaceRequestConflictError extends SpaceError {
  constructor(
    public readonly requestId: string,
    public readonly messageId: string,
  ) {
    super(`Request ${requestId} was already used for message ${messageId} with a different payload.`);
    this.name = "SpaceRequestConflictError";
  }
}

export type SpacePostOutboxFailureState = "pending" | "processing" | "dead_letter";

export class SpacePostOutboxError extends SpaceError {
  constructor(
    public readonly requestId: string,
    public readonly messageId: string,
    public readonly spaceName: string,
    public readonly state: SpacePostOutboxFailureState,
    public readonly attemptCount: number,
    public readonly retryable: boolean,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SpacePostOutboxError";
  }
}

export class SpaceValidationError extends SpaceError {
  constructor(
    public readonly issues: ZodIssue[],
    public readonly path?: string,
  ) {
    const location = path ? ` at ${path}` : "";
    const shown = issues.slice(0, 3);
    const bullets = shown
      .map((issue) => `  - ${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`)
      .join("\n");
    const more = issues.length > shown.length ? `\n  ...and ${issues.length - shown.length} more` : "";
    super(`Space JSON failed validation${location}:\n${bullets}${more}`);
    this.name = "SpaceValidationError";
  }
}

/**
 * Thrown when a persisted view file has a `schema_version` that this
 * CLI doesn't know how to read. Three flavors:
 * - "forward": the stored version is newer than this CLI supports
 *   (the workspace was touched by a newer toolchain).
 * - "unknown": the stored version isn't a node in the migration chain
 *   (likely a typo or a hand-edited file).
 * - "no-path": the chain has a cycle or a gap reaching `current`.
 *
 * Recovery hints always include `seed --version` plus the npm upgrade
 * command so the user can self-diagnose without reading source.
 */
export class SchemaVersionUnsupportedError extends WorkspaceViewError {
  public readonly schema: string;
  public readonly found: string;
  public readonly supported: string;
  public readonly path?: string;
  public readonly reason: "forward" | "unknown" | "no-path";
  constructor(opts: {
    schema: string;
    found: string;
    supported: string;
    path?: string;
    reason: "forward" | "unknown" | "no-path";
  }) {
    const reasonDetail =
      opts.reason === "forward"
        ? `is version ${opts.found}, but this CLI supports up to ${opts.supported}`
        : opts.reason === "unknown"
          ? `has unknown version ${opts.found}; this CLI's migration chain does not include it`
          : `cannot be migrated from ${opts.found} to ${opts.supported} — the migration chain is broken`;
    const where = opts.path ? ` at ${opts.path}` : "";
    super(`${opts.schema}${where} ${reasonDetail}.`, {
      recovery: [
        {
          kind: "command",
          command: "seed --version",
          risk: "low",
          requires_human: true,
          reason: "Check your CLI version against the file's schema_version.",
        },
        {
          kind: "command",
          command: "npm i -g @seedrop/cli@latest",
          risk: "low",
          requires_human: true,
          reason: "Upgrade if the file came from a newer toolchain.",
        },
      ],
    });
    this.name = "SchemaVersionUnsupportedError";
    this.schema = opts.schema;
    this.found = opts.found;
    this.supported = opts.supported;
    this.path = opts.path;
    this.reason = opts.reason;
  }
}

/**
 * Render a WorkspaceViewError's recovery list as a human-readable
 * block suitable for stderr. Returns an empty string when there is
 * no recovery (so callers can unconditionally append).
 */
export function renderRecovery(error: unknown): string {
  if (!error || typeof error !== "object" || !("recovery" in error) || !Array.isArray(error.recovery) || error.recovery.length === 0) {
    return "";
  }
  const recovery = error.recovery as NextAction[];
  const lines: string[] = ["", "Recovery:"];
  for (const action of recovery) {
    const cmd = action.command ? `  $ ${action.command}` : (action.path ? `  ${action.path}` : "");
    lines.push(cmd);
    lines.push(`      — ${action.reason}${action.risk !== "low" ? ` (risk: ${action.risk})` : ""}`);
  }
  return lines.join("\n");
}
