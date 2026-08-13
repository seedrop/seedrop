import type { ObserverProject } from "../lib/types";
import {
  canonicalDecision,
  canonicalHealth,
  canonicalIntent,
  canonicalSituation,
  collectTasks,
  projectBucket,
  projectStatusLabel,
  projectTitle,
  taskProgress,
} from "../lib/buckets";
import { relativeAge } from "../lib/format";
import { api } from "../lib/api";

export function ProjectDetail(props: {
  project: ObserverProject;
  onClose: () => void;
}) {
  const { project } = props;
  const tasks = collectTasks(project);
  const { total } = taskProgress(project);
  const shared = canonicalSituation(project);
  const health = canonicalHealth(project);
  const decision = canonicalDecision(project);
  const intent = canonicalIntent(project);
  const bucket = projectBucket(project);
  const runs = [
    ...(project.inspectors?.runs?.active ?? []),
    ...(project.inspectors?.runs?.current ? [project.inspectors.runs.current] : []),
    ...(project.inspectors?.runs?.latest ? [project.inspectors.runs.latest] : []),
  ].filter((run, index, all) => all.findIndex((r) => r.id === run.id) === index);

  return (
    <article className="detail-card">
      <div className="detail-header">
        <div>
          <h1>{projectTitle(project)}</h1>
          {(intent ?? project.currentFocus)?.trim() ? <p className="detail-focus">{intent ?? project.currentFocus}</p> : null}
          <div className="meta">{relativeAge(project.lastSeenAt)}</div>
          <div className="meta" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="ghost-btn"
              style={{ padding: "4px 10px", fontSize: "0.85rem" }}
              onClick={() => void api.openPath(project.root)}
            >
              Open folder
            </button>
          </div>
        </div>
        <button type="button" className="close-btn" onClick={props.onClose} aria-label="Close">
          ×
        </button>
      </div>

      {shared && health && decision ? (
        <section className={`canonical-situation health-${health.state}`} aria-label="Canonical Situation">
          <div className="canonical-situation-head">
            <div>
              <span>Canonical Situation</span>
              <strong>{decision.disposition === "refuse" ? "Refused" : "Next action"}: {decision.display}</strong>
            </div>
            <span className="canonical-id" title={shared.decision_id}>{shared.decision_id.slice(0, 15)}</span>
          </div>
          {decision.reason && decision.reason !== decision.display ? <p>{decision.reason}</p> : null}
          <dl>
            <div><dt>Bucket</dt><dd>{shared.bucket}</dd></div>
            <div><dt>Readiness</dt><dd>{shared.readiness}</dd></div>
            <div><dt>Health</dt><dd>{health.state}</dd></div>
            <div><dt>Freshness</dt><dd>{health.freshness}</dd></div>
          </dl>
          {shared.warnings.length > 0 ? <p className="canonical-warnings">{shared.warnings.join(" · ")}</p> : null}
        </section>
      ) : null}

      <div className="task-list">
        {tasks.length === 0 ? (
          <div className="meta">No open tasks in this project.</div>
        ) : (
          tasks.map((task) => {
            const done = task.status === "done" || task.status === "completed";
            return (
              <details key={task.id} className="task-row">
                <summary>
                  <input type="checkbox" checked={done} readOnly tabIndex={-1} aria-hidden />
                  <span>
                    {task.title}
                    {task.blockedByCount > 0 ? <span className="meta"> · blocked</span> : null}
                  </span>
                </summary>
                <p className="task-desc">
                  {task.description?.trim() ? task.description : "No description recorded."}
                </p>
              </details>
            );
          })
        )}
      </div>

      {runs.length > 0 ? (
        <div className="runs-block">
          <h3>Recent runs</h3>
          {runs.map((run) => (
            <div key={run.id} className="run-row">
              <strong>{run.goal}</strong>
              <div className="meta">
                {run.status} · {run.agent}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="detail-footer">
        <span className="progress-label">
          {total === 0 ? "All clear" : `${total} open task${total === 1 ? "" : "s"}`}
        </span>
        <span className={`status-pill status-${bucket}`}>{projectStatusLabel(project)}</span>
      </div>
    </article>
  );
}
