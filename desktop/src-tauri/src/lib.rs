mod existing_install;
mod process;
mod runtime;

use existing_install::{scan_existing_install, ExistingInstallScan};
use process::run_command;
use runtime::{inspect_runtime, install_release, InstalledRuntime, RuntimeComponent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Manager;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const DESKTOP_MARKER: &str = "desktop.json";
const RUNTIME_DIR: &str = "runtime";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopConfig {
    pub schema_version: String,
    pub completed_at: Option<String>,
    pub operator_name: Option<String>,
    pub purpose: Option<String>,
    pub runtime_version: Option<String>,
    pub runtime_root: Option<String>,
    pub setup_mode: Option<String>,
    // Legacy V0 fields are retained only so an existing marker remains readable.
    pub runtime_prefix: Option<String>,
    pub seed_path: Option<String>,
    pub node_path: Option<String>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            schema_version: "3.0".into(),
            completed_at: None,
            operator_name: None,
            purpose: None,
            runtime_version: None,
            runtime_root: None,
            setup_mode: None,
            runtime_prefix: None,
            seed_path: None,
            node_path: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub ok: bool,
    pub ready: bool,
    pub phase: String,
    pub arch: String,
    pub runtime_version: Option<String>,
    pub runtime_root: Option<String>,
    pub node_path: Option<String>,
    pub seed_path: Option<String>,
    pub mcp_path: Option<String>,
    pub observer_path: Option<String>,
    pub wizard_completed: bool,
    pub setup_phase: String,
    pub setup_mode: Option<String>,
    pub existing_install: ExistingInstallScan,
    pub message: String,
    pub components: Vec<RuntimeComponent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "home directory not found".into())
}

fn support_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Ok(override_path) = std::env::var("SEEDROP_DESKTOP_SUPPORT_ROOT") {
        return Ok(PathBuf::from(override_path));
    }
    Ok(home_dir()?.join("Library/Application Support/Seedrop"))
}

fn runtime_root() -> Result<PathBuf, String> {
    Ok(support_root()?.join(RUNTIME_DIR))
}

fn marker_path() -> Result<PathBuf, String> {
    Ok(support_root()?.join(DESKTOP_MARKER))
}

fn default_passport_path() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("SEEDROP_PASSPORT") {
        return Ok(PathBuf::from(value));
    }
    Ok(home_dir()?.join(".seedrop/id/passport.json"))
}

fn setup_journal_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".seedrop/state/setup.json"))
}

fn setup_phase() -> Result<String, String> {
    let path = setup_journal_path()?;
    if !path.exists() {
        return Ok("not_started".into());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    Ok(value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string())
}

fn daemon_is_running() -> bool {
    // SAFETY: getuid has no preconditions and does not dereference memory.
    let uid = unsafe { libc::getuid() };
    Command::new("launchctl")
        .args(["print", &format!("gui/{uid}/com.seedrop.daemon")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn existing_install_scan() -> Result<ExistingInstallScan, String> {
    Ok(scan_existing_install(
        &home_dir()?,
        &support_root()?,
        daemon_is_running(),
        true,
    ))
}

fn setup_requires_explicit_choice(scan: &ExistingInstallScan) -> bool {
    scan.detected && scan.status != "desktop_managed"
}

fn read_config() -> Result<DesktopConfig, String> {
    let path = marker_path()?;
    if !path.exists() {
        return Ok(DesktopConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("Desktop config is invalid: {error}"))
}

fn write_config(config: &DesktopConfig) -> Result<(), String> {
    let root = support_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = marker_path()?;
    let staging = root.join(format!(".{DESKTOP_MARKER}.{}", std::process::id()));
    let raw = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&staging, format!("{raw}\n")).map_err(|error| error.to_string())?;
    fs::rename(staging, path).map_err(|error| error.to_string())
}

fn bundled_release_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Ok(override_path) = std::env::var("SEEDROP_DESKTOP_RELEASE") {
        let candidate = PathBuf::from(override_path);
        if candidate.join("runtime-manifest.json").exists() {
            return Ok(candidate);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("resources/release"),
            resource_dir.join("release"),
        ] {
            if candidate.join("runtime-manifest.json").exists() {
                return Ok(candidate);
            }
        }
    }

    #[cfg(debug_assertions)]
    {
        let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/release");
        if candidate.join("runtime-manifest.json").exists() {
            return Ok(candidate);
        }
    }

    Err("sealed Desktop runtime is missing from the application bundle".into())
}

fn configured_runtime(
    app: &tauri::AppHandle,
    config: &DesktopConfig,
) -> Result<InstalledRuntime, String> {
    let root = config
        .runtime_root
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| "runtime has not been installed".to_string())?;
    let installed = inspect_runtime(&root)?;
    let trusted = inspect_runtime(&bundled_release_dir(app)?)?;
    if installed.manifest_sha256 != trusted.manifest_sha256 {
        return Err(
            "installed runtime does not match the sealed runtime in this application".into(),
        );
    }
    Ok(installed)
}

#[tauri::command]
fn get_setup_state(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    let config = read_config()?;
    let setup = setup_phase().unwrap_or_else(|_| "unknown".into());
    let existing_install = existing_install_scan()?;
    match configured_runtime(&app, &config) {
        Ok(installed) => {
            let wizard_completed = setup == "completed";
            Ok(RuntimeStatus {
                ok: wizard_completed,
                ready: true,
                phase: if wizard_completed {
                    "ready"
                } else {
                    "setup_required"
                }
                .into(),
                arch: installed.arch.clone(),
                runtime_version: Some(installed.version.clone()),
                runtime_root: Some(installed.root.display().to_string()),
                node_path: Some(installed.node_path.display().to_string()),
                seed_path: Some(installed.seed_path.display().to_string()),
                mcp_path: Some(installed.mcp_path.display().to_string()),
                observer_path: Some(installed.observer_path.display().to_string()),
                wizard_completed,
                setup_phase: setup,
                setup_mode: config.setup_mode.clone(),
                existing_install,
                message: if wizard_completed {
                    format!(
                        "Runtime {} verified; machine setup complete",
                        installed.version
                    )
                } else {
                    format!(
                        "Runtime {} verified; machine setup is required",
                        installed.version
                    )
                },
                components: installed.components,
            })
        }
        Err(error) => Ok(RuntimeStatus {
            ok: false,
            ready: false,
            phase: if config.runtime_root.is_some() {
                "repair_required"
            } else if setup_requires_explicit_choice(&existing_install) {
                "existing_install_detected"
            } else {
                "not_installed"
            }
            .into(),
            arch: runtime::expected_arch().into(),
            runtime_version: config.runtime_version,
            runtime_root: config.runtime_root,
            node_path: None,
            seed_path: None,
            mcp_path: None,
            observer_path: None,
            wizard_completed: false,
            setup_phase: setup,
            setup_mode: config.setup_mode,
            existing_install: existing_install.clone(),
            message: if setup_requires_explicit_choice(&existing_install) {
                format!("{}. Nothing has been changed.", existing_install.summary)
            } else {
                error.clone()
            },
            components: vec![RuntimeComponent {
                id: "runtime".into(),
                ok: false,
                path: runtime_root()?.display().to_string(),
                message: if existing_install.detected {
                    format!("{error}; {}", existing_install.summary)
                } else {
                    error
                },
            }],
        }),
    }
}

#[tauri::command]
fn ensure_runtime(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    let source = bundled_release_dir(&app)?;
    let installed = install_release(&source, &runtime_root()?)?;
    probe_runtime(&installed)?;
    let mut config = read_config()?;
    config.schema_version = "4.0".into();
    config.runtime_version = Some(installed.version);
    config.runtime_root = Some(installed.root.display().to_string());
    config.runtime_prefix = None;
    config.seed_path = None;
    config.node_path = None;
    write_config(&config)?;
    get_setup_state(app)
}

fn runtime_env(runtime: &InstalledRuntime) -> Vec<(&'static str, String)> {
    let existing = std::env::var("PATH").unwrap_or_default();
    let path = format!(
        "{}:{}:{}",
        runtime.bin_dir.display(),
        runtime.root.join("node/bin").display(),
        existing
    );
    vec![
        ("PATH", path),
        (
            "SEEDROP_DESKTOP_RUNTIME",
            runtime.root.display().to_string(),
        ),
    ]
}

fn require_probe(label: &str, result: CommandResult) -> Result<String, String> {
    if result.ok {
        Ok(result.stdout.trim().to_string())
    } else {
        Err(format!(
            "runtime probe failed ({label}, exit {}):\n{}\n{}",
            result.code, result.stdout, result.stderr
        ))
    }
}

fn probe_runtime(runtime: &InstalledRuntime) -> Result<(), String> {
    let env = runtime_env(runtime);
    let version = require_probe(
        "Node",
        run_command(&runtime.node_path, &["--version".into()], None, &env)?,
    )?;
    if version != format!("v{}", runtime.node_version) {
        return Err(format!(
            "runtime Node version mismatch: expected v{}, got {version}",
            runtime.node_version
        ));
    }
    require_probe(
        "Seedrop CLI",
        run_command(
            &runtime.node_path,
            &[runtime.seed_path.display().to_string(), "help".into()],
            None,
            &env,
        )?,
    )?;
    require_probe(
        "Observer",
        run_command(
            &runtime.node_path,
            &[runtime.observer_path.display().to_string(), "--help".into()],
            None,
            &env,
        )?,
    )?;
    let native_path = runtime
        .root
        .join("payload/node_modules/better-sqlite3")
        .display()
        .to_string();
    let native_script = format!(
        "const Database=require({});const db=new Database(':memory:');db.close()",
        serde_json::to_string(&native_path).map_err(|error| error.to_string())?
    );
    require_probe(
        "native datastore",
        run_command(
            &runtime.node_path,
            &["-e".into(), native_script],
            None,
            &env,
        )?,
    )?;
    Ok(())
}

fn run_seed_internal(
    app: &tauri::AppHandle,
    args: Vec<String>,
    cwd: Option<&Path>,
) -> Result<CommandResult, String> {
    let config = read_config()?;
    let runtime = configured_runtime(app, &config)?;
    let mut invocation = vec![runtime.seed_path.display().to_string()];
    invocation.extend(args);
    run_command(&runtime.node_path, &invocation, cwd, &runtime_env(&runtime))
}

#[tauri::command]
fn complete_wizard(
    app: tauri::AppHandle,
    operator_name: String,
    purpose: String,
    replace_existing: bool,
) -> Result<RuntimeStatus, String> {
    let name = operator_name.trim();
    let purpose = purpose.trim();
    if name.is_empty() || purpose.is_empty() {
        return Err("Name and purpose are required".into());
    }

    let scan = existing_install_scan()?;
    if setup_requires_explicit_choice(&scan) && !replace_existing {
        return Err("An existing Seedrop installation was detected. Adopt it or explicitly allow Desktop to replace its MCP and daemon ownership.".into());
    }
    ensure_runtime(app.clone())?;
    let phase = setup_phase().unwrap_or_else(|_| "unknown".into());
    if phase != "completed" || replace_existing {
        let mut args = vec!["init".into()];
        if matches!(phase.as_str(), "in_progress" | "failed") {
            args.push("--resume".into());
        }
        args.extend([
            "--name".into(),
            name.into(),
            "--purpose".into(),
            purpose.into(),
            "--yes".into(),
        ]);
        let init = run_seed_internal(&app, args, None)?;
        if !init.ok {
            return Err(format!(
                "seed init failed:\n{}\n{}",
                init.stdout, init.stderr
            ));
        }
    }

    let mut config = read_config()?;
    config.operator_name = Some(name.to_string());
    config.purpose = Some(purpose.to_string());
    config.setup_mode = Some("managed".into());
    config.completed_at = Some(iso_now());
    write_config(&config)?;
    get_setup_state(app)
}

#[tauri::command]
fn adopt_existing_install(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    let scan = existing_install_scan()?;
    if !scan.detected {
        return Err("No existing Seedrop installation was found to adopt.".into());
    }
    if !scan.can_adopt {
        return Err("Existing Seedrop files were found, but the operator passport is missing or invalid. Adoption stopped without changing shared state.".into());
    }

    ensure_runtime(app.clone())?;
    let phase = setup_phase().unwrap_or_else(|_| "unknown".into());
    if phase != "completed" {
        let mut args = vec!["init".into(), "--adopt-existing".into(), "--yes".into()];
        if matches!(phase.as_str(), "in_progress" | "failed") {
            args.push("--resume".into());
        }
        let adoption = run_seed_internal(&app, args, None)?;
        if !adoption.ok {
            return Err(format!(
                "existing installation adoption failed:\n{}\n{}",
                adoption.stdout, adoption.stderr
            ));
        }
    }

    let mut config = read_config()?;
    config.schema_version = "4.0".into();
    config.setup_mode = Some("adopted_existing".into());
    config.operator_name = scan.operator_name;
    config.purpose = scan.operator_purpose;
    config.completed_at = Some(iso_now());
    write_config(&config)?;
    get_setup_state(app)
}

#[tauri::command]
fn observe_state(app: tauri::AppHandle) -> Result<Value, String> {
    let config = read_config()?;
    let runtime = configured_runtime(&app, &config)?;
    let passport = default_passport_path()?;
    let args = vec![
        runtime.observer_path.display().to_string(),
        "--passport".into(),
        passport.display().to_string(),
    ];
    let result = run_command(&runtime.node_path, &args, None, &runtime_env(&runtime))?;
    let trimmed = result.stdout.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if value.get("ok") == Some(&Value::Bool(false)) {
            return Err(if result.stderr.trim().is_empty() {
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("observer failed")
                    .into()
            } else {
                result.stderr
            });
        }
        return Ok(value);
    }
    Err(format!(
        "observer returned invalid JSON (exit {}):\n{}\n{}",
        result.code, result.stdout, result.stderr
    ))
}

#[tauri::command]
fn doctor_json(app: tauri::AppHandle) -> Result<Value, String> {
    let result = run_seed_internal(&app, vec!["doctor".into(), "--json".into()], None)?;
    let trimmed = result.stdout.trim();
    if trimmed.is_empty() {
        return Err(format!("doctor produced no output:\n{}", result.stderr));
    }
    serde_json::from_str(trimmed)
        .map_err(|error| format!("invalid doctor JSON: {error}\n{trimmed}"))
}

#[tauri::command]
fn doctor_fix(app: tauri::AppHandle) -> Result<CommandResult, String> {
    run_seed_internal(&app, vec!["doctor".into(), "--fix".into()], None)
}

#[tauri::command]
fn bootstrap_project(app: tauri::AppHandle, folder: String) -> Result<CommandResult, String> {
    let selected = fs::canonicalize(&folder)
        .map_err(|error| format!("cannot open selected project folder: {error}"))?;
    if !selected.is_dir() {
        return Err("selected project path is not a directory".into());
    }
    run_seed_internal(&app, vec!["bootstrap".into()], Some(&selected))
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let canonical =
        fs::canonicalize(&path).map_err(|error| format!("path is unavailable: {error}"))?;
    let status = Command::new("open")
        .arg(&canonical)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to open {}", canonical.display()))
    }
}

fn iso_now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_setup_state,
            ensure_runtime,
            complete_wizard,
            adopt_existing_install,
            observe_state,
            doctor_json,
            doctor_fix,
            bootstrap_project,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Seedrop Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_release_passes_execution_probes() {
        let release = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/release");
        let runtime = inspect_runtime(&release).expect("sealed runtime must verify");
        probe_runtime(&runtime).expect("sealed runtime must execute its critical components");
    }

    #[test]
    fn every_non_desktop_install_requires_an_explicit_choice() {
        let home = std::env::temp_dir().join(format!("seedrop-choice-{}", std::process::id()));
        fs::create_dir_all(home.join(".seedrop/id")).expect("identity dir");
        fs::write(home.join(".seedrop/id/passport.json"), "not-json").expect("passport");
        let scan = scan_existing_install(&home, &home.join("support"), false, false);
        assert!(setup_requires_explicit_choice(&scan));
        fs::remove_dir_all(home).expect("cleanup");
    }
}
