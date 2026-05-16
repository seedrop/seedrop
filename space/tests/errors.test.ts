import { describe, expect, it } from "vitest";
import type { ZodIssue } from "zod";
import {
  SpaceAuthError,
  SpaceError,
  SpaceParseError,
  SpaceValidationError,
} from "../src/index.js";
import {
  SpaceNotFoundError,
  WorkspaceViewError,
  WorkspaceViewParseError,
  WorkspaceViewValidationError,
} from "../src/errors.js";

function issue(pathSegments: (string | number)[], message: string): ZodIssue {
  return { code: "custom", path: pathSegments, message } as ZodIssue;
}

describe("SpaceError", () => {
  it("constructs without a cause", () => {
    const error = new SpaceError("boom");
    expect(error.message).toBe("boom");
    expect(error.name).toBe("SpaceError");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("attaches a cause when provided", () => {
    const cause = new Error("underlying");
    const error = new SpaceError("boom", { cause });
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

describe("SpaceParseError", () => {
  it("wraps the parse failure with the offending path", () => {
    const cause = new Error("Unexpected token");
    const error = new SpaceParseError("/tmp/space/meta.json", cause);
    expect(error.name).toBe("SpaceParseError");
    expect(error.path).toBe("/tmp/space/meta.json");
    expect(error.message).toContain("/tmp/space/meta.json");
    expect(error.message).toContain("Unexpected token");
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

describe("SpaceValidationError", () => {
  it("renders zero-length issue paths as <root>", () => {
    const error = new SpaceValidationError([issue([], "must be present")], "/tmp/space/meta.json");
    expect(error.message).toContain("at /tmp/space/meta.json");
    expect(error.message).toContain("<root>: must be present");
  });

  it("omits the location segment when path is not supplied", () => {
    const error = new SpaceValidationError([issue(["lifecycle"], "invalid")]);
    expect(error.message).toContain("Space JSON failed validation:");
    expect(error.message).not.toContain(" at ");
    expect(error.message).toContain("lifecycle: invalid");
  });

  it("truncates after three issues and reports the remainder", () => {
    const issues = [
      issue(["a"], "1"),
      issue(["b"], "2"),
      issue(["c"], "3"),
      issue(["d"], "4"),
      issue(["e"], "5"),
    ];
    const error = new SpaceValidationError(issues, "file");
    expect(error.message).toContain("a: 1");
    expect(error.message).toContain("c: 3");
    expect(error.message).not.toContain("d: 4");
    expect(error.message).toContain("...and 2 more");
  });

  it("does not append a remainder when issue count is within the cap", () => {
    const error = new SpaceValidationError([issue(["a"], "1"), issue(["b"], "2")]);
    expect(error.message).not.toContain("and");
  });
});

describe("SpaceNotFoundError", () => {
  it("captures the identifier that was missed", () => {
    const error = new SpaceNotFoundError("missing-room");
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.idOrName).toBe("missing-room");
    expect(error.message).toBe("Space not found: missing-room");
  });
});

describe("SpaceAuthError", () => {
  it("defaults to 401 and can carry a cause", () => {
    const cause = new Error("resolver");
    const error = new SpaceAuthError("not allowed", 401, { cause });
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.name).toBe("SpaceAuthError");
    expect(error.statusCode).toBe(401);
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("supports 403 for authenticated-but-forbidden callers", () => {
    const error = new SpaceAuthError("forbidden", 403);
    expect(error.statusCode).toBe(403);
  });
});

describe("WorkspaceViewError hierarchy", () => {
  it("constructs WorkspaceViewError with and without a cause", () => {
    expect(new WorkspaceViewError("plain").message).toBe("plain");
    const cause = new Error("underlying");
    const withCause = new WorkspaceViewError("decorated", { cause });
    expect((withCause as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("WorkspaceViewParseError wraps the parse failure", () => {
    const cause = new Error("Unexpected token");
    const error = new WorkspaceViewParseError("/tmp/view.json", cause);
    expect(error.path).toBe("/tmp/view.json");
    expect(error.message).toContain("/tmp/view.json");
    expect(error.message).toContain("Unexpected token");
  });

  it("WorkspaceViewValidationError formats issues, truncates, and omits empty paths", () => {
    const issues = [
      issue([], "must be present"),
      issue(["a"], "1"),
      issue(["b"], "2"),
      issue(["c"], "3"),
      issue(["d"], "4"),
    ];
    const formatted = new WorkspaceViewValidationError(issues, "view.json");
    expect(formatted.message).toContain("at view.json");
    expect(formatted.message).toContain("<root>: must be present");
    expect(formatted.message).toContain("...and 2 more");

    const noPath = new WorkspaceViewValidationError([issue(["x"], "y")]);
    expect(noPath.message).not.toContain(" at ");
  });
});
