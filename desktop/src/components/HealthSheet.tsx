import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { DoctorReport, RuntimeStatus } from "../lib/types";

export function HealthSheet(props: {
  runtime: RuntimeStatus | null;
  doctor: DoctorReport | null;
  doctorError: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [fixLog, setFixLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function fix() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.doctorFix();
      setFixLog(`${result.stdout}\n${result.stderr}`.trim());
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || `doctor fix exited ${result.code}`);
      }
      await props.onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const checks = props.doctor?.checks ?? [];

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Health">
      <div className="health-sheet">
        <div className="detail-header">
          <div>
            <h2>Health</h2>
            <p className="meta">Daemon, agent wiring, and local runtime</p>
          </div>
          <button ref={closeRef} type="button" className="close-btn" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>

        <ul className="check-list">
          <li>
            <span className={`dot ${props.runtime?.ready ? "" : "bad"}`} />
            Runtime — {props.runtime?.message ?? "unknown"}
          </li>
          {(props.runtime?.components ?? []).map((component) => (
            <li key={component.id}>
              <span className={`dot ${component.ok ? "" : "bad"}`} />
              {component.id} — {component.message}
            </li>
          ))}
          {checks.length === 0 && !props.doctorError ? (
            <li>
              <span className="dot warn" />
              No doctor report yet
            </li>
          ) : null}
          {checks.map((check, index) => {
            const status = (check.status ?? "").toLowerCase();
            const tone = status === "pass" || status === "ok" ? "" : status === "warn" ? "warn" : "bad";
            return (
              <li key={check.id ?? `${check.summary}-${index}`}>
                <span className={`dot ${tone}`} />
                {check.summary ?? check.name ?? check.id ?? "check"}
              </li>
            );
          })}
        </ul>

        {props.doctorError ? <p className="error">{props.doctorError}</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {fixLog ? (
          <pre className="meta" style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>
            {fixLog}
          </pre>
        ) : null}

        <div className="health-actions">
          <button type="button" className="primary-btn" disabled={busy} onClick={() => void fix()}>
            {busy ? "Fixing…" : "Fix"}
          </button>
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => void props.onRefresh()}>
            Refresh
          </button>
          <button type="button" className="ghost-btn" onClick={props.onClose}>
            Close
          </button>
        </div>

        <details style={{ marginTop: 18 }}>
          <summary className="meta">Advanced</summary>
          <pre className="meta" style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(
              {
                runtime: props.runtime,
                doctor: props.doctor,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
    </div>
  );
}
