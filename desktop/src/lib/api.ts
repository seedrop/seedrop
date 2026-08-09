import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  CommandResult,
  DoctorReport,
  ObserverState,
  RuntimeStatus,
} from "./types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    throw new Error("Seedrop Desktop commands require the Tauri app (npm run tauri:dev).");
  }
  return invoke<T>(cmd, args);
}

export const api = {
  getSetupState: () => call<RuntimeStatus>("get_setup_state"),
  ensureRuntime: () => call<RuntimeStatus>("ensure_runtime"),
  completeWizard: (operatorName: string, purpose: string, replaceExisting = false) =>
    call<RuntimeStatus>("complete_wizard", { operatorName, purpose, replaceExisting }),
  adoptExistingInstall: () => call<RuntimeStatus>("adopt_existing_install"),
  observeState: () => call<ObserverState>("observe_state"),
  doctorJson: () => call<DoctorReport>("doctor_json"),
  doctorFix: () => call<CommandResult>("doctor_fix"),
  bootstrapProject: (folder: string) =>
    call<CommandResult>("bootstrap_project", { folder }),
  openPath: (path: string) => call<void>("open_path", { path }),
  pickFolder: async (): Promise<string | null> => {
    if (!isTauri) return null;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") return selected;
    return null;
  },
};

export { isTauri };
