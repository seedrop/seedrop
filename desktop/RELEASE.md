# Seedrop Desktop release runbook

Desktop is releasable only from a clean, tagged commit. A successful development build or `artifact:verify` is not a release signal.

## Required evidence

1. Root and runtime dependency audits report zero known vulnerabilities.
2. The full workspace tests, Space HTTP/file smokes, CLI composition/install smokes, Desktop UI tests, Rust tests, and sealed-runtime artifact tests pass.
3. Native arm64 and x64 jobs each fetch Node from the official distribution, verify `SHASUMS256.txt`, prepare the exact locked runtime, and build a thin application.
4. The signed application passes `release:verify`: version parity, CSP, exact resource hashes and modes, architecture, size budget, Developer ID identity, strict signature validation, Gatekeeper, and notarization staple. The mounted application and disk image then pass `release:dmg:verify`.
5. A clean macOS user account completes first run, interruption/resume, first-project linking, project-reader recovery, and daemon restart without a system Node installation.
6. The prior notarized application remains available and the rollback drill succeeds before publishing an update.

## Release authority and environments

Production release automation lives in `.github/workflows/release-desktop.yml`. Protect the `desktop-release` environment with required reviewers and store these environment secrets there:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`: export password for that `.p12`
- `APPLE_SIGNING_IDENTITY`: full `Developer ID Application: Name (TEAMID)` identity
- `APPLE_TEAM_ID`: the 10-character team identifier
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_PRIVATE_KEY`: App Store Connect API notarization authority; store the private key as its raw multiline `.p8` contents

Protect the separate `desktop-publish` environment with a human reviewer. It receives no Apple credentials; approval only permits the two proven architecture artifacts to be assembled into a draft GitHub prerelease. Release actions are pinned by commit SHA, signing material is installed in an ephemeral keychain, and cleanup runs even after failure.

Create and push an annotated tag that exactly matches the Desktop version (`desktop-v0.2.0-alpha.5`), or manually dispatch the workflow against that existing tag. The workflow rejects moving/mismatched tags, dirty source, incomplete credentials, a non-Developer-ID identity, or a signing team different from `APPLE_TEAM_ID` before it can publish evidence.

## Build and verify

Signing and notarization credentials belong in the release runner/keychain, never in this repository. Use Tauri’s macOS signing/notarization environment on the architecture-specific release runner, then run:

```bash
npm ci
npm audit --audit-level=low
npm audit --prefix desktop/runtime --audit-level=low
npm run fetch-runtime -w @seedrop/desktop -- --arch=arm64 # or x64 on its runner
npm run tauri:build -w @seedrop/desktop
npm run release:dmg:verify -w @seedrop/desktop
```

Record the `.app`/`.dmg` SHA-256, runtime manifest digest, architecture, version, signing TeamIdentifier, notarization result, test run, and previous-release rollback result in the release notes.

The workflow emits one `release-evidence-<arch>.json` beside each DMG and creates a GitHub artifact attestation for each disk image. The final `SHA256SUMS.txt`, evidence JSON, and DMGs are attached only to a draft prerelease. Promotion from draft remains a deliberate operator action after the clean-account and rollback drills.

## Update and rollback invariant

An app update carries a new sealed runtime. Desktop installs it beside existing versions, validates every declared file, executes Node/CLI/Observer/native-store probes, and changes the active runtime pointer only after all probes pass. Failure leaves the old pointer unchanged.

The running app trusts only the external runtime whose manifest exactly matches its own signed bundle. Therefore rollback is performed by reopening the prior notarized app; that app reactivates its own sealed payload. Never delete the prior app artifact or its release evidence until the succeeding release has passed the rollback drill.

The initial distribution channel is architecture-specific signed/notarized DMGs. An automatic update channel is a separate release project and must not be enabled until endpoint ownership, updater-key custody, staged rollout, and rollback telemetry have explicit owners.
