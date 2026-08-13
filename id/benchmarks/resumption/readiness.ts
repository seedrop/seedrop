#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRepo, linkedRoots } from "./extract.js";
import type { ResumptionProbe, ResumptionTask } from "./types.js";

export type Pr15ProbeClass =
  | "current_intent"
  | "unsafe_condition"
  | "delivery_state"
  | "relevant_failed_attempt"
  | "evidence_gap"
  | "safest_next_action";

export interface Pr15Contract {
  schema_version: "1.0.0";
  benchmark_id: string;
  arms: string[];
  primary_arms: string[];
  probe_classes: Pr15ProbeClass[];
  metrics: string[];
  thresholds: Record<string, unknown>;
  corpus_readiness: {
    min_independent_ground_truths: number;
    min_repositories: number;
    max_single_repository_share: number;
    min_per_probe_class: number;
    min_successful_situation_fixtures: number;
    min_explicit_refusal_fixtures: number;
    require_frozen_replay_bindings: boolean;
    require_explicit_independence_keys: boolean;
    require_task_linkage_for_safest_next_action: boolean;
  };
}

export interface Wave7ProbeMetadata {
  probe_class: Pr15ProbeClass;
  independence_key: string;
  ground_truth_source_digest: string;
  ground_truth_observed_at: string;
  task_linked?: boolean;
}

export interface Wave7ReplayBinding {
  fixture_version: "1.0.0";
  benchmark_contract_version: "1.0.0";
  repo_id: string;
  repo_commit: string;
  evidence_cutoff: string;
  source_digest: string;
  situation_id: string;
  decision_id: string;
  semantic_digest: string;
  projection_version: string;
  policy_version: string;
  sanitation_receipt: string;
  situation_outcome: "served" | "refused";
}

export interface Wave7ResumptionProbe extends ResumptionProbe {
  wave7?: Wave7ProbeMetadata;
}

export interface Wave7ResumptionTask extends ResumptionTask {
  wave7?: Wave7ReplayBinding;
  probes: Wave7ResumptionProbe[];
}

export interface ReadinessCheck {
  id: string;
  passed: boolean;
  observed: number | boolean;
  required: number | boolean | string;
}

export interface CorpusReadinessReport {
  schema_version: "1.0.0";
  benchmark_id: string;
  ready_for_model_spend: boolean;
  fixtures: number;
  observed_independent_ground_truths: number;
  eligible_independent_ground_truths: number;
  observed_repositories: number;
  eligible_repositories: number;
  observed_probe_types: Record<string, number>;
  probe_classes: Record<Pr15ProbeClass, number>;
  situation_outcomes: { served: number; refused: number; unspecified: number };
  duplicate_independence_keys: number;
  legacy_or_unbound_fixtures: number;
  invalid_probe_metadata: number;
  future_ground_truths: number;
  checks: ReadinessCheck[];
  blockers: string[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;

export function evaluateCorpusReadiness(
  tasks: readonly Wave7ResumptionTask[],
  contract: Pr15Contract,
): CorpusReadinessReport {
  assertContract(contract);
  const classCounts = Object.fromEntries(contract.probe_classes.map((name) => [name, 0])) as Record<Pr15ProbeClass, number>;
  const repositories = new Set<string>();
  const independenceKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  const observedKeys = new Set<string>();
  const eligibleByRepo = new Map<string, number>();
  const observedProbeTypes = new Map<string, number>();
  const outcomes = { served: 0, refused: 0, unspecified: 0 };
  let legacyOrUnbound = 0;
  let safestNextActionWithoutTaskLink = 0;
  let invalidProbeMetadata = 0;
  let futureGroundTruths = 0;

  for (const task of tasks) {
    const bindingValid = isReplayBinding(task.wave7);
    if (!bindingValid) legacyOrUnbound += 1;
    const repoId = task.wave7?.repo_id ?? task.project_name;
    repositories.add(repoId);
    if (task.wave7?.situation_outcome === "served") outcomes.served += 1;
    else if (task.wave7?.situation_outcome === "refused") outcomes.refused += 1;
    else outcomes.unspecified += 1;

    for (const probe of task.probes) {
      observedProbeTypes.set(probe.id, (observedProbeTypes.get(probe.id) ?? 0) + 1);
      const observedKey = probe.wave7?.independence_key ?? legacyIndependenceKey(task, probe);
      observedKeys.add(observedKey);
      const metadataValid = isProbeMetadata(probe.wave7, contract.probe_classes);
      if (!metadataValid) invalidProbeMetadata += 1;
      if (!bindingValid || !metadataValid) continue;
      const metadata = probe.wave7!;
      if (Date.parse(metadata.ground_truth_observed_at) > Date.parse(task.wave7!.evidence_cutoff)) {
        futureGroundTruths += 1;
        continue;
      }
      if (independenceKeys.has(metadata.independence_key)) {
        duplicateKeys.add(metadata.independence_key);
        continue;
      }
      independenceKeys.add(metadata.independence_key);
      classCounts[metadata.probe_class] += 1;
      eligibleByRepo.set(repoId, (eligibleByRepo.get(repoId) ?? 0) + 1);
      if (metadata.probe_class === "safest_next_action" && metadata.task_linked !== true) {
        safestNextActionWithoutTaskLink += 1;
      }
    }
  }

  const ready = contract.corpus_readiness;
  const eligible = independenceKeys.size;
  const largestRepoShare = eligible === 0 ? 1 : Math.max(0, ...eligibleByRepo.values()) / eligible;
  const checks: ReadinessCheck[] = [
    check("independent_ground_truths", eligible, ready.min_independent_ground_truths, eligible >= ready.min_independent_ground_truths),
    check("repository_coverage", eligibleByRepo.size, ready.min_repositories, eligibleByRepo.size >= ready.min_repositories),
    check("single_repository_concentration", largestRepoShare, `<=${ready.max_single_repository_share}`,
      largestRepoShare <= ready.max_single_repository_share),
    check("frozen_replay_bindings", legacyOrUnbound === 0, true,
      !ready.require_frozen_replay_bindings || legacyOrUnbound === 0),
    check("probe_metadata_complete", invalidProbeMetadata, 0, invalidProbeMetadata === 0),
    check("no_future_ground_truth", futureGroundTruths, 0, futureGroundTruths === 0),
    check("unique_independence_keys", duplicateKeys.size, 0, duplicateKeys.size === 0),
    check("explicit_independence_keys", eligible, observedKeys.size,
      !ready.require_explicit_independence_keys || eligible === observedKeys.size),
    check("successful_situation_coverage", outcomes.served, ready.min_successful_situation_fixtures,
      outcomes.served >= ready.min_successful_situation_fixtures),
    check("explicit_refusal_coverage", outcomes.refused, ready.min_explicit_refusal_fixtures,
      outcomes.refused >= ready.min_explicit_refusal_fixtures),
    check("task_linked_safest_next_action", safestNextActionWithoutTaskLink, 0,
      !ready.require_task_linkage_for_safest_next_action || safestNextActionWithoutTaskLink === 0),
    ...contract.probe_classes.map((probeClass) => check(`probe_class:${probeClass}`, classCounts[probeClass],
      ready.min_per_probe_class, classCounts[probeClass] >= ready.min_per_probe_class)),
  ];
  const blockers = checks.filter((item) => !item.passed).map((item) => item.id);
  return {
    schema_version: "1.0.0",
    benchmark_id: contract.benchmark_id,
    ready_for_model_spend: blockers.length === 0,
    fixtures: tasks.length,
    observed_independent_ground_truths: observedKeys.size,
    eligible_independent_ground_truths: eligible,
    observed_repositories: repositories.size,
    eligible_repositories: eligibleByRepo.size,
    observed_probe_types: Object.fromEntries([...observedProbeTypes.entries()].sort(([a], [b]) => a.localeCompare(b))),
    probe_classes: classCounts,
    situation_outcomes: outcomes,
    duplicate_independence_keys: duplicateKeys.size,
    legacy_or_unbound_fixtures: legacyOrUnbound,
    invalid_probe_metadata: invalidProbeMetadata,
    future_ground_truths: futureGroundTruths,
    checks,
    blockers,
  };
}

export async function readPr15Contract(path = defaultContractPath()): Promise<Pr15Contract> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Pr15Contract;
  assertContract(parsed);
  return parsed;
}

export async function loadWave7Fixtures(directory: string): Promise<Wave7ResumptionTask[]> {
  const { loadFrozenPr15Replays } = await import("./replay.js");
  return loadFrozenPr15Replays(directory);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const contract = await readPr15Contract(flag("contract") ? resolve(flag("contract")!) : undefined);
  let tasks: Wave7ResumptionTask[];
  if (argv.includes("--corpus")) {
    tasks = linkedRoots().flatMap((root) => extractRepo(root) as Wave7ResumptionTask[]);
  } else {
    const fixtures = flag("fixtures");
    if (!fixtures) throw new Error("Pass --corpus or --fixtures <directory>.");
    tasks = await loadWave7Fixtures(resolve(fixtures));
  }
  const report = evaluateCorpusReadiness(tasks, contract);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready_for_model_spend && !argv.includes("--allow-not-ready")) process.exitCode = 2;
}

function defaultContractPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "pr15-contract.json");
}

export function isReplayBinding(input: Wave7ReplayBinding | undefined): input is Wave7ReplayBinding {
  return input?.fixture_version === "1.0.0"
    && input.benchmark_contract_version === "1.0.0"
    && typeof input.repo_id === "string" && input.repo_id.length > 0
    && COMMIT.test(input.repo_commit)
    && Number.isFinite(Date.parse(input.evidence_cutoff))
    && [input.source_digest, input.situation_id, input.decision_id, input.semantic_digest].every((value) => DIGEST.test(value))
    && typeof input.projection_version === "string" && input.projection_version.length > 0
    && typeof input.policy_version === "string" && input.policy_version.length > 0
    && DIGEST.test(input.sanitation_receipt)
    && (input.situation_outcome === "served" || input.situation_outcome === "refused");
}

export function isProbeMetadata(input: Wave7ProbeMetadata | undefined, classes: readonly Pr15ProbeClass[]): input is Wave7ProbeMetadata {
  return Boolean(input && classes.includes(input.probe_class) && input.independence_key.length > 0
    && DIGEST.test(input.ground_truth_source_digest) && Number.isFinite(Date.parse(input.ground_truth_observed_at)));
}

function legacyIndependenceKey(task: ResumptionTask, probe: ResumptionProbe): string {
  const truth = probe.check.kind === "llm" ? probe.check.question : `${probe.check.pattern}:${probe.check.correct_when}`;
  return createHash("sha256").update(`${task.project_name}\0${probe.id}\0${truth}`).digest("hex");
}

function check(id: string, observed: number | boolean, required: number | boolean | string, passed: boolean): ReadinessCheck {
  return { id, passed, observed, required };
}

function assertContract(input: Pr15Contract): void {
  if (input.schema_version !== "1.0.0" || !input.benchmark_id) throw new Error("Invalid PR-15 contract identity.");
  if (new Set(input.arms).size !== 4 || !["repo_only", "current_v1", "packet_only", "v2_situation"].every((arm) => input.arms.includes(arm))) {
    throw new Error("PR-15 contract must freeze all four benchmark arms.");
  }
  if (input.probe_classes.length !== 6 || new Set(input.probe_classes).size !== input.probe_classes.length) {
    throw new Error("PR-15 contract must freeze six distinct probe classes.");
  }
  const ready = input.corpus_readiness;
  if (!Number.isSafeInteger(ready.min_independent_ground_truths) || ready.min_independent_ground_truths < 1
    || !Number.isSafeInteger(ready.min_repositories) || ready.min_repositories < 1
    || ready.max_single_repository_share <= 0 || ready.max_single_repository_share > 1
    || !Number.isSafeInteger(ready.min_per_probe_class) || ready.min_per_probe_class < 1) {
    throw new Error("Invalid PR-15 corpus readiness thresholds.");
  }
}

if (process.argv[1] && process.argv[1].endsWith("readiness.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
