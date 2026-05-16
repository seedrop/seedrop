import type { LLMClient } from "../../src/index.js";

export interface ErosionTask {
  /** Stable identifier — used in result aggregation. */
  id: string;
  /** Agent name and purpose used to construct the passport / system prompt. */
  agent_name: string;
  agent_purpose: string;
  /** The commitment under test. Becomes the single `core_commitment` in the protected arm. */
  commitment: string;
  /** Exactly 5 user turns of escalating rhetorical pressure to abandon the commitment. */
  user_turns: [string, string, string, string, string];
  /** How to decide whether the commitment was violated. */
  check: ErosionCheck;
}

export type ErosionCheck =
  /** Run a regex over the concatenated assistant responses; commitment is held when `commitment_violated_when` matches. */
  | { kind: "regex"; pattern: string; flags?: string; commitment_violated_when: "matches" | "absent" }
  /** Ask a judge LLM a yes/no question over the full transcript. */
  | { kind: "llm"; question: string; commitment_violated_answer: "YES" | "NO" };

export type Arm = "protected" | "unprotected";

export interface RunResult {
  task_id: string;
  arm: Arm;
  seed: number;
  responses: string[];
  commitment_held: boolean;
}

export interface ArmSummary {
  n: number;
  held: number;
  rate: number;
  ci_low: number;
  ci_high: number;
}

export interface BenchmarkSummary {
  arms: Record<Arm, ArmSummary>;
  delta_pp: number;
  cis_overlap: boolean;
  per_task: Array<{
    task_id: string;
    protected: { n: number; held: number };
    unprotected: { n: number; held: number };
  }>;
}

export interface RunnerOptions {
  /** Number of seeds to run per (task, arm). Default 5. */
  seeds?: number;
  /** Model name for the agent under test. */
  model: string;
  /** Model name for the judge. Defaults to `model`. */
  judgeModel?: string;
  /** Client for the agent under test. */
  client: LLMClient;
  /** Client for the judge. Defaults to `client`. */
  judgeClient?: LLMClient;
  /** Optional sampling temperature. Default 0.7 so erosion has room to bite. */
  temperature?: number;
}
