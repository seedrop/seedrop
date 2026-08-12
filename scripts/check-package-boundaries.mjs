import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const adapterResponsibilities = new Set(["transport", "presentation", "observation_adapter", "evaluation_adapter"]);

export async function inspectPackageBoundaries(root = scriptRoot) {
  const rootPackage = await readJson(join(root, "package.json"));
  const contract = await readJson(join(root, "architecture", "package-boundaries.json"));
  const manifests = new Map();

  for (const workspace of rootPackage.workspaces ?? []) {
    if (workspace.includes("*")) throw new Error(`Workspace globs are not supported by the boundary check: ${workspace}`);
    const manifest = await readJson(join(root, workspace, "package.json"));
    manifests.set(manifest.name, { workspace, manifest });
  }

  const errors = [];
  const graph = new Map([...manifests].map(([name, entry]) => [name, internalDependencies(entry.manifest, manifests)]));

  for (const [name, rule] of Object.entries(contract.packages)) {
    const entry = manifests.get(name);
    if (!entry) {
      errors.push(`Contract package ${name} is not a root workspace.`);
      continue;
    }
    if (entry.workspace !== rule.workspace) {
      errors.push(`${name} must live in ${rule.workspace}, found ${entry.workspace}.`);
    }
    const actual = graph.get(name) ?? [];
    const allowed = new Set(rule.allowed_internal_dependencies);
    for (const dependency of actual) {
      if (!allowed.has(dependency)) errors.push(`${name} may not depend on ${dependency}.`);
    }
    for (const dependency of allowed) {
      if (!actual.includes(dependency)) errors.push(`${name} must depend on ${dependency}.`);
    }
  }

  const cycles = findDependencyCycles(graph);
  for (const cycle of cycles) errors.push(`Workspace dependency cycle: ${cycle.join(" -> ")}`);

  for (const [adapter, responsibilities] of Object.entries(contract.adapters)) {
    if (!manifests.has(adapter)) errors.push(`Declared adapter ${adapter} is not a root workspace.`);
    for (const responsibility of responsibilities) {
      if (!adapterResponsibilities.has(responsibility)) {
        errors.push(`${adapter} declares domain responsibility ${responsibility}; adapters may only translate, observe, evaluate, or present.`);
      }
    }
  }

  for (const shadowPackage of contract.shadow_only_packages) {
    for (const [consumer, dependencies] of graph) {
      if (!contract.shadow_only_packages.includes(consumer) && dependencies.includes(shadowPackage)) {
        errors.push(`${consumer} connects to shadow-only ${shadowPackage}; v1 must remain authoritative.`);
      }
    }
    for (const [consumer, entry] of manifests) {
      if (contract.shadow_only_packages.includes(consumer)) continue;
      const sourceRoot = join(root, entry.workspace, "src");
      for (const path of await sourceFiles(sourceRoot)) {
        const source = await readFile(path, "utf8");
        if (source.includes(`\"${shadowPackage}`) || source.includes(`'${shadowPackage}`)) {
          errors.push(`${consumer} source imports shadow-only ${shadowPackage} from ${path.slice(root.length + 1)}.`);
        }
      }
    }
  }

  if (contract.rules.adapters_own_domain_semantics !== false) {
    errors.push("Architecture contract must state that adapters do not own domain semantics.");
  }
  if (contract.rules.v1_writers_remain_authoritative !== true) {
    errors.push("Architecture contract must keep v1 writers authoritative during Wave 3.");
  }
  if (contract.rules.custom_database_is_main_path !== false) {
    errors.push("Architecture contract must keep the custom database off the v2 main path.");
  }
  if (contract.rules.wave_4_cutover_authorized !== false) {
    errors.push("Architecture contract must forbid cutover during Wave 4.");
  }
  if (contract.rules.migration_v1_source_access !== "read_only") {
    errors.push("Architecture contract must keep migration access to v1 sources read-only.");
  }
  if (contract.rules.wave_5_shadow_mismatch_behavior !== "serve_v1") {
    errors.push("Wave 5 projection mismatch must keep the v1 surface served.");
  }

  return {
    schema_version: contract.schema_version,
    workspace_count: manifests.size,
    edge_count: [...graph.values()].reduce((sum, dependencies) => sum + dependencies.length, 0),
    cycles,
    errors,
    ok: errors.length === 0,
  };
}

export function findDependencyCycles(graph) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const path = [];

  const visit = (node) => {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      cycles.push([...path.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    path.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    path.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of [...graph.keys()].sort()) visit(node);
  return cycles;
}

function internalDependencies(manifest, manifests) {
  const dependencies = new Set();
  for (const field of dependencyFields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (manifests.has(name)) dependencies.add(name);
    }
  }
  return [...dependencies].sort();
}

async function sourceFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inspectPackageBoundaries();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
