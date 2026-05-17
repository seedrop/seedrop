import type { ZodIssue } from "zod";

export class WorkspaceViewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "WorkspaceViewError";
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
    super(`Failed to parse workspace view JSON at ${path}: ${cause.message}`, { cause });
    this.name = "WorkspaceViewParseError";
  }
}

export class WorkspaceRunDirtyTreeError extends WorkspaceViewError {
  constructor(
    public readonly dirtyChangedPaths: string[],
    public readonly allChangedPaths: string[],
  ) {
    const lines = dirtyChangedPaths.map((p) => `  - ${p}`).join("\n");
    super(
      `Cannot mark run completed: ${dirtyChangedPaths.length} of ${allChangedPaths.length} changed_paths are uncommitted:\n${lines}\nCommit them, mark the run blocked/failed, or pass force=true to override.`,
    );
    this.name = "WorkspaceRunDirtyTreeError";
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
    super(`Workspace view JSON failed validation${location}:\n${bullets}${more}`);
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
