import type { BucketId } from "../lib/types";
import { BUCKET_LABELS } from "../lib/buckets";

const ORDER: BucketId[] = ["ongoing", "needs_attention", "up_next", "quiet"];

export function Sidebar(props: {
  active: BucketId;
  counts: Record<BucketId, number>;
  onSelect: (bucket: BucketId) => void;
}) {
  return (
    <nav className="sidebar" aria-label="Project buckets">
      {ORDER.map((id) => (
        <button
          key={id}
          type="button"
          className={`bucket-btn${props.active === id ? " active" : ""}`}
          onClick={() => props.onSelect(id)}
        >
          {BUCKET_LABELS[id]}
          {props.counts[id] > 0 ? ` · ${props.counts[id]}` : ""}
        </button>
      ))}
    </nav>
  );
}
