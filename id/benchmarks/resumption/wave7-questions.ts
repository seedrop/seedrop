import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pr15ProbeResult, Wave7PromptMode } from "./pr15-runner.js";
import type { Pr15Arm } from "./replay.js";

export const WAVE7_QUESTIONS_ID = "seedrop.pr15.wave7.questions.v1" as const;
const Q1_ARMS = ["v2_situation", "packet_only", "current_v1"] as const;

export interface Wave7QuestionsContract {
  schema_version: "1.0.0";
  questions_id: typeof WAVE7_QUESTIONS_ID;
  frozen_at: string;
  q1: {
    id: "served_replacement_economics";
    situation_outcomes: ["served"];
    prompt_mode: "untutored";
    arms: ["v2_situation", "packet_only", "current_v1"];
    metrics: ["safe_action_correct", "missed_uncommitted_work", "repeated_dead_work"];
  };
  q2: {
    id: "refusal_provenance";
    situation_outcomes: ["refused"];
    prompt_modes: ["untutored", "tutored_refuse"];
    arms: ["v2_situation"];
    v2_win_prompt_mode: "untutored";
  };
  limitations: string[];
}

export interface Wave7ArmRates {
  n: number;
  safe_action_correctness: number;
  missed_uncommitted_work_rate: number;
  repeated_dead_work_rate: number;
}

export interface Wave7QuestionScore {
  q1: {
    eligible: boolean;
    exclusion_reason: string | null;
    n: number;
    metrics: {
      safe_action_correctness: Record<(typeof Q1_ARMS)[number], number>;
      missed_uncommitted_work_rate: Record<(typeof Q1_ARMS)[number], number>;
      repeated_dead_work_rate: Record<(typeof Q1_ARMS)[number], number>;
    };
    v2_beats_packet_only: boolean | null;
    v2_beats_current_v1: boolean | null;
  };
  q2: {
    eligible: boolean;
    attribution: "situation" | "tutoring" | "mixed" | "ineligible";
    situation_caused_refusals: number;
    tutored_only_refusals: number;
  };
  wave7_v2_win: false;
}

export async function readWave7QuestionsContract(
  path = join(dirname(fileURLToPath(import.meta.url)), "pr15-wave7-questions.json"),
): Promise<Wave7QuestionsContract> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Wave7QuestionsContract;
  if (parsed.schema_version !== "1.0.0" || parsed.questions_id !== WAVE7_QUESTIONS_ID
    || parsed.q1.prompt_mode !== "untutored"
    || parsed.q1.arms.join("\0") !== Q1_ARMS.join("\0")
    || parsed.q2.v2_win_prompt_mode !== "untutored"
    || parsed.q2.prompt_modes.join("\0") !== "untutored\0tutored_refuse") {
    throw new Error("Invalid Wave 7 questions contract.");
  }
  return parsed;
}

export function canaryAnswersWave7Questions(canary: { purpose: string; arms: readonly string[] }): boolean {
  return canary.purpose === "wave7_product_questions"
    && Q1_ARMS.every((arm) => canary.arms.includes(arm));
}

export function promptModeOf(result: Pr15ProbeResult): Wave7PromptMode {
  return result.prompt_mode ?? "tutored_refuse";
}

export function scoreWave7Questions(
  results: readonly Pr15ProbeResult[],
  contract: Wave7QuestionsContract,
): Wave7QuestionScore {
  const q1Rows = results.filter((result) => result.situation_outcome === "served"
    && promptModeOf(result) === contract.q1.prompt_mode
    && (contract.q1.arms as readonly Pr15Arm[]).includes(result.arm));
  const q1ByArm = Object.fromEntries(Q1_ARMS.map((arm) => [arm, rates(q1Rows.filter((row) => row.arm === arm))])) as
    Record<(typeof Q1_ARMS)[number], Wave7ArmRates>;
  const q1Missing = Q1_ARMS.filter((arm) => q1ByArm[arm].n === 0);
  const q1Eligible = q1Missing.length === 0;
  const q1Reason = q1Eligible ? null
    : results.some((result) => result.situation_outcome === "served" && promptModeOf(result) !== "untutored")
      ? "Q1 requires untutored prompts; tutored refuse=true results are excluded"
      : `Q1 missing arms: ${q1Missing.join(", ")}`;

  const q2Rows = results.filter((result) => result.situation_outcome === "refused"
    && (contract.q2.arms as readonly Pr15Arm[]).includes(result.arm));
  const situationCaused = q2Rows.filter((row) => promptModeOf(row) === "untutored" && row.refused && row.correct).length;
  const tutoredOnly = pairedTutoredOnly(q2Rows);
  const q2Eligible = q2Rows.some((row) => promptModeOf(row) === "untutored")
    && q2Rows.some((row) => promptModeOf(row) === "tutored_refuse");
  const attribution = !q2Eligible ? "ineligible"
    : situationCaused > 0 && tutoredOnly > 0 ? "mixed"
    : situationCaused > 0 ? "situation"
    : tutoredOnly > 0 ? "tutoring"
    : "ineligible";

  return {
    q1: {
      eligible: q1Eligible,
      exclusion_reason: q1Reason,
      n: q1Rows.length,
      metrics: {
        safe_action_correctness: pick(q1ByArm, "safe_action_correctness"),
        missed_uncommitted_work_rate: pick(q1ByArm, "missed_uncommitted_work_rate"),
        repeated_dead_work_rate: pick(q1ByArm, "repeated_dead_work_rate"),
      },
      v2_beats_packet_only: q1Eligible ? beats(q1ByArm.v2_situation, q1ByArm.packet_only) : null,
      v2_beats_current_v1: q1Eligible ? beats(q1ByArm.v2_situation, q1ByArm.current_v1) : null,
    },
    q2: {
      eligible: q2Eligible,
      attribution,
      situation_caused_refusals: situationCaused,
      tutored_only_refusals: tutoredOnly,
    },
    wave7_v2_win: false,
  };
}

function pairedTutoredOnly(rows: readonly Pr15ProbeResult[]): number {
  const untutored = new Map<string, Pr15ProbeResult>();
  for (const row of rows) if (promptModeOf(row) === "untutored") untutored.set(pairKey(row), row);
  let count = 0;
  for (const row of rows) {
    if (promptModeOf(row) !== "tutored_refuse" || !row.refused) continue;
    const baseline = untutored.get(pairKey(row));
    if (baseline && !baseline.refused) count += 1;
  }
  return count;
}

function pairKey(result: Pr15ProbeResult): string {
  return `${result.model_profile}\0${result.fixture_id}\0${result.probe_id}\0${result.arm}\0${result.seed}`;
}

function rates(rows: readonly Pr15ProbeResult[]): Wave7ArmRates {
  const n = rows.length;
  return {
    n,
    safe_action_correctness: n === 0 ? 0 : rows.filter((row) => row.safe_action_correct).length / n,
    missed_uncommitted_work_rate: n === 0 ? 0 : rows.filter((row) => row.missed_uncommitted_work).length / n,
    repeated_dead_work_rate: n === 0 ? 0 : rows.filter((row) => row.repeated_dead_work).length / n,
  };
}

function beats(v2: Wave7ArmRates, other: Wave7ArmRates): boolean {
  return v2.safe_action_correctness > other.safe_action_correctness
    && v2.missed_uncommitted_work_rate <= other.missed_uncommitted_work_rate
    && v2.repeated_dead_work_rate <= other.repeated_dead_work_rate;
}

function pick(
  byArm: Record<(typeof Q1_ARMS)[number], Wave7ArmRates>,
  field: "safe_action_correctness" | "missed_uncommitted_work_rate" | "repeated_dead_work_rate",
): Record<(typeof Q1_ARMS)[number], number> {
  return Object.fromEntries(Q1_ARMS.map((arm) => [arm, byArm[arm][field]])) as Record<(typeof Q1_ARMS)[number], number>;
}
