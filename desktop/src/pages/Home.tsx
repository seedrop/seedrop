import { useMemo, useState } from "react";
import type { BucketId, ObserverProject, ObserverState } from "../lib/types";
import { BUCKET_LABELS, filterByBucket, projectBucket } from "../lib/buckets";
import { Sidebar } from "../components/Sidebar";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectDetail } from "./ProjectDetail";

export function Home(props: {
  state: ObserverState;
  onAddProject: () => Promise<void>;
  adding: boolean;
}) {
  const [bucket, setBucket] = useState<BucketId>("ongoing");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const base: Record<BucketId, number> = {
      ongoing: 0,
      needs_attention: 0,
      up_next: 0,
      quiet: 0,
    };
    for (const project of props.state.projects ?? []) {
      base[projectBucket(project)] += 1;
    }
    return base;
  }, [props.state.projects]);

  const visible = filterByBucket(props.state.projects ?? [], bucket);
  const selected = (props.state.projects ?? []).find((p) => p.id === selectedId) ?? null;

  if (selected) {
    return (
      <div className="app-body">
        <Sidebar active={bucket} counts={counts} onSelect={setBucket} />
        <div className="main-pane">
          <ProjectDetail project={selected} onClose={() => setSelectedId(null)} />
        </div>
      </div>
    );
  }

  return (
    <div className="app-body">
      <Sidebar active={bucket} counts={counts} onSelect={setBucket} />
      <div className="main-pane">
        {visible.length === 0 ? (
          <div className="empty-state">
            <div className="empty">
              <strong>Nothing in {BUCKET_LABELS[bucket]}.</strong>
              {bucket === "ongoing" ? " Link a project to begin, or active work will appear here automatically." : null}
            </div>
            <button
              type="button"
              className="add-card compact"
              disabled={props.adding}
              onClick={() => void props.onAddProject()}
            >
              <span className="plus">+</span>
              <span>{props.adding ? "Linking…" : "Add a Project"}</span>
            </button>
          </div>
        ) : (
          <div className="card-grid">
            {visible.map((project: ObserverProject) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => setSelectedId(project.id)}
              />
            ))}
            <button
              type="button"
              className="add-card"
              disabled={props.adding}
              onClick={() => void props.onAddProject()}
            >
              <span className="plus">+</span>
              <span>{props.adding ? "Linking…" : "Add a Project"}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
