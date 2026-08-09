import { useState } from "react";
import { api } from "../lib/api";
import type { RuntimeStatus } from "../lib/types";

const STEPS = ["Runtime", "Machine setup"] as const;

export function Wizard(props: {
  initial: RuntimeStatus | null;
  onDone: (status: RuntimeStatus) => void;
}) {
  const initialNeedsChoice = Boolean(
    props.initial?.existingInstall.detected
      && props.initial.existingInstall.status !== "desktop_managed",
  );
  const [step, setStep] = useState(props.initial?.ready && !initialNeedsChoice ? 1 : 0);
  const [name, setName] = useState(props.initial?.existingInstall.operatorName ?? "");
  const [purpose, setPurpose] = useState(props.initial?.existingInstall.operatorPurpose ?? "");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(props.initial);
  const [takeOver, setTakeOver] = useState(false);
  const [confirmedTakeover, setConfirmedTakeover] = useState(false);

  const scan = runtime?.existingInstall ?? props.initial?.existingInstall;
  const existingNeedsChoice = Boolean(scan?.detected && scan.status !== "desktop_managed");

  async function ensureRuntime(replaceExisting = false) {
    setTakeOver(replaceExisting);
    setBusy(true);
    setError(null);
    setLog("Installing local Seedrop runtime…");
    try {
      const status = await api.ensureRuntime();
      setRuntime(status);
      setLog(status.message);
      if (status.wizardCompleted) {
        props.onDone(status);
      } else {
        setStep(1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function adoptExisting() {
    setBusy(true);
    setError(null);
    setLog("Installing the Desktop runtime while preserving your existing setup…");
    try {
      const status = await api.adoptExistingInstall();
      setRuntime(status);
      setLog("Existing Seedrop setup preserved and connected to Desktop.");
      props.onDone(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError(null);
    setLog("Creating identity, wiring agents, starting daemon…");
    try {
      const status = await api.completeWizard(name, purpose, existingNeedsChoice && takeOver && confirmedTakeover);
      setRuntime(status);
      setLog("Setup complete. Checking health…");
      try {
        await api.doctorJson();
      } catch {
        // doctor may fail on fresh install; still proceed
      }
      props.onDone(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard-wrap">
      <div className="wizard-card">
        <h1>Seedrop Desktop</h1>
        <p className="meta">
          Install Seedrop on this Mac and get a simple view of your agent projects — no terminal required.
        </p>
        <div className="wizard-steps" aria-label={`Setup step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
          {STEPS.map((label, index) => (
            <span key={label} className={index <= step ? "on" : ""} title={label} />
          ))}
        </div>

        {step === 0 ? (
          <>
            {existingNeedsChoice && scan ? (
              <section className="existing-scan" aria-labelledby="existing-install-title">
                <span className="status-pill status-attention">Existing setup found</span>
                <h2 id="existing-install-title">Seedrop is already on this Mac</h2>
                <p>{scan.summary}. Nothing has been changed.</p>
                <ul className="evidence-list">
                  {scan.evidence.map((item) => (
                    <li key={item.id}>
                      <strong>{item.label}</strong>
                      <span>{item.detail}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p>
                We’ll verify and install the sealed Seedrop runtime shipped with this app, then wire your agent apps.
              </p>
            )}
            {runtime ? (
              <p className="meta">
                Arch {runtime.arch} · {runtime.phase.replace(/_/g, " ")}
              </p>
            ) : null}
            <div className="health-actions">
              {existingNeedsChoice && scan?.canAdopt ? (
                <button type="button" className="primary-btn" disabled={busy} onClick={() => void adoptExisting()}>
                  {busy ? "Working…" : "Use existing setup"}
                </button>
              ) : null}
              <button
                type="button"
                className={existingNeedsChoice && scan?.canAdopt ? "ghost-btn" : "primary-btn"}
                disabled={busy}
                onClick={() => void ensureRuntime(existingNeedsChoice)}
              >
                {busy
                  ? "Working…"
                  : existingNeedsChoice
                    ? "Let Desktop manage this Mac"
                    : runtime?.phase === "repair_required"
                      ? "Repair runtime"
                      : "Install runtime"}
              </button>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            {existingNeedsChoice && takeOver && scan ? (
              <section className="takeover-warning" aria-labelledby="takeover-title">
                <h2 id="takeover-title">Confirm Desktop ownership</h2>
                <p>Completing setup will make these changes:</p>
                <ul>
                  {scan.wouldReplace.length > 0 ? scan.wouldReplace.map((item) => <li key={item}>{item}</li>) : (
                    <li>Desktop will manage the runtime and machine setup; the detected seed command will remain installed.</li>
                  )}
                </ul>
                <label className="confirmation-check">
                  <input
                    type="checkbox"
                    checked={confirmedTakeover}
                    onChange={(event) => setConfirmedTakeover(event.target.checked)}
                  />
                  <span>I understand Desktop will make the changes listed above.</span>
                </label>
              </section>
            ) : null}
            <div className="field">
              <label htmlFor="op-name">Your name</label>
              <input
                id="op-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="mc"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="op-purpose">What are you building?</label>
              <textarea
                id="op-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Operate Seedrop across my projects"
              />
            </div>
            <p className="meta">
              Next we’ll create or resume your operator setup, detect MCP clients (Cursor, Claude, Codex, …),
              install the always-on daemon, and record each completed step in Seedrop’s setup journal.
            </p>
            <div className="health-actions">
              <button
                type="button"
                className="primary-btn"
                disabled={busy || !name.trim() || !purpose.trim() || (existingNeedsChoice && takeOver && !confirmedTakeover)}
                onClick={() => void finish()}
              >
                {busy ? "Setting up…" : "Finish setup"}
              </button>
            </div>
          </>
        ) : null}

        {log ? <p className="meta">{log}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </div>
    </div>
  );
}
