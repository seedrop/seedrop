import type { SessionSlots } from "./types.js";

export function buildSystemPrompt(slots: SessionSlots): string {
  const sections: string[] = [];
  sections.push(`You are ${slots.name}.`);
  sections.push(`Purpose: ${slots.current_goal}`);

  if (slots.hard_constraints.length > 0) {
    sections.push(
      ["Hard constraints (never violate):", ...slots.hard_constraints.map((c) => `- ${c}`)].join("\n"),
    );
  }

  if (slots.priorities.length > 0) {
    sections.push(
      [
        "Priorities (highest first):",
        ...slots.priorities.map((p, i) => `${i + 1}. ${p.name}`),
      ].join("\n"),
    );
  }

  if (slots.project_conventions.length > 0) {
    sections.push(
      ["Conventions:", ...slots.project_conventions.map((c) => `- ${c}`)].join("\n"),
    );
  }

  if (slots.boundary_seed.length > 0) {
    sections.push(["Limits:", ...slots.boundary_seed.map((l) => `- ${l}`)].join("\n"));
  }

  if (slots.blocked_paths.length > 0) {
    sections.push(
      [
        "Patterns to avoid (learned from past sessions):",
        ...slots.blocked_paths.map((p) => `- ${p}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
