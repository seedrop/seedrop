import { useCallback, useEffect, useState } from "react";
import { api, isTauri } from "./lib/api";
import type { DoctorReport, ObserverState, RuntimeStatus } from "./lib/types";
import { Wizard } from "./pages/Wizard";
import { Home } from "./pages/Home";
import { HealthStrip } from "./components/HealthStrip";
import { HealthSheet } from "./components/HealthSheet";
import { RecoveryState } from "./components/RecoveryState";
import "./styles.css";

export default function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [state, setState] = useState<ObserverState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  const refreshHealth = useCallback(async () => {
    try {
      const status = await api.getSetupState();
      setRuntime(status);
      setRuntimeError(null);
    } catch (err) {
      setRuntimeError(err instanceof Error ? err.message : String(err));
    }
    try {
      const report = await api.doctorJson();
      setDoctor(report);
      setDoctorError(null);
    } catch (err) {
      setDoctorError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshObserve = useCallback(async () => {
    setStateError(null);
    try {
      const next = await api.observeState();
      setState(next);
    } catch (err) {
      setState(null);
      setStateError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri) {
        setError("Open with `npm run tauri:dev` inside desktop/ — browser-only Vite cannot talk to Seedrop.");
        setBootstrapping(false);
        return;
      }
      try {
        const status = await api.getSetupState();
        if (cancelled) return;
        setRuntime(status);
        if (status.ready && status.wizardCompleted) {
          await Promise.allSettled([refreshObserve(), refreshHealth()]);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshHealth, refreshObserve]);

  async function onWizardDone(status: RuntimeStatus) {
    setRuntime(status);
    setBootstrapping(true);
    try {
      await refreshObserve();
      await refreshHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBootstrapping(false);
    }
  }

  async function addProject() {
    setAdding(true);
    setError(null);
    try {
      const folder = await api.pickFolder();
      if (!folder) return;
      const result = await api.bootstrapProject(folder);
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "bootstrap failed");
      }
      await refreshObserve();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  if (bootstrapping) {
    return <div className="loading">Starting Seedrop Desktop…</div>;
  }

  if (!runtime?.ready || !runtime.wizardCompleted) {
    return <Wizard initial={runtime} onDone={(status) => void onWizardDone(status)} />;
  }

  const mcpOk = doctor
    ? typeof doctor.ok === "boolean"
      ? doctor.ok
      : !(doctor.checks ?? []).some((check) => (check.status ?? "").toLowerCase() === "fail")
    : null;

  return (
    <div className="app-shell">
      {error ? <div className="error" style={{ padding: "12px 22px" }}>{error}</div> : null}
      {state ? (
        <Home state={state} onAddProject={addProject} adding={adding} />
      ) : stateError ? (
        <RecoveryState
          title="Project reader unavailable"
          message={stateError}
          busy={bootstrapping}
          onRetry={async () => {
            setBootstrapping(true);
            try {
              await refreshObserve();
            } finally {
              setBootstrapping(false);
            }
          }}
          onHealth={() => setHealthOpen(true)}
        />
      ) : (
        <div className="loading" role="status">Loading projects…</div>
      )}
      <HealthStrip
        daemonOk={Boolean(state?.daemon?.reachable)}
        mcpOk={mcpOk}
        runtimeOk={Boolean(runtime?.ready)}
        onOpen={() => {
          setHealthOpen(true);
          void refreshHealth();
        }}
      />
      {healthOpen ? (
        <HealthSheet
          runtime={runtime}
          doctor={doctor}
          doctorError={[runtimeError, doctorError].filter(Boolean).join("\n") || null}
          onClose={() => setHealthOpen(false)}
          onRefresh={async () => {
            await refreshHealth();
            await refreshObserve();
          }}
        />
      ) : null}
    </div>
  );
}
