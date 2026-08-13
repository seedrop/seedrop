import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type {
  Wave7ReplayBinding,
  Wave7ResumptionProbe,
  Wave7ResumptionTask,
} from "./readiness.js";
import { isProbeMetadata, isReplayBinding } from "./readiness.js";

export const PR15_REPLAY_VERSION = "1.0.0" as const;
export type Pr15Arm = "repo_only" | "current_v1" | "packet_only" | "v2_situation";

export interface Pr15SanitationEvidence {
  reviewed_by: string;
  reviewed_at: string;
  scanner: string;
  command: string;
  status: "passed";
  source_set_digest: string;
  excluded_secret_paths: string[];
}

export interface Pr15ReplayInput {
  fixture_id: string;
  scenario: string;
  project_name: string;
  repository: {
    repo_id: string;
    commit: string;
    evidence_cutoff: string;
    source_digest: string;
  };
  projection: {
    adapter_situation_json: string;
    situation_id: string;
    decision_id: string;
    semantic_digest: string;
    projection_version: string;
    policy_version: string;
    situation_outcome: "served" | "refused";
  };
  evidence: {
    repo_only: string;
    current_v1: string;
  };
  probes: Wave7ResumptionProbe[];
  sanitation: Pr15SanitationEvidence;
}

export interface FrozenPr15Arm {
  content: string;
  bytes: number;
  digest: string;
}

export interface FrozenPr15Replay extends Wave7ResumptionTask {
  replay_version: typeof PR15_REPLAY_VERSION;
  arms: Record<Pr15Arm, FrozenPr15Arm>;
  fixture_digest: string;
}

export function freezePr15Replay(input: Pr15ReplayInput): FrozenPr15Replay {
  assertInput(input);
  const adapter = parseAdapterSituation(input.projection.adapter_situation_json);
  assertProjectionIdentity(input, adapter);
  const sanitationReceipt = digest(canonicalJson(input.sanitation));
  const binding: Wave7ReplayBinding = {
    fixture_version: PR15_REPLAY_VERSION,
    benchmark_contract_version: "1.0.0",
    repo_id: input.repository.repo_id,
    repo_commit: input.repository.commit,
    evidence_cutoff: input.repository.evidence_cutoff,
    source_digest: input.repository.source_digest,
    situation_id: input.projection.situation_id,
    decision_id: input.projection.decision_id,
    semantic_digest: input.projection.semantic_digest,
    projection_version: input.projection.projection_version,
    policy_version: input.projection.policy_version,
    sanitation_receipt: sanitationReceipt,
    situation_outcome: input.projection.situation_outcome,
  };
  const repo = section("FROZEN REPOSITORY EVIDENCE", input.evidence.repo_only);
  const v1 = section("FROZEN CURRENT V1 ORIENTATION", input.evidence.current_v1);
  const v2 = section("FROZEN V2 SITUATION", input.projection.adapter_situation_json);
  const armText: Record<Pr15Arm, string> = {
    repo_only: repo,
    current_v1: `${v1}\n\n${repo}`,
    packet_only: v2,
    v2_situation: `${v2}\n\n${repo}`,
  };
  const arms = Object.fromEntries(Object.entries(armText).map(([name, content]) =>
    [name, freezeArm(content)])) as Record<Pr15Arm, FrozenPr15Arm>;
  const body = {
    id: input.fixture_id,
    scenario: input.scenario,
    project_name: input.project_name,
    repo_evidence: input.evidence.repo_only,
    boot_packet: input.evidence.current_v1,
    probes: input.probes,
    wave7: binding,
    replay_version: PR15_REPLAY_VERSION,
    arms,
  };
  return deepFreeze({ ...body, fixture_digest: digest(canonicalJson(body)) });
}

export function assertFrozenPr15Replay(input: unknown): asserts input is FrozenPr15Replay {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("fixture_object_required");
  const value = input as Record<string, unknown>;
  if (value.replay_version !== PR15_REPLAY_VERSION || typeof value.fixture_digest !== "string") invalid("fixture_version_or_digest");
  const arms = value.arms as Record<string, FrozenPr15Arm> | undefined;
  for (const name of ["repo_only", "current_v1", "packet_only", "v2_situation"] as Pr15Arm[]) {
    const arm = arms?.[name];
    if (!arm || typeof arm.content !== "string" || arm.bytes !== Buffer.byteLength(arm.content) || arm.digest !== digest(arm.content)) {
      invalid(`arm_invalid:${name}`);
    }
  }
  if (!isReplayBinding(value.wave7 as Wave7ReplayBinding | undefined)) invalid("replay_binding_invalid");
  const probes = value.probes;
  if (!Array.isArray(probes) || probes.length === 0 || probes.some((probe) => {
    const candidate = probe as Wave7ResumptionProbe;
    return !candidate.id || !isProbeMetadata(candidate.wave7,
      ["current_intent", "unsafe_condition", "delivery_state", "relevant_failed_attempt", "evidence_gap", "safest_next_action"]);
  })) invalid("probe_metadata_invalid");
  const { fixture_digest: _fixtureDigest, ...body } = value;
  if (value.fixture_digest !== digest(canonicalJson(body))) invalid("fixture_digest_mismatch");
}

export async function loadFrozenPr15Replays(directory: string): Promise<FrozenPr15Replay[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map(async (name) => {
    const parsed: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
    assertFrozenPr15Replay(parsed);
    return parsed;
  }));
}

export async function freezePr15ReplayFile(inputPath: string, outputPath: string): Promise<FrozenPr15Replay> {
  const candidate = JSON.parse(await readFile(resolve(inputPath), "utf8")) as Pr15ReplayInput;
  const frozen = freezePr15Replay(candidate);
  await writeFile(resolve(outputPath), `${JSON.stringify(frozen, null, 2)}\n`, { flag: "wx" });
  return frozen;
}

function assertInput(input: Pr15ReplayInput): void {
  if (!input.fixture_id || !input.scenario || !input.project_name || !input.repository.repo_id) invalid("identity_required");
  if (!/^[0-9a-f]{40,64}$/.test(input.repository.commit)) invalid("repo_commit_required");
  const cutoff = Date.parse(input.repository.evidence_cutoff);
  if (!Number.isFinite(cutoff) || !isDigest(input.repository.source_digest)) invalid("source_binding_invalid");
  if (!input.evidence.repo_only.trim() || !input.evidence.current_v1.trim() || !input.projection.adapter_situation_json.trim()) {
    invalid("all_arm_sources_required");
  }
  if (input.probes.length === 0) invalid("probe_required");
  for (const probe of input.probes) {
    if (!probe.wave7) invalid(`probe_metadata_required:${probe.id}`);
    if (Date.parse(probe.wave7.ground_truth_observed_at) > cutoff) invalid(`future_ground_truth:${probe.id}`);
  }
  const sanitation = input.sanitation;
  if (sanitation.status !== "passed" || !sanitation.reviewed_by || !sanitation.scanner || !sanitation.command
    || !Number.isFinite(Date.parse(sanitation.reviewed_at)) || !isDigest(sanitation.source_set_digest)
    || sanitation.source_set_digest !== input.repository.source_digest) invalid("sanitation_evidence_invalid");
  if (!Array.isArray(sanitation.excluded_secret_paths)) invalid("sanitation_exclusions_required");
}

function parseAdapterSituation(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("adapter_situation_object_required");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid PR-15 replay")) throw error;
    return invalid("adapter_situation_json_invalid");
  }
}

function assertProjectionIdentity(input: Pr15ReplayInput, adapter: Record<string, unknown>): void {
  for (const field of ["situation_id", "decision_id", "semantic_digest"] as const) {
    if (!isDigest(input.projection[field]) || adapter[field] !== input.projection[field]) invalid(`projection_identity_mismatch:${field}`);
  }
  if (adapter.adapter_version !== input.projection.projection_version || adapter.mutation_capability !== "read_only") {
    invalid("projection_version_or_capability");
  }
  const { semantic_digest: _semanticDigest, ...semanticBody } = adapter;
  if (adapter.semantic_digest !== digest(canonicalJson(semanticBody))) invalid("adapter_semantic_digest_mismatch");
  const decision = adapter.decision as Record<string, unknown> | undefined;
  const refused = decision?.disposition === "refuse";
  if ((input.projection.situation_outcome === "refused") !== refused) invalid("situation_outcome_mismatch");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const inputPath = flag("input"), outputPath = flag("out");
  if (!inputPath || !outputPath) throw new Error("Usage: replay.ts --input <candidate.json> --out <frozen.json>");
  const frozen = await freezePr15ReplayFile(inputPath, outputPath);
  process.stdout.write(`${JSON.stringify({ ok: true, fixture_id: frozen.id, fixture_digest: frozen.fixture_digest,
    output: resolve(outputPath) })}\n`);
}

function freezeArm(content: string): FrozenPr15Arm {
  return deepFreeze({ content, bytes: Buffer.byteLength(content), digest: digest(content) });
}

function section(label: string, content: string): string {
  return `=== ${label} ===\n${content.trimEnd()}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return invalid("unsupported_canonical_value");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function invalid(reason: string): never {
  throw new Error(`Invalid PR-15 replay: ${reason}.`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

if (process.argv[1] && process.argv[1].endsWith("replay.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
