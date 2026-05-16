import type { ZodIssue } from "zod";

export class PassportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PassportError";
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class PassportNotFoundError extends PassportError {
  constructor(public readonly path: string) {
    super(`Passport file not found: ${path}`);
    this.name = "PassportNotFoundError";
  }
}

export class PassportParseError extends PassportError {
  constructor(
    public readonly path: string,
    cause: Error,
  ) {
    super(`Failed to parse passport JSON at ${path}: ${cause.message}`, { cause });
    this.name = "PassportParseError";
  }
}

export class IdentityConfigError extends PassportError {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConfigError";
  }
}

export class IdentityCommitRepairError extends PassportError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IdentityCommitRepairError";
  }
}

export class PassportValidationError extends PassportError {
  constructor(
    public readonly issues: ZodIssue[],
    public readonly path?: string,
  ) {
    const location = path ? ` at ${path}` : "";
    const shown = issues.slice(0, 3);
    const bullets = shown
      .map((i) => `  • ${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`)
      .join("\n");
    const more = issues.length > shown.length ? `\n  …and ${issues.length - shown.length} more` : "";
    super(`Passport failed validation${location}:\n${bullets}${more}`);
    this.name = "PassportValidationError";
  }
}
