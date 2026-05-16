import { describe, it, expect } from "vitest";
import * as pkg from "../src/index.js";

describe("public entry point", () => {
  it("exports Identity", () => {
    expect(typeof pkg.Identity).toBe("function");
    expect(typeof pkg.Identity.fromPassport).toBe("function");
    expect(typeof pkg.Identity.savePassport).toBe("function");
    expect(typeof pkg.Identity.repairPendingCommit).toBe("function");
  });

  it("exports PassportSchema and PassportSchemaV1", () => {
    expect(pkg.PassportSchema).toBeDefined();
    expect(pkg.PassportSchemaV1).toBeDefined();
    expect(pkg.ActiveProjectSchema).toBeDefined();
    expect(pkg.CredentialRefSchema).toBeDefined();
    expect(pkg.ContinuityStateSchema).toBeDefined();
    expect(typeof pkg.PassportSchema.safeParse).toBe("function");
  });

  it("exports error classes that extend Error", () => {
    expect(new pkg.PassportError("x")).toBeInstanceOf(Error);
    expect(new pkg.PassportNotFoundError("/nope")).toBeInstanceOf(pkg.PassportError);
    expect(new pkg.PassportParseError("/p", new Error("boom"))).toBeInstanceOf(pkg.PassportError);
    expect(new pkg.PassportValidationError([])).toBeInstanceOf(pkg.PassportError);
    expect(new pkg.IdentityCommitRepairError("x")).toBeInstanceOf(pkg.PassportError);
  });

  it("exports commit journal helpers", () => {
    expect(typeof pkg.defaultCommitJournalPath).toBe("function");
    expect(typeof pkg.repairPendingCommit).toBe("function");
    expect(pkg.CommitJournalRecordSchema).toBeDefined();
  });
});
