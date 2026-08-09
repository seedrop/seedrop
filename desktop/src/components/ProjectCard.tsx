import type { ObserverProject } from "../lib/types";
import { projectStatusLabel, projectTitle, taskProgress } from "../lib/buckets";
import { relativeAge } from "../lib/format";

export function ProjectCard(props: {
  project: ObserverProject;
  onOpen: () => void;
}) {
  const { project } = props;
  const { total } = taskProgress(project);
  const label =
    total === 0
      ? project.status === "quiet"
        ? "All clear"
        : "No open tasks"
      : `${total} open task${total === 1 ? "" : "s"}`;

  return (
    <button type="button" className="project-card" onClick={props.onOpen}>
      <h2>{projectTitle(project)}</h2>
      {project.currentFocus?.trim() ? <p className="card-focus">{project.currentFocus}</p> : null}
      <div className="meta">{relativeAge(project.lastSeenAt)}</div>
      <div className="card-footer">
        <span className="progress-label">{label}</span>
        <span className={`status-pill status-${project.status}`}>{projectStatusLabel(project)}</span>
      </div>
    </button>
  );
}
