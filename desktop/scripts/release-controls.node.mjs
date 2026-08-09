// Kept outside Vitest's *.test.* discovery; this is a Node built-in test harness.
import assert from "node:assert/strict";
import test from "node:test";
import { assertCredentialShape, assertReleaseSignature, parseMacSignature } from "./release-controls.mjs";

const validSignature = `
Authority=Developer ID Application: Seedrop (ABCDE12345)
Authority=Developer ID Certification Authority
TeamIdentifier=ABCDE12345
Signature size=9000
`;

const validCredentials = {
  APPLE_CERTIFICATE: "base64-p12",
  APPLE_CERTIFICATE_PASSWORD: "password",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Seedrop (ABCDE12345)",
  APPLE_TEAM_ID: "ABCDE12345",
  APPLE_API_ISSUER: "01234567-89ab-cdef-0123-456789abcdef",
  APPLE_API_KEY: "AB12CD34EF",
  APPLE_API_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
};

test("parses and accepts only the configured Developer ID Application team", () => {
  assert.equal(parseMacSignature(validSignature).teamIdentifier, "ABCDE12345");
  assert.equal(assertReleaseSignature(validSignature, "ABCDE12345").adHoc, false);
  assert.throws(() => assertReleaseSignature(validSignature, "ZYXWV98765"), /configured release team/);
});

test("rejects ad-hoc and Apple Development signatures", () => {
  assert.throws(() => assertReleaseSignature("Signature=adhoc\nTeamIdentifier=not set"), /Developer ID Application/);
  assert.throws(() => assertReleaseSignature("Authority=Apple Development: Seedrop\nTeamIdentifier=ABCDE12345"), /Developer ID Application/);
});

test("validates the complete release credential contract without exposing values", () => {
  assert.doesNotThrow(() => assertCredentialShape(validCredentials));
  assert.throws(() => assertCredentialShape({ ...validCredentials, APPLE_API_PRIVATE_KEY: "" }), /APPLE_API_PRIVATE_KEY/);
  assert.throws(() => assertCredentialShape({ ...validCredentials, APPLE_TEAM_ID: "wrong" }), /APPLE_TEAM_ID/);
});
