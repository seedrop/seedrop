import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Home } from "../src/pages/Home";
import { ProjectDetail } from "../src/pages/ProjectDetail";
import { ProjectCard } from "../src/components/ProjectCard";
import { RecoveryState } from "../src/components/RecoveryState";
import { Wizard } from "../src/pages/Wizard";
import { projectBucket, projectStatusLabel, projectTitle } from "../src/lib/buckets";
import { relativeAge } from "../src/lib/format";
import type { ObserverProject, ObserverState, RuntimeStatus } from "../src/lib/types";

function project(overrides: Partial<ObserverProject> = {}): ObserverProject {
  return {
    id: "project-1",
    label: "Seedrop",
    root: "/tmp/seedrop",
    status: "quiet",
    counts: { activeRuns: 0, openTasks: 0, activeSignals: 0, dirtyFiles: 0 },
    attention: { score: 0 },
    inspectors: {
      runs: { active: [] },
      tasks: { openCount: 0, active: [] },
    },
    situation: {
      summary: "Quiet",
      tasks: { open: 0, active: 0, blocked: 0, unowned: 0, assigned: 0 },
    },
    ...overrides,
  };
}

describe("Desktop truth labels", () => {
  it("keeps the project identity as the title instead of replacing it with focus", () => {
    expect(projectTitle(project({ currentFocus: "A long current mission" }))).toBe("Seedrop");
  });

  it("routes broken and blocked projects to Needs attention", () => {
    expect(projectBucket(project({ status: "broken" }))).toBe("needs_attention");
    expect(projectStatusLabel(project({
      status: "attention",
      situation: { summary: "Blocked", tasks: { open: 1, active: 0, blocked: 1, unowned: 1, assigned: 0 } },
    }))).toBe("Needs attention");
  });

  it("uses the canonical bucket even when legacy Desktop heuristics disagree", () => {
    const shared = project({ status: "broken", adapter_situation: adapterSelection() });
    expect(projectBucket(shared)).toBe("up_next");
    expect(projectStatusLabel(shared)).toBe("Up Next");
  });

  it("renders canonical health and refusal without recomputing either", () => {
    const shared = project({ adapter_situation: adapterSelection("refuse") });
    const card = renderToStaticMarkup(<ProjectCard project={shared} onOpen={() => {}} />);
    const detail = renderToStaticMarkup(<ProjectDetail project={shared} onClose={() => {}} />);
    expect(card).toContain("Situation · degraded");
    expect(card).toContain("Up Next");
    expect(detail).toContain("Canonical Situation");
    expect(detail).toContain("Refused");
    expect(detail).toContain("repair_projection");
    expect(detail).toContain("freshness:stale");
  });

  it("describes activity as seen rather than added", () => {
    expect(relativeAge("2026-08-01T08:00:00.000Z", Date.parse("2026-08-01T10:00:00.000Z"))).toBe("Seen 2 hours ago");
  });
});

function adapterSelection(disposition = "recommend"): NonNullable<ObserverProject["adapter_situation"]> {
  return {
    mode: "v2",
    reason: null,
    warning: null,
    served: {
      kind: "v2_situation",
      payload: {
        adapter_version: "1.0.0",
        situation_id: `sha256:${"a".repeat(64)}`,
        decision_id: `sha256:${"b".repeat(64)}`,
        semantic_digest: `sha256:${"c".repeat(64)}`,
        bucket: "up_next",
        readiness: disposition === "refuse" ? "blocked" : "review",
        health: {
          state: "degraded",
          substrate: "healthy",
          freshness: "stale",
          completeness: "complete",
          degraded_source_ids: [],
          quarantine_count: 0,
          unresolved_disagreement_count: 0,
        },
        decision: disposition === "refuse"
          ? { disposition, action: null, reason: "Projection is stale", smallest_repair: "repair_projection", display: "repair_projection" }
          : { disposition: "recommend", action: "run_parity_gate", reason: null, smallest_repair: null, display: "run_parity_gate" },
        orientation: {
          intent: { title: "Canonical Wave 6 intent", state: "active" },
          risk: [],
          delivery: null,
          grave: null,
          source_health: {},
          next_action: disposition === "refuse"
            ? { disposition, smallest_repair: "repair_projection", reason: "Projection is stale" }
            : { disposition, action: "run_parity_gate" },
        },
        trust: {},
        budget: {},
        warnings: ["freshness:stale"],
        mutation_capability: "read_only",
      },
    },
  };
}

describe("first-project empty state", () => {
  it("always renders the Add a Project action when no projects exist", () => {
    const state: ObserverState = { projects: [] };
    const html = renderToStaticMarkup(<Home state={state} adding={false} onAddProject={async () => {}} />);
    expect(html).toContain("Add a Project");
    expect(html).toContain("Link a project to begin");
  });
});

describe("recovery and setup semantics", () => {
  it("renders explicit recovery actions when project reading fails", () => {
    const html = renderToStaticMarkup(
      <RecoveryState
        title="Project reader unavailable"
        message="observer failed"
        busy={false}
        onRetry={async () => {}}
        onHealth={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).toContain("Open health");
  });

  it("describes the wizard as two truthful product stages", () => {
    const html = renderToStaticMarkup(<Wizard initial={null} onDone={() => {}} />);
    expect(html).toContain("Setup step 1 of 2: Runtime");
    expect(html).not.toContain("step 1 of 4");
  });

  it("stops on an existing npm setup and offers preservation before ownership", () => {
    const status: RuntimeStatus = {
      ok: false,
      ready: false,
      phase: "existing_install_detected",
      arch: "aarch64",
      wizardCompleted: false,
      setupPhase: "not_started",
      message: "Existing Seedrop installation found",
      components: [],
      existingInstall: {
        schemaVersion: "1.0",
        status: "existing_ready",
        detected: true,
        canAdopt: true,
        requiresChoice: true,
        summary: "An existing Seedrop installation can be used without replacing it",
        operatorName: "mc",
        operatorPurpose: "Build Seedrop",
        daemonRunning: true,
        daemonOwnership: "external",
        cliCandidates: [{ path: "/Users/mc/.nvm/bin/seed", target: "/npm/seed", kind: "npm" }],
        configuredClients: ["Codex"],
        wouldReplace: ["Space daemon ownership", "Codex MCP configuration"],
        evidence: [
          {
            id: "seed_cli_0",
            label: "Seedrop command",
            path: "/Users/mc/.nvm/bin/seed",
            detail: "npm installation",
            ownership: "external",
          },
        ],
      },
    };
    const html = renderToStaticMarkup(<Wizard initial={status} onDone={() => {}} />);
    expect(html).toContain("Seedrop is already on this Mac");
    expect(html).toContain("Nothing has been changed");
    expect(html).toContain("Use existing setup");
    expect(html).toContain("Let Desktop manage this Mac");
    expect(html).toContain("npm installation");
  });
});
