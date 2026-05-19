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
          { kind: "command", command: "seed run finish --status completed --force", risk: "medium", requires_human: true, reason: "Bypass the gate (intentionally leaving changes uncommitted)." },
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
      `Cannot mark run completed: the run logged no changed_paths but git has ${dirtyPaths.length} uncommitted file(s):\n${bullets}${more}\nLog them with \`seed run log --summary "..." --changed-path <file>\`, mark the run blocked/failed, or pass force=true to override.`,
      {
        recovery: [
          { kind: "command", command: `seed run log --summary "..." --changed-path ${sample[0] ?? "<file>"}`, risk: "low", requires_human: true, reason: "Record what you changed so the run journal reflects the work." },
          { kind: "command", command: "seed run finish --status blocked", risk: "low", requires_human: false, reason: "Mark blocked if the work isn't ready." },
          { kind: "command", command: "seed run finish --status completed --force", risk: "medium", requires_human: true, reason: "Override (only if the dirty files are intentionally unrelated to this run)." },
        ],
      },
    );
    this.name = "WorkspaceRunUnloggedChangesError";
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

export class SpaceMentionDeliveryError extends SpaceError {
  constructor(
    public readonly messageId: string,
    public readonly recipients: string[],
    options?: { cause?: unknown },
  ) {
    super(`Message ${messageId} was persisted but mention delivery failed for ${recipients.join(", ")}`, options);
    this.name = "SpaceMentionDeliveryError";
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
 * Render a WorkspaceViewError's recovery list as a human-readable
 * block suitable for stderr. Returns an empty string when there is
 * no recovery (so callers can unconditionally append).
 */
export function renderRecovery(error: unknown): string {
  if (!(error instanceof WorkspaceViewError) || error.recovery.length === 0) return "";
  const lines: string[] = ["", "Recovery:"];
  for (const action of error.recovery) {
    const cmd = action.command ? `  $ ${action.command}` : (action.path ? `  ${action.path}` : "");
    lines.push(cmd);
    lines.push(`      — ${action.reason}${action.risk !== "low" ? ` (risk: ${action.risk})` : ""}`);
  }
  return lines.join("\n");
}
