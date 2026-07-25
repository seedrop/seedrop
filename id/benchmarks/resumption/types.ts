import type { LLMClient } from "../../src/index.js";

export type Arm = "cold" | "booted";

/**
 * How to decide whether a probe answer is correct.
 * Mirrors the erosion benchmark's check shapes so authoring habits transfer.
 */
export type ProbeCheck =
  /** Run a regex over the single probe response; answer is correct when `correct_when` holds. */
  | { kind: "regex"; pattern: string; flags?: string; correct_when: "matches" | "absent" }
  /** Ask a judge LLM a yes/no question over the response; answer is correct when the judge says `correct_answer`. */
  | { kind: "llm"; question: string; correct_answer: "YES" | "NO" };

export interface ResumptionProbe {
  /** Stable identifier within the task. */
  id: string;
  /** The question posed to the resuming agent. Include an answer-format directive when regex-checked. */
  question: string;
  check: ProbeCheck;
}

export interface ResumptionTask {
  /** Stable identifier — used in result aggregation. */
  id: string;
  /** One-line label of the intent-loss failure mode under test. */
  scenario: string;
  /** Name of the fictional project the agent is resuming. */
  project_name: string;
  /**
   * Raw scattered repository evidence — given to BOTH arms.
   * Fair-fight contract: everything the boot packet asserts must be derivable
   * from this evidence. The packet may synthesize; it may not know more.
   */
  repo_evidence: string;
  /** The synthesized Situation packet — given to the booted arm only. */
  boot_packet: string;
  probes: ResumptionProbe[];
}

export interface ProbeResult {
  task_id: string;
  probe_id: string;
  arm: Arm;
  seed: number;
  response: string;
  correct: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  /** "api" when the provider returned usage; "estimated" when derived from character counts. */
  token_source: "api" | "estimated";
}

export interface ArmSummary {
  n: number;
  correct: number;
  rate: number;
  ci_low: number;
  ci_high: number;
  mean_prompt_tokens: number;
  mean_completion_tokens: number;
}

export interface BenchmarkSummary {
  arms: Record<Arm, ArmSummary>;
  /** booted rate minus cold rate, in percentage points. */
  delta_pp: number;
  cis_overlap: boolean;
  /** Mean booted prompt tokens minus mean cold prompt tokens — the packet's price per probe. */
  marginal_prompt_tokens: number;
  per_task: Array<{
    task_id: string;
    scenario: string;
    cold: { n: number; correct: number };
    booted: { n: number; correct: number };
  }>;
}

export interface RunnerOptions {
  /** Number of seeds to run per (task, probe, arm). Default 5. */
  seeds?: number;
  /** Model name for the agent under test. */
  model: string;
  /** Model name for the judge. Defaults to `model`. */
  judgeModel?: string;
  /** Client for the agent under test. */
  client: LLMClient;
  /** Client for the judge. Defaults to `client`. */
  judgeClient?: LLMClient;
  /** Sampling temperature. Default 0.3 — resumption probes measure decision accuracy, not erosion. */
  temperature?: number;
}
