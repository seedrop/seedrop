function freezeTransitions<const T extends Readonly<Record<string, readonly string[]>>>(transitions: T): T {
  for (const values of Object.values(transitions)) Object.freeze(values);
  return Object.freeze(transitions);
}

export const INTENT_LIFECYCLE = Object.freeze({
  states: Object.freeze(["queued", "active", "paused", "blocked", "reported_complete", "abandoned"] as const),
  initial: "queued",
  terminal: Object.freeze(["reported_complete", "abandoned"] as const),
  transitions: freezeTransitions({
    queued: ["active", "paused", "blocked", "abandoned"],
    active: ["paused", "blocked", "reported_complete", "abandoned"],
    paused: ["active", "blocked", "abandoned"],
    blocked: ["active", "paused", "abandoned"],
    reported_complete: [],
    abandoned: [],
  }),
});

export const EPISODE_LIFECYCLE = Object.freeze({
  states: Object.freeze(["active", "paused", "blocked", "reported_complete", "failed", "abandoned"] as const),
  initial: "active",
  terminal: Object.freeze(["reported_complete", "failed", "abandoned"] as const),
  transitions: freezeTransitions({
    active: ["paused", "blocked", "reported_complete", "failed", "abandoned"],
    paused: ["active", "blocked", "failed", "abandoned"],
    blocked: ["active", "paused", "failed", "abandoned"],
    reported_complete: [],
    failed: [],
    abandoned: [],
  }),
});

export const LEASE_LIFECYCLE = Object.freeze({
  states: Object.freeze(["active", "released", "expired", "revoked"] as const),
  initial: "active",
  terminal: Object.freeze(["released", "expired", "revoked"] as const),
  transitions: freezeTransitions({
    active: ["released", "expired", "revoked"],
    released: [],
    expired: [],
    revoked: [],
  }),
});
