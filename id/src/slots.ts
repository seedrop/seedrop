import type { Passport } from "./schema.js";
import type { SessionSlots } from "./types.js";

export function seedSlots(passport: Passport): SessionSlots {
  const priorities = [...passport.value_anchors].sort((a, b) => a.priority - b.priority);
  return {
    name: passport.name,
    current_goal: passport.purpose,
    hard_constraints: passport.core_commitments,
    priorities,
    project_conventions: passport.competencies,
    boundary_seed: passport.limits,
    blocked_paths: passport.learned_blocks.map((b) => b.pattern),
  };
}
