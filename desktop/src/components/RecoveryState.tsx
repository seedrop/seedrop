export function RecoveryState(props: {
  title: string;
  message: string;
  busy: boolean;
  onRetry: () => Promise<void>;
  onHealth: () => void;
}) {
  return (
    <div className="app-body recovery-wrap">
      <section className="recovery-card" role="alert">
        <div className="eyebrow">Needs attention</div>
        <h1>{props.title}</h1>
        <p>{props.message}</p>
        <div className="health-actions">
          <button type="button" className="primary-btn" disabled={props.busy} onClick={() => void props.onRetry()}>
            {props.busy ? "Retrying…" : "Try again"}
          </button>
          <button type="button" className="ghost-btn" onClick={props.onHealth}>
            Open health
          </button>
        </div>
      </section>
    </div>
  );
}
