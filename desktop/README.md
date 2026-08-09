# Seedrop Desktop — developer preview

Human installer and viewer for Seedrop on macOS.

Do not distribute a build until `npm run release:verify` passes against a signed and notarized artifact. A source-tree smoke test is not release evidence.

- **Wizard-first** — scans the machine before mutation, then either adopts an existing Seedrop setup unchanged or explicitly installs and manages the sealed runtime, MCP clients, and daemon.
- **At-a-glance UI** — projects, tasks, and runs as simple cards (not Bench’s continuity debugger).

## Develop

```bash
# from repo root
npm install
npm run build -w @seedrop/observer

cd desktop
npm run fetch-runtime   # downloads and verifies Node 20 for the current architecture
npm run prepare-runtime # builds the versioned CLI/MCP/observer payload
npm run tauri:dev
```

Debug builds can point at an already-prepared sealed payload and an isolated support root:

```bash
export SEEDROP_DESKTOP_RELEASE=/path/to/resources/release
export SEEDROP_DESKTOP_SUPPORT_ROOT=/tmp/seedrop-desktop-support
```

Development overrides are accepted only by debug builds. Release builds use the verified app-managed payload and never resolve the source tree.

The source workspace may install a source-first launchd daemon only through the explicit non-release profile: `seed daemon install --profile dev`. A sealed Desktop invocation omits that flag, verifies its manifest, pins both Node and CLI to the content-addressed runtime, and exposes the manifest hash as `build_hash` in `/health`.

## Smoke

```bash
npm run smoke -w @seedrop/desktop
npm run test:runtime -w @seedrop/desktop
npm run artifact:verify -w @seedrop/desktop # local/CI artifact invariants; does not claim signing
npm run dmg:verify -w @seedrop/desktop      # mounts the distributable and verifies its embedded app
npm run release:verify -w @seedrop/desktop
npm run release:dmg:verify -w @seedrop/desktop
```

For a cross-architecture check, set `SEEDROP_DESKTOP_ARCH=x64` (or `arm64`) so runtime tests and Tauri’s `beforeBuildCommand` share the same explicit target.

## Architecture

Desktop never becomes a second source of truth. ID/View/Space and the Seedrop setup journal remain authoritative. Desktop invokes compiled CLI/MCP/observer entrypoints through the exact Node binary installed from its verified runtime payload.

### Existing-install contract

- The first setup read scans the canonical passport, Space data, setup journal, launchd plist, MCP client configs, and common npm/version-manager locations for `seed`.
- Detection is read-only: candidate CLIs are classified from their paths and symlink targets, never executed.
- A valid existing operator setup can be adopted. Adoption installs only Desktop's side-by-side runtime and records `mode: adopted_existing`; it does not rewrite the passport, Space data, MCP configuration, or daemon ownership.
- Partial or invalid evidence fails closed. Managed takeover requires a separate explicit choice and confirmation listing the ownership it will replace.

### Runtime and activation contract

- Build one thin payload per macOS architecture. Node is downloaded from the official distribution, checked against `SHASUMS256.txt`, and recorded by version and archive digest.
- External production dependencies come from `runtime/package-lock.json`; local Seedrop packages come from freshly compiled workspace tarballs. `runtime-provenance.json` records the exact shipped graph.
- The payload is symlink-free, fully enumerated, and SHA-256 sealed. First launch performs no npm install and makes no network request.
- Installation is content-addressed and side-by-side. Before the active pointer changes, Desktop executes the bundled Node, CLI, Observer, and native SQLite store. A failed copy, integrity check, or probe leaves the prior runtime active.
- Every later invocation compares the installed manifest with the manifest sealed inside the running app. A self-consistent but modified Application Support payload is not trusted.
- Previous payloads are retained. Rolling back the signed app reactivates the payload sealed by that app; a new app never silently trusts an older app’s external runtime.

### Release contract

`artifact:verify` proves unsigned local/CI invariants: exact version parity, host architecture, CSP, payload hashes and file modes, clean-home execution, required components, and the application size budget. It deliberately does not make a release claim.

`release:verify` adds the non-negotiable application checks: Developer ID identity, strict code-signature validation, Gatekeeper assessment, and a valid notarization staple. `release:dmg:verify` verifies the disk image, mounts it read-only, applies the complete app gate to the embedded bundle, and requires Gatekeeper plus a staple on the distributable itself. Until the DMG command passes on both architecture artifacts, Desktop remains a developer preview.

The clean-machine, update, evidence, and rollback procedure is defined in [RELEASE.md](./RELEASE.md).
