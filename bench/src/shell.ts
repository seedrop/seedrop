import type {
  BenchDegradedFact,
  BenchEvidenceSource,
  BenchProjectBlocker,
  BenchProjectContributor,
  BenchInboxItem,
  BenchProject,
  BenchProjectStatus,
  BenchRunSummary,
  BenchResumptionState,
  BenchSituationMetric,
  BenchSignalSummary,
  BenchState,
  BenchTaskSummary,
  BenchValidationSummary,
} from "./state.js";

export interface BenchShellOptions {
  selectedProjectId?: string;
  title?: string;
}

const GROUP_LABELS: Record<BenchProjectStatus, string> = {
  broken: "Missing",
  attention: "Review",
  active: "Active",
  quiet: "Clear",
};

const STATUS_LABELS: Record<BenchProjectStatus, string> = {
  broken: "Unavailable",
  attention: "Review",
  active: "Active",
  quiet: "Clear",
};

export function renderBenchShell(state: BenchState, options: BenchShellOptions = {}): string {
  const title = options.title ?? "Seedrop Bench";
  const selected = selectProject(state, options.selectedProjectId);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${SHELL_CSS}</style>
</head>
<body>
  <div class="bench-shell" data-bench-shell>
    <aside class="rail" aria-label="Projects">
      <header class="rail-header">
        <div>
          <div class="eyebrow">Machine</div>
          <h1>Projects</h1>
        </div>
        <div class="passport-chip" title="Linked projects">${state.summary.total}</div>
      </header>
      <label class="filter">
        <span>Search</span>
        <input type="search" placeholder="Project, path, agent" data-project-filter>
      </label>
      <nav class="project-groups" aria-label="Project groups">
        ${renderProjectGroups(state.projects, selected?.id)}
      </nav>
    </aside>
    <main class="situation" aria-label="Selected project">
      ${selected ? renderSituation(selected) : renderEmptySituation(state)}
    </main>
    <aside class="inspector" aria-label="Sources">
      ${renderInspector(state, selected)}
    </aside>
    <footer class="statusbar" aria-label="Bench status">
      ${renderStatusBar(state)}
    </footer>
  </div>
  <script>${SHELL_SCRIPT}</script>
</body>
</html>`;
}

function selectProject(state: BenchState, selectedProjectId?: string): BenchProject | undefined {
  return state.projects.find((project) => project.id === selectedProjectId)
    ?? state.projects.find((project) => project.id === state.selection?.preferred_project_id)
    ?? state.projects[0];
}

function renderProjectGroups(projects: BenchProject[], selectedId: string | undefined): string {
  return (["broken", "attention", "active", "quiet"] as BenchProjectStatus[])
    .map((status) => {
      const groupProjects = projects.filter((project) => project.status === status);
      return `<section class="project-group" data-status="${status}">
        <h2>${GROUP_LABELS[status]} <span>${groupProjects.length}</span></h2>
        <div class="project-list">
          ${groupProjects.length > 0
            ? groupProjects.map((project) => renderProjectRow(project, project.id === selectedId)).join("")
            : `<div class="empty-row">No projects</div>`}
        </div>
      </section>`;
    })
    .join("");
}

function renderProjectRow(project: BenchProject, selected: boolean): string {
  const href = `?project=${encodeURIComponent(project.id)}`;
  const reason = project.reasons[0] ?? STATUS_LABELS[project.status];
  const primary = project.attention.primary?.label ?? reason;
  const badges = [project.agents.length > 1 ? `${project.agents.length} agents` : (project.agents[0]?.agent_id ?? "")].filter(Boolean);
  return `<a class="project-row ${selected ? "is-selected" : ""}" href="${href}" data-project-row data-project-id="${escapeAttr(project.id)}" aria-current="${selected ? "page" : "false"}">
    <span class="status-dot status-${project.status}" aria-hidden="true"></span>
    <span class="project-copy">
      <span class="project-name">${escapeHtml(project.label)}</span>
      <span class="project-reason">${escapeHtml(primary)}</span>
    </span>
    <span class="project-badges">${badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("")}</span>
  </a>`;
}

function renderSituation(project: BenchProject): string {
  return `<section class="situation-head">
    <div>
      <div class="eyebrow">${STATUS_LABELS[project.status]}</div>
      <h2>${escapeHtml(project.label)}</h2>
      <p class="path">${escapeHtml(project.root)}</p>
    </div>
    <div class="state-pill state-${project.situation.resumption.readiness}">${escapeHtml(project.situation.resumption.label)}</div>
  </section>
  ${renderResumptionScorecard(project.situation.resumption)}
  <section class="repo-strip" aria-label="Repo state">
    ${project.situation.repo.map(renderRepoMetric).join("")}
  </section>
  <section class="agents-panel" aria-label="Agents">
    <div class="section-head">
      <h3>Agents</h3>
      <span>${project.situation.agents.length}</span>
    </div>
    <div class="agent-list">
      ${project.situation.agents.length > 0
        ? project.situation.agents.map(renderAgent).join("")
        : `<p class="muted">No agents recorded.</p>`}
    </div>
  </section>
  <section class="work-panel" aria-label="Project work">
    <div class="work-card">
      <h3>Next</h3>
      ${renderNext(project)}
    </div>
    <div class="work-card">
      <h3>Blocked By</h3>
      ${renderBlockers(project.situation.blockers)}
    </div>
    <div class="work-card">
      <h3>Tasks</h3>
      ${renderTaskState(project)}
    </div>
  </section>
  <section class="focus-band">
    <h3>Focus</h3>
    <p>${escapeHtml(project.currentFocus ?? "No focus set.")}</p>
  </section>
  ${renderPrimitiveInspectors(project)}`;
}

function renderResumptionScorecard(resumption: BenchResumptionState): string {
  return `<section class="resumption-card resumption-${resumption.readiness}" aria-label="Resumption">
    <div class="resumption-main">
      <div class="readiness-badge">${escapeHtml(resumption.label)}</div>
      <div>
        <h3>Resumption</h3>
        <p>${escapeHtml(resumption.summary)}</p>
      </div>
    </div>
    ${resumption.recommendedRepair ? renderRecommendedRepair(resumption) : ""}
    ${renderDegradedFacts(resumption.degraded)}
  </section>`;
}

function renderRecommendedRepair(resumption: BenchResumptionState): string {
  const repair = resumption.recommendedRepair;
  if (!repair) return "";
  return `<div class="repair-line">
    <span>Next repair</span>
    <strong>${escapeHtml(repair.label)}</strong>
    <small>${escapeHtml(repair.reason)}</small>
    ${repair.command ? `<code>${escapeHtml(repair.command)}</code>` : ""}
  </div>`;
}

function renderDegradedFacts(facts: BenchDegradedFact[]): string {
  if (facts.length === 0) {
    return `<div class="fact-empty">No degraded evidence.</div>`;
  }
  const groups = groupDegradedFacts(facts);
  return `<div class="fact-groups" aria-label="Evidence">
    ${groups.map(([source, sourceFacts]) => `<details class="fact-group">
      <summary>
        <span>${escapeHtml(sourceLabel(source))}</span>
        <strong>${sourceFacts.length}</strong>
      </summary>
      <div class="fact-list">
        ${sourceFacts.map(renderDegradedFact).join("")}
      </div>
    </details>`).join("")}
  </div>`;
}

function renderDegradedFact(fact: BenchDegradedFact): string {
  const detail = [fact.detail, fact.evidencePath].filter(Boolean).join(" · ");
  return `<div class="fact-row fact-${fact.severity}">
    <span>${escapeHtml(fact.label)}</span>
    <small>${escapeHtml(fact.scope)} · ${escapeHtml(fact.severity)}${detail ? ` · ${escapeHtml(detail)}` : ""}</small>
  </div>`;
}

function groupDegradedFacts(facts: BenchDegradedFact[]): Array<[BenchEvidenceSource, BenchDegradedFact[]]> {
  const order: BenchEvidenceSource[] = ["view", "git", "passport", "validation", "space", "bench"];
  return order.flatMap((source) => {
    const matching = facts.filter((fact) => fact.source === source);
    return matching.length > 0 ? [[source, matching] as [BenchEvidenceSource, BenchDegradedFact[]]] : [];
  });
}

function sourceLabel(source: BenchEvidenceSource): string {
  if (source === "view") return "View";
  if (source === "git") return "Git";
  if (source === "passport") return "Passport";
  if (source === "validation") return "Validation";
  if (source === "space") return "Space";
  return "Bench";
}

function renderRepoMetric(metric: BenchSituationMetric): string {
  return `<div class="repo-metric metric-${metric.tone ?? "neutral"}">
    <span>${escapeHtml(metric.label)}</span>
    <strong>${escapeHtml(metric.value)}</strong>
  </div>`;
}

function renderAgent(agent: BenchProjectContributor): string {
  const facts = [
    agent.linked ? "linked" : "",
    agent.viewRuns > 0 ? `${agent.viewRuns} run${agent.viewRuns === 1 ? "" : "s"}` : "",
    agent.openTasks > 0 ? `${agent.openTasks} task${agent.openTasks === 1 ? "" : "s"}` : "",
    agent.claims > 0 ? `${agent.claims} claim${agent.claims === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `<div class="agent-row agent-${agent.status}">
    <span class="agent-dot" aria-hidden="true"></span>
    <div>
      <strong>${escapeHtml(agent.agent_id)}</strong>
      <small>${escapeHtml(agentLabel(agent))}</small>
    </div>
    <span>${escapeHtml(facts.join(" · ") || "seen")}</span>
  </div>`;
}

function agentLabel(agent: BenchProjectContributor): string {
  if (agent.status === "active") return "Active";
  if (agent.linked) return "Linked";
  if (agent.legacy) return "Legacy identity";
  return "Seen in View";
}

function renderNext(project: BenchProject): string {
  const nextTask = project.situation.tasks.next;
  if (nextTask) {
    return `<div class="next-item">
      <strong>${escapeHtml(shortId(nextTask.id))}</strong>
      <span>${escapeHtml(nextTask.title)}</span>
      <small>${escapeHtml(nextTask.status)}${nextTask.owner ? ` by ${escapeHtml(nextTask.owner)}` : ""}</small>
    </div>`;
  }
  const next = project.situation.next;
  if (next) {
    return `<div class="next-item">
      <span>${escapeHtml(next.reason)}</span>
      <code>${escapeHtml(next.command ?? next.path ?? next.kind)}</code>
    </div>`;
  }
  return `<p class="muted">No next task.</p>`;
}

function renderBlockers(blockers: BenchProjectBlocker[]): string {
  if (blockers.length === 0) return `<p class="muted">No blockers.</p>`;
  return `<div class="blocker-list">
    ${blockers.map((blocker) => `<div class="blocker blocker-${blocker.severity}">
      <strong>${escapeHtml(blocker.label)}</strong>
      ${blocker.detail ? `<small>${escapeHtml(blocker.detail)}</small>` : ""}
    </div>`).join("")}
  </div>`;
}

function renderTaskState(project: BenchProject): string {
  const tasks = project.situation.tasks;
  return `<div class="task-state">
    <span><strong>${tasks.open}</strong> open</span>
    <span><strong>${tasks.active}</strong> active</span>
    <span><strong>${tasks.blocked}</strong> blocked</span>
    <span><strong>${tasks.unowned}</strong> unowned</span>
  </div>`;
}

function renderEmptySituation(state: BenchState): string {
  return `<section class="empty-situation">
    <div class="eyebrow">No Projects</div>
    <h2>No projects linked</h2>
    <p>No Seedrop projects were found in the local passport inventory.</p>
  </section>`;
}

function renderInspector(state: BenchState, selected: BenchProject | undefined): string {
  return `<header class="inspector-header">
    <h2>Sources</h2>
    <span class="status-dot ${state.daemon.reachable ? "status-quiet" : "status-broken"}" aria-hidden="true"></span>
  </header>
  <dl class="kv">
    ${kv("Identity", state.passport.agent_id)}
    ${kv("Projects", String(state.summary.total))}
    ${kv("Passports", String(state.inventory.passports))}
    ${kv("Links", String(state.inventory.linked_projects))}
    ${kv("Space", state.daemon.reachable ? "online" : "offline")}
    ${kv("URL", state.daemon.url ?? "skipped")}
    ${kv("Registered", String(state.daemon.registeredPassports))}
    ${selected ? kv("Selected", selected.id) : ""}
    ${selected ? kv("View", selected.view.present ? "present" : "missing") : ""}
    ${selected ? kv("Agents", selected.agents.map((agent) => agent.agent_id).join(", ")) : ""}
    ${selected?.view.successLevel ? kv("Success", `${selected.view.successLevel}${selected.view.successRequired ? ` / ${selected.view.successRequired}` : ""}`) : ""}
  </dl>
  ${renderInbox(state)}
  <section class="sources">
    <h3>Sources</h3>
    <p>${escapeHtml(state.passport.path)}</p>
    ${selected ? `<p>${escapeHtml(selected.root)}/.seedrop/view</p>` : ""}
    ${state.daemon.url ? `<p>${escapeHtml(state.daemon.url)}</p>` : ""}
  </section>`;
}

function renderPrimitiveInspectors(project: BenchProject): string {
  const inspectors = project.inspectors;
  return `<section class="primitive-panel" aria-label="Activity">
    <div class="primitive-head">
      <h3>Activity</h3>
      <span>View</span>
    </div>
    <div class="primitive-grid">
      <section class="primitive-block">
        <h4>Runs</h4>
        ${inspectors.runs.current
          ? renderRun(inspectors.runs.current, "Current")
          : inspectors.runs.latest
            ? renderRun(inspectors.runs.latest, "Latest")
            : `<p class="muted">No runs.</p>`}
        ${inspectors.runs.active.length > 1 ? `<p class="muted">${inspectors.runs.active.length} active runs.</p>` : ""}
      </section>
      <section class="primitive-block">
        <h4>Tasks</h4>
        <p class="muted">${inspectors.tasks.openCount} open task${inspectors.tasks.openCount === 1 ? "" : "s"}.</p>
        ${inspectors.tasks.active.length > 0
          ? `<div class="primitive-list">${inspectors.tasks.active.map(renderTask).join("")}</div>`
          : `<p class="muted">No active tasks.</p>`}
      </section>
      <section class="primitive-block">
        <h4>Signals</h4>
        ${inspectors.signals.length > 0
          ? `<div class="primitive-list">${inspectors.signals.map(renderSignal).join("")}</div>`
          : `<p class="muted">No claims.</p>`}
      </section>
      <section class="primitive-block">
        <h4>Checks</h4>
        ${inspectors.validation.latest ? renderValidation(inspectors.validation.latest) : `<p class="muted">No validation.</p>`}
        ${inspectors.nextActions.length > 0
          ? `<div class="command-stack">${inspectors.nextActions.map(renderSuggestedCommand).join("")}</div>`
          : `<p class="muted">No commands.</p>`}
      </section>
    </div>
  </section>`;
}

function renderRun(run: BenchRunSummary, label: string): string {
  const latest = run.latestValidation;
  return `<div class="primitive-item">
    <strong>${escapeHtml(label)} ${escapeHtml(shortId(run.id))}</strong>
    <span>${escapeHtml(run.goal)}</span>
    <small>${escapeHtml(run.status)} by ${escapeHtml(run.agent)} · ${escapeHtml(formatDateTime(run.startedAt))}</small>
    ${run.changedPaths.length > 0 ? `<small>${run.changedPaths.length} changed path${run.changedPaths.length === 1 ? "" : "s"}</small>` : ""}
    ${latest ? renderValidation(latest) : ""}
  </div>`;
}

function renderTask(task: BenchTaskSummary): string {
  const blockers = task.blockedByCount > 0 ? ` · ${task.blockedByCount} blocker${task.blockedByCount === 1 ? "" : "s"}` : "";
  return `<div class="primitive-item">
    <strong>${escapeHtml(shortId(task.id))}</strong>
    <span>${escapeHtml(task.title)}</span>
    <small>${escapeHtml(task.status)}${task.owner ? ` by ${escapeHtml(task.owner)}` : ""}${blockers}</small>
  </div>`;
}

function renderSignal(signal: BenchSignalSummary): string {
  return `<div class="primitive-item">
    <strong>${escapeHtml(signal.type)} ${escapeHtml(shortId(signal.id))}</strong>
    <span>${escapeHtml(signal.target)}</span>
    <small>${escapeHtml(signal.owner)} · ${escapeHtml(signal.intent)} · expires ${escapeHtml(formatDateTime(signal.expiresAt))}</small>
  </div>`;
}

function renderValidation(validation: BenchValidationSummary): string {
  return `<div class="validation validation-${validation.status}">
    <strong>${escapeHtml(validation.status)}</strong>
    <code>${escapeHtml(validation.command)}</code>
    <small>${escapeHtml(formatDateTime(validation.recordedAt))}${validation.notes ? ` · ${escapeHtml(validation.notes)}` : ""}</small>
  </div>`;
}

function renderSuggestedCommand(action: { command?: string; path?: string; kind: string; reason: string; risk: string; requiresHuman: boolean }): string {
  const command = action.command ?? action.path ?? action.kind;
  return `<div class="suggested-command">
    <code>${escapeHtml(command)}</code>
    <small>${escapeHtml(action.reason)} · ${escapeHtml(action.risk)}${action.requiresHuman ? " · human" : ""}</small>
  </div>`;
}

function renderInbox(state: BenchState): string {
  return `<section class="inbox-panel">
    <div class="primitive-head">
      <h3>Inbox</h3>
      <span>${state.inbox.reachable ? `${state.inbox.unread} unacked` : "unavailable"}</span>
    </div>
    ${state.inbox.items.length > 0
      ? `<div class="primitive-list">${state.inbox.items.map(renderInboxItem).join("")}</div>`
      : `<p>${escapeHtml(state.inbox.error ?? "No unacked mentions.")}</p>`}
  </section>`;
}

function renderInboxItem(item: BenchInboxItem): string {
  return `<div class="primitive-item">
    <strong>${escapeHtml(shortId(item.id))}</strong>
    <span>${escapeHtml(item.content)}</span>
    <small>${item.space ? `${escapeHtml(item.space)} · ` : ""}${escapeHtml(item.sender)} · ${escapeHtml(formatDateTime(item.createdAt))}</small>
  </div>`;
}

function renderStatusBar(state: BenchState): string {
  return [
    state.passport.agent_id,
    state.daemon.reachable ? "space online" : "space offline",
    `${state.summary.total} projects`,
    `${state.inventory.passports} passports`,
    `${state.summary.attention} review`,
    `refreshed ${formatTime(state.generated_at)}`,
  ].map((item) => `<span>${escapeHtml(item)}</span>`).join("");
}

function metric(label: string, value: number, suffix: string): string {
  return `<div class="metric">
    <span>${escapeHtml(label)}</span>
    <strong>${value}</strong>
    <small>${escapeHtml(suffix)}</small>
  </div>`;
}

function kv(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toISOString().slice(11, 16);
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toISOString().slice(5, 16).replace("T", " ");
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

const SHELL_CSS = `
:root {
  color-scheme: dark;
  --bg: #111111;
  --panel: #191919;
  --panel-soft: #202020;
  --line: #303030;
  --line-soft: #272727;
  --text: #e7e7e7;
  --muted: #969696;
  --faint: #6d6d6d;
  --green: #63d47c;
  --amber: #e0a84d;
  --red: #eb6a5f;
  --blue: #70a7ff;
  --focus: #d7d7d7;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  letter-spacing: 0;
}
.bench-shell {
  display: grid;
  grid-template-columns: 292px minmax(480px, 1fr) 330px;
  grid-template-rows: minmax(0, 1fr) 34px;
  min-height: 100vh;
}
.rail, .situation, .inspector { min-height: 0; overflow: auto; }
.rail {
  grid-row: 1 / 3;
  background: var(--panel);
  border-right: 1px solid var(--line);
  padding: 14px 10px 46px;
}
.rail-header, .situation-head, .inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rail-header { padding: 4px 6px 18px; }
.eyebrow {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  font-weight: 650;
}
h1, h2, h3, p { margin: 0; }
h1 { font-size: 18px; font-weight: 650; }
h2 { font-size: 20px; font-weight: 650; }
h3 {
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
  text-transform: uppercase;
}
.passport-chip, .state-pill {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 8px;
  color: var(--muted);
  background: var(--panel-soft);
  font-size: 12px;
}
.filter {
  display: grid;
  gap: 6px;
  padding: 0 6px 14px;
  color: var(--muted);
  font-size: 12px;
}
.filter input {
  width: 100%;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #141414;
  color: var(--text);
  padding: 0 10px;
  outline: none;
}
.filter input:focus, .project-row:focus-visible {
  border-color: var(--focus);
  box-shadow: 0 0 0 2px rgba(255,255,255,.08);
}
.project-group { margin: 0 0 16px; }
.project-group h2 {
  display: flex;
  justify-content: space-between;
  color: var(--muted);
  padding: 0 6px 7px;
  font-size: 12px;
  text-transform: uppercase;
}
.project-list { display: grid; gap: 2px; }
.project-row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 42px;
  padding: 7px 8px;
  color: var(--text);
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: 7px;
}
.project-row:hover, .project-row.is-selected {
  background: var(--panel-soft);
  border-color: var(--line-soft);
}
.project-copy { min-width: 0; display: grid; gap: 2px; }
.project-name, .project-reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-reason, .empty-row, .path, .sources p, .next-move p, .focus-band p, .evidence li, .muted, .inbox-panel p {
  color: var(--muted);
}
.project-badges { display: flex; gap: 4px; }
.project-badges span {
  color: var(--faint);
  font-size: 11px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.status-broken { background: var(--red); }
.status-attention { background: var(--amber); }
.status-active { background: var(--blue); }
.status-quiet { background: var(--green); }
.situation {
  padding: 28px 34px 64px;
}
.situation-head {
  border-bottom: 1px solid var(--line);
  padding-bottom: 22px;
  margin-bottom: 22px;
}
.path {
  margin-top: 6px;
  font-size: 13px;
}
.state-broken { color: var(--red); }
.state-attention { color: var(--amber); }
.state-active { color: var(--blue); }
.state-quiet { color: var(--green); }
.state-blocked { color: var(--red); }
.state-review { color: var(--amber); }
.state-ready { color: var(--green); }
.state-unknown { color: var(--muted); }
.resumption-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border-bottom: 1px solid var(--line-soft);
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
}
.resumption-main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: center;
}
.readiness-badge {
  min-width: 78px;
  text-align: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 8px 10px;
  font-weight: 700;
}
.resumption-active .readiness-badge { color: var(--blue); border-color: rgba(112,167,255,.42); }
.resumption-ready .readiness-badge { color: var(--green); border-color: rgba(99,212,124,.42); }
.resumption-review .readiness-badge { color: var(--amber); border-color: rgba(224,168,77,.42); }
.resumption-blocked .readiness-badge { color: var(--red); border-color: rgba(235,106,95,.42); }
.resumption-unknown .readiness-badge { color: var(--muted); }
.resumption-main h3 {
  margin-bottom: 4px;
}
.resumption-main p {
  color: var(--text);
  font-size: 15px;
  overflow-wrap: anywhere;
}
.repair-line {
  display: grid;
  grid-template-columns: 84px minmax(120px, auto) minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
  border-top: 1px solid var(--line-soft);
  padding-top: 12px;
}
.repair-line span, .repair-line small {
  color: var(--muted);
}
.repair-line strong, .repair-line small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repair-line code {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  background: #141414;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 7px;
}
.fact-empty {
  color: var(--muted);
  border-top: 1px solid var(--line-soft);
  padding-top: 12px;
}
.fact-groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  border-top: 1px solid var(--line-soft);
  padding-top: 12px;
}
.fact-group {
  min-width: 0;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  background: #171717;
}
.fact-group summary {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  cursor: default;
  list-style: none;
  padding: 8px 10px;
}
.fact-group summary::-webkit-details-marker { display: none; }
.fact-group summary span {
  color: var(--muted);
}
.fact-group summary strong {
  color: var(--text);
  font-size: 12px;
}
.fact-list {
  display: grid;
  gap: 1px;
  border-top: 1px solid var(--line-soft);
}
.fact-row {
  min-width: 0;
  display: grid;
  gap: 3px;
  padding: 8px 10px;
}
.fact-row span, .fact-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fact-row small {
  color: var(--muted);
  font-size: 12px;
}
.fact-critical span, .fact-high span { color: var(--red); }
.fact-medium span { color: var(--amber); }
.fact-low span { color: var(--muted); }
.resumption-card + .repo-strip {
  margin-top: 18px;
}
.repo-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line-soft);
}
.repo-metric {
  min-width: 0;
  display: grid;
  gap: 5px;
  background: var(--panel);
  border: 1px solid var(--line);
  padding: 10px 12px;
}
.repo-metric:first-child { border-radius: 7px 0 0 7px; }
.repo-metric:last-child { border-radius: 0 7px 7px 0; }
.repo-metric span {
  color: var(--muted);
  font-size: 12px;
}
.repo-metric strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}
.metric-good strong { color: var(--green); }
.metric-warn strong { color: var(--amber); }
.metric-bad strong { color: var(--red); }
.metric-neutral strong { color: var(--text); }
.agents-panel, .work-panel, .focus-band, .evidence, .primitive-panel {
  display: grid;
  gap: 10px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line-soft);
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.section-head span {
  color: var(--muted);
  font-size: 12px;
}
.agent-list {
  display: grid;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 7px;
  overflow: hidden;
}
.agent-row {
  display: grid;
  grid-template-columns: 8px minmax(120px, 1fr) minmax(120px, auto);
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 11px;
  background: var(--panel);
  border-bottom: 1px solid var(--line-soft);
}
.agent-row:last-child { border-bottom: 0; }
.agent-row div {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.agent-row strong, .agent-row small, .agent-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-row small, .agent-row > span {
  color: var(--muted);
  font-size: 12px;
}
.agent-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.agent-active .agent-dot { background: var(--blue); }
.agent-linked .agent-dot { background: var(--green); }
.agent-seen .agent-dot { background: var(--amber); }
.agent-legacy .agent-dot { background: var(--faint); }
.work-panel {
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, .8fr);
  align-items: stretch;
}
.work-card {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
}
.next-item, .blocker-list, .blocker, .task-state {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.next-item span, .next-item small, .blocker small {
  color: var(--muted);
  overflow-wrap: anywhere;
}
.next-item code {
  display: block;
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--text);
  background: #141414;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
}
.blocker {
  border-left: 2px solid var(--amber);
  padding-left: 8px;
}
.blocker-critical, .blocker-high { border-left-color: var(--red); }
.task-state {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.task-state span {
  color: var(--muted);
}
.task-state strong {
  color: var(--text);
  font-size: 18px;
}
.next-move code, .validation code, .suggested-command code {
  display: block;
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
}
.work-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line-soft);
}
.metric {
  display: grid;
  gap: 4px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 10px;
}
.metric span, .metric small { color: var(--muted); }
.metric strong { font-size: 22px; line-height: 1; }
.evidence ul {
  margin: 0;
  padding-left: 18px;
}
.primitive-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.primitive-head span {
  color: var(--muted);
  font-size: 12px;
}
.primitive-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.primitive-block {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
  padding: 12px;
}
.primitive-block h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
.primitive-list, .command-stack {
  display: grid;
  gap: 8px;
}
.primitive-item, .validation, .suggested-command {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.primitive-item span, .primitive-item small, .validation small, .suggested-command small {
  color: var(--muted);
  overflow-wrap: anywhere;
}
.primitive-item strong, .validation strong {
  font-size: 12px;
}
.validation-passed strong { color: var(--green); }
.validation-failed strong { color: var(--red); }
.validation-skipped strong { color: var(--amber); }
.inspector {
  background: var(--panel);
  border-left: 1px solid var(--line);
  padding: 22px 18px 58px;
}
.inspector-header {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}
.kv {
  display: grid;
  gap: 10px;
  margin: 16px 0;
}
.kv div {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 10px;
}
.kv dt { color: var(--muted); }
.kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.sources {
  display: grid;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
.inbox-panel {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--line);
  padding: 16px 0;
}
.sources p { overflow-wrap: anywhere; font-size: 12px; }
.empty-situation {
  display: grid;
  gap: 8px;
  max-width: 520px;
}
.statusbar {
  grid-column: 2 / 4;
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  padding: 0 14px;
  border-top: 1px solid var(--line);
  background: #151515;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
}
.statusbar span {
  white-space: nowrap;
}
@media (max-width: 980px) {
  .bench-shell {
    grid-template-columns: 240px minmax(0, 1fr);
  }
  .inspector {
    display: none;
  }
  .statusbar {
    grid-column: 2;
  }
}
@media (max-width: 720px) {
  .bench-shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto 34px;
  }
  .rail {
    grid-row: auto;
    max-height: 42vh;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .situation {
    padding: 20px 18px 54px;
  }
  .work-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .repo-strip, .work-panel {
    grid-template-columns: 1fr;
  }
  .resumption-main, .repair-line, .fact-groups {
    grid-template-columns: 1fr;
  }
  .readiness-badge {
    width: fit-content;
  }
  .repair-line strong, .repair-line small, .repair-line code {
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .primitive-grid {
    grid-template-columns: 1fr;
  }
  .statusbar {
    grid-column: 1;
  }
}
`;

const SHELL_SCRIPT = `
const filter = document.querySelector("[data-project-filter]");
const rows = [...document.querySelectorAll("[data-project-row]")];
filter?.addEventListener("input", () => {
  const query = filter.value.trim().toLowerCase();
  for (const row of rows) {
    row.hidden = query.length > 0 && !row.textContent.toLowerCase().includes(query);
  }
});
document.addEventListener("keydown", (event) => {
  const active = document.activeElement;
  if (!active?.matches?.("[data-project-row]")) return;
  const visible = rows.filter((row) => !row.hidden);
  const index = visible.indexOf(active);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    visible[Math.min(index + 1, visible.length - 1)]?.focus();
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    visible[Math.max(index - 1, 0)]?.focus();
  }
});
`;
