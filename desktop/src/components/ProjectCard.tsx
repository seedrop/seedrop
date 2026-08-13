import type { ObserverProject } from "../lib/types";
import { canonicalHealth, canonicalIntent, projectBucket, projectStatusLabel, projectTitle, taskProgress } from "../lib/buckets";
import { relativeAge } from "../lib/format";

export function ProjectCard(props: {
  project: ObserverProject;
  onOpen: () => void;
}) {
  const { project } = props;
  const { total } = taskProgress(project);
  const health = canonicalHealth(project);
  const intent = canonicalIntent(project);
  const bucket = projectBucket(project);
  const label =
    total === 0
      ? project.status === "quiet"
        ? "All clear"
        : "No open tasks"
      : `${total} open task${total === 1 ? "" : "s"}`;

  return (
    <button type="button" className="project-card" onClick={props.onOpen}>
      <h2>{projectTitle(project)}</h2>
      {(intent ?? project.currentFocus)?.trim() ? <p className="card-focus">{intent ?? project.currentFocus}</p> : null}
      {health ? <div className={`canonical-health health-${health.state}`}>Situation · {health.state}</div> : null}
      <div className="meta">{relativeAge(project.lastSeenAt)}</div>
      <div className="card-footer">
        <span className="progress-label">{label}</span>
        <span className={`status-pill status-${bucket}`}>{projectStatusLabel(project)}</span>
      </div>
    </button>
  );
}
