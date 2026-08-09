export function parseMacSignature(signature) {
  return {
    adHoc: /Signature=adhoc/i.test(signature),
    teamIdentifier: signature.match(/TeamIdentifier=(\S+)/)?.[1] ?? null,
    authorities: [...signature.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]),
  };
}

export function assertReleaseSignature(signature, expectedTeamIdentifier) {
  const parsed = parseMacSignature(signature);
  if (
    parsed.adHoc
    || !parsed.teamIdentifier
    || !parsed.authorities.some((authority) => authority.startsWith("Developer ID Application:"))
  ) {
    throw new Error("release artifact must use a Developer ID Application signature with a TeamIdentifier; ad-hoc and development signatures are not accepted");
  }
  if (expectedTeamIdentifier && parsed.teamIdentifier !== expectedTeamIdentifier) {
    throw new Error(`release TeamIdentifier ${parsed.teamIdentifier} does not match the configured release team`);
  }
  return parsed;
}

export function assertCredentialShape(environment) {
  const required = [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY",
    "APPLE_API_PRIVATE_KEY",
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new Error(`missing release credentials: ${missing.join(", ")}`);
  if (!environment.APPLE_SIGNING_IDENTITY.startsWith("Developer ID Application:")) {
    throw new Error("APPLE_SIGNING_IDENTITY must name a Developer ID Application identity");
  }
  if (!/^[A-Z0-9]{10}$/.test(environment.APPLE_TEAM_ID)) {
    throw new Error("APPLE_TEAM_ID must be a 10-character Apple Team ID");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(environment.APPLE_API_ISSUER)) {
    throw new Error("APPLE_API_ISSUER must be an App Store Connect issuer UUID");
  }
  if (!/^[A-Z0-9]{8,16}$/i.test(environment.APPLE_API_KEY)) {
    throw new Error("APPLE_API_KEY has an unexpected key ID shape");
  }
  if (!environment.APPLE_API_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")) {
    throw new Error("APPLE_API_PRIVATE_KEY must contain the App Store Connect .p8 private key");
  }
}
