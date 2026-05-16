export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
}

export type Channel = "commitments" | "boundary";

export interface RecordedMessage extends Message {
  channel: Channel;
  index: number;
  /** True when the message was promoted from `boundary` to `commitments` by the harvester. */
  recovered?: boolean;
}

export interface SessionSlots {
  name: string;
  current_goal: string;
  hard_constraints: readonly string[];
  priorities: ReadonlyArray<{ name: string; priority: number }>;
  project_conventions: readonly string[];
  boundary_seed: readonly string[];
  blocked_paths: readonly string[];
}
