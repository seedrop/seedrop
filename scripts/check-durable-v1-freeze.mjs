#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const FREEZE_SCHEMA_VERSION = "seedrop-durable-v1-freeze/1.0";
export const DEFAULT_MANIFEST = "docs/v2/durable-v1-contract.json";

const CONTRACT_SOURCES = [
  { path: "id/src/schema.ts", mode: "zod" },
  { path: "id/src/audit.ts", names: ["PassportChanges", "AuditEntry"] },
  {
    path: "id/src/commit-journal.ts",
    names: ["PassportChangesSchema", "AuditEntrySchema", "CommitJournalRecordSchema"],
  },
  { path: "space/src/schema.ts", mode: "zod" },
  { path: "space/src/schema-migrations.ts", mode: "migration-chains" },
  { path: "space/src/live.ts", names: ["SCHEMA_STATEMENTS"] },
  { path: "space/src/mentions.ts", names: ["MentionAckResult", "MentionRecord", "ACK_RESULTS"] },
  { path: "space/src/cli.ts", names: ["readSessionState", "writeSessionState"] },
  { path: "cli/src/active-passport.ts", names: ["SCHEMA_VERSION", "ActivePassportState"] },
  { path: "cli/src/continuity-state.ts", names: ["SCHEMA_VERSION", "ContinuityState"] },
  {
    path: "cli/src/router.ts",
    names: [
      "SETUP_SCHEMA_VERSION",
      "SETUP_STEP_IDS",
      "SetupStepId",
      "SetupStepStatus",
      "SetupStatus",
      "SetupJournalStep",
      "SetupJournal",
    ],
  },
];

const CHANGE_CLASSES = new Set(["safety-repair", "versioned-migration"]);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function declarationName(node) {
  if (ts.isVariableStatement(node)) {
    if (node.declarationList.declarations.length !== 1) return null;
    const name = node.declarationList.declarations[0].name;
    return ts.isIdentifier(name) ? name.text : null;
  }
  if (
    ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isEnumDeclaration(node)
  ) {
    return node.name?.text ?? null;
  }
  return null;
}

function declarationKind(node) {
  if (ts.isVariableStatement(node)) return "variable";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isEnumDeclaration(node)) return "enum";
  return "unknown";
}

function initializerText(node, sourceFile) {
  if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) return "";
  return node.declarationList.declarations[0].initializer?.getText(sourceFile) ?? "";
}

function selectedDeclarations(spec, sourceFile) {
  const named = new Set(spec.names ?? []);
  const selected = [];
  for (const node of sourceFile.statements) {
    const name = declarationName(node);
    if (!name) continue;
    if (named.has(name)) selected.push(node);
    else if (spec.mode === "migration-chains" && name.endsWith("MigrationChain")) selected.push(node);
    else if (spec.mode === "zod") {
      const initializer = initializerText(node, sourceFile);
      if (name.endsWith("Schema") || initializer.includes("z.")) selected.push(node);
    }
  }
  if (named.size > 0) {
    const found = new Set(selected.map(declarationName));
    const missing = [...named].filter((name) => !found.has(name));
    if (missing.length > 0) throw new Error(`${spec.path}: tracked declaration(s) missing: ${missing.join(", ")}`);
  }
  if (selected.length === 0) throw new Error(`${spec.path}: freeze selector found no declarations`);
  return selected;
}

function normalizedDeclaration(node, sourceFile) {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replaceAll("\r\n", "\n").trim();
}

function assertInsideRepo(repoRoot, path, label) {
  const rel = relative(repoRoot, path);
  if (!rel || rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${label} must stay inside the repository: ${path}`);
}

export function createContractSnapshot(repoRoot = process.cwd(), options = {}) {
  const root = resolve(repoRoot);
  const extractorPath = resolve(options.extractorPath ?? fileURLToPath(import.meta.url));
  const artifacts = [];
  for (const spec of CONTRACT_SOURCES) {
    const absolute = resolve(root, spec.path);
    assertInsideRepo(root, absolute, "contract source");
    if (!existsSync(absolute)) throw new Error(`Durable contract source is missing: ${spec.path}`);
    const sourceText = readFileSync(absolute, "utf8");
    const sourceFile = ts.createSourceFile(spec.path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics = sourceFile.parseDiagnostics ?? [];
    if (diagnostics.length > 0) throw new Error(`TypeScript parse failure in durable contract source: ${spec.path}`);
    for (const node of selectedDeclarations(spec, sourceFile)) {
      const name = declarationName(node);
      const canonical = normalizedDeclaration(node, sourceFile);
      artifacts.push({
        id: `${spec.path}#${name}`,
        source: spec.path,
        declaration: name,
        kind: declarationKind(node),
        sha256: sha256(canonical),
      });
    }
  }
  artifacts.sort((a, b) => a.id.localeCompare(b.id));
  const snapshot = {
    extractor_sha256: sha256(readFileSync(extractorPath)),
    artifacts,
  };
  return { ...snapshot, contract_sha256: sha256(canonicalJson(snapshot)) };
}

function readDecision(repoRoot, decisionPath, expectedClass) {
  if (!decisionPath.startsWith("docs/adr/") || !decisionPath.endsWith(".md")) {
    throw new Error("Accepted decision must be a Markdown ADR under docs/adr/");
  }
  const absolute = resolve(repoRoot, decisionPath);
  assertInsideRepo(repoRoot, absolute, "decision");
  if (!existsSync(absolute)) throw new Error(`Accepted decision does not exist: ${decisionPath}`);
  const text = readFileSync(absolute, "utf8");
  if (!/^[-*]\s+\*\*Status:\*\*\s+accepted\b/im.test(text)) {
    throw new Error(`${decisionPath}: decision status must be accepted`);
  }
  const match = text.match(/^[-*]\s+\*\*Durable v1 change class:\*\*\s+([a-z-]+)\s*$/im);
  if (!match) throw new Error(`${decisionPath}: missing Durable v1 change class metadata`);
  if (match[1] !== expectedClass) {
    throw new Error(`${decisionPath}: decision class ${match[1]} does not match transition class ${expectedClass}`);
  }
  if (!/^## Decision\s*$/im.test(text)) throw new Error(`${decisionPath}: missing Decision section`);
  return true;
}

export function createInitialManifest(snapshot, decision = "docs/adr/0002-freeze-durable-v1.md") {
  return {
    schema_version: FREEZE_SCHEMA_VERSION,
    policy: {
      durable_v1: "frozen",
      permitted_future_changes: ["safety-repair", "versioned-migration"],
      decision_requirement: "accepted ADR under docs/adr with matching Durable v1 change class metadata",
    },
    current: snapshot,
    accepted_transitions: [
      {
        id: "DC-01-initial-freeze",
        class: "initial-freeze",
        decision,
        from_sha256: null,
        to_sha256: snapshot.contract_sha256,
      },
    ],
  };
}

function assertManifestShape(manifest) {
  if (manifest.schema_version !== FREEZE_SCHEMA_VERSION) throw new Error("Unsupported durable-v1 freeze manifest schema");
  if (!manifest.current?.contract_sha256 || !Array.isArray(manifest.current.artifacts)) {
    throw new Error("Durable-v1 freeze manifest has no current contract snapshot");
  }
  if (!Array.isArray(manifest.accepted_transitions) || manifest.accepted_transitions.length === 0) {
    throw new Error("Durable-v1 freeze manifest has no accepted transition history");
  }
}

function validateTransitionHistory(repoRoot, manifest) {
  let previous = null;
  for (const [index, transition] of manifest.accepted_transitions.entries()) {
    if (transition.from_sha256 !== previous) throw new Error(`Transition ${transition.id ?? index} does not chain from the prior contract`);
    if (index === 0) {
      if (transition.class !== "initial-freeze") throw new Error("The first durable-v1 transition must be initial-freeze");
      readDecision(repoRoot, transition.decision, "initial-freeze");
    } else {
      if (!CHANGE_CLASSES.has(transition.class)) throw new Error(`Transition ${transition.id ?? index} has an invalid change class`);
      readDecision(repoRoot, transition.decision, transition.class);
    }
    if (!/^[a-f0-9]{64}$/.test(transition.to_sha256 ?? "")) throw new Error(`Transition ${transition.id ?? index} has no valid target hash`);
    previous = transition.to_sha256;
  }
  if (previous !== manifest.current.contract_sha256) throw new Error("Transition history does not terminate at the current contract hash");
}

export function checkContract(repoRoot = process.cwd(), options = {}) {
  const root = resolve(repoRoot);
  const manifestPath = resolve(root, options.manifestPath ?? DEFAULT_MANIFEST);
  assertInsideRepo(root, manifestPath, "manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertManifestShape(manifest);
  validateTransitionHistory(root, manifest);
  const actual = createContractSnapshot(root, options);
  if (canonicalJson(actual) !== canonicalJson(manifest.current)) {
    const expected = new Map(manifest.current.artifacts.map((artifact) => [artifact.id, artifact.sha256]));
    const observed = new Map(actual.artifacts.map((artifact) => [artifact.id, artifact.sha256]));
    const changed = [...new Set([...expected.keys(), ...observed.keys()])]
      .filter((id) => expected.get(id) !== observed.get(id))
      .sort();
    const extractorChanged = actual.extractor_sha256 !== manifest.current.extractor_sha256;
    const detail = [extractorChanged ? "freeze extractor" : null, ...changed].filter(Boolean).join(", ");
    throw new Error(
      `Durable v1 contract changed without an accepted transition${detail ? `: ${detail}` : ""}. `
      + "Add an accepted ADR, then run the explicit accept command with safety-repair or versioned-migration.",
    );
  }
  return {
    status: "passed",
    contract_sha256: actual.contract_sha256,
    artifacts: actual.artifacts.length,
    accepted_transitions: manifest.accepted_transitions.length,
  };
}

export function acceptContract(repoRoot = process.cwd(), options = {}) {
  const root = resolve(repoRoot);
  if (!CHANGE_CLASSES.has(options.changeClass)) {
    throw new Error("accept requires --class safety-repair|versioned-migration");
  }
  if (!options.decision) throw new Error("accept requires --decision docs/adr/<accepted-decision>.md");
  readDecision(root, options.decision, options.changeClass);
  const manifestPath = resolve(root, options.manifestPath ?? DEFAULT_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertManifestShape(manifest);
  validateTransitionHistory(root, manifest);
  const snapshot = createContractSnapshot(root, options);
  if (snapshot.contract_sha256 === manifest.current.contract_sha256) throw new Error("Durable v1 contract has not changed");
  const transition = {
    id: options.id ?? `accepted-${manifest.accepted_transitions.length + 1}`,
    class: options.changeClass,
    decision: options.decision,
    from_sha256: manifest.current.contract_sha256,
    to_sha256: snapshot.contract_sha256,
  };
  const next = {
    ...manifest,
    current: snapshot,
    accepted_transitions: [...manifest.accepted_transitions, transition],
  };
  if (options.write === true) writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function parseArgs(argv) {
  const command = argv[0] ?? "check";
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return { command, options };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(options.repo ?? process.cwd());
  let result;
  if (command === "check") result = checkContract(repoRoot, { manifestPath: options.manifest });
  else if (command === "snapshot") result = createContractSnapshot(repoRoot);
  else if (command === "initial-manifest") result = createInitialManifest(createContractSnapshot(repoRoot), options.decision);
  else if (command === "accept") {
    result = acceptContract(repoRoot, {
      manifestPath: options.manifest,
      decision: options.decision,
      changeClass: options.class,
      id: options.id,
      write: true,
    });
  } else {
    throw new Error("Usage: check-durable-v1-freeze.mjs check | snapshot | initial-manifest --decision docs/adr/... | accept --class safety-repair|versioned-migration --decision docs/adr/... [--id ID]");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`durable-v1-freeze: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
