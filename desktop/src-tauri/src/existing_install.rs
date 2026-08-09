use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExistingInstallEvidence {
    pub id: String,
    pub label: String,
    pub path: String,
    pub detail: String,
    pub ownership: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExistingCliCandidate {
    pub path: String,
    pub target: String,
    pub kind: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExistingInstallScan {
    pub schema_version: String,
    pub status: String,
    pub detected: bool,
    pub can_adopt: bool,
    pub requires_choice: bool,
    pub summary: String,
    pub operator_name: Option<String>,
    pub operator_purpose: Option<String>,
    pub daemon_running: bool,
    pub daemon_ownership: String,
    pub cli_candidates: Vec<ExistingCliCandidate>,
    pub configured_clients: Vec<String>,
    pub would_replace: Vec<String>,
    pub evidence: Vec<ExistingInstallEvidence>,
}

pub fn scan_existing_install(
    home: &Path,
    support_root: &Path,
    daemon_running: bool,
    include_environment_path: bool,
) -> ExistingInstallScan {
    let mut evidence = Vec::new();
    let passport_path = home.join(".seedrop/id/passport.json");
    let mut passport_valid = false;
    let mut operator_name = None;
    let mut operator_purpose = None;
    if passport_path.is_file() {
        let parsed = fs::read_to_string(&passport_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        let agent_id = parsed
            .as_ref()
            .and_then(|value| value.get("agent_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        passport_valid = agent_id.is_some();
        operator_name = parsed
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| agent_id.map(str::to_string));
        operator_purpose = parsed
            .as_ref()
            .and_then(|value| value.get("purpose"))
            .and_then(Value::as_str)
            .map(str::to_string);
        evidence.push(ExistingInstallEvidence {
            id: "operator_passport".into(),
            label: "Operator identity".into(),
            path: passport_path.display().to_string(),
            detail: if let Some(agent_id) = agent_id {
                format!("Existing operator passport for {agent_id}")
            } else {
                "Passport exists but is invalid".into()
            },
            ownership: "shared".into(),
        });
    }

    let space_root = home.join(".seedrop/space");
    if directory_has_entries(&space_root) {
        evidence.push(ExistingInstallEvidence {
            id: "space_data".into(),
            label: "Seedrop Space data".into(),
            path: space_root.display().to_string(),
            detail: "Existing durable coordination data".into(),
            ownership: "shared".into(),
        });
    }

    let journal_path = home.join(".seedrop/state/setup.json");
    if journal_path.is_file() {
        let status = fs::read_to_string(&journal_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| {
                value
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "unknown".into());
        evidence.push(ExistingInstallEvidence {
            id: "setup_journal".into(),
            label: "Setup journal".into(),
            path: journal_path.display().to_string(),
            detail: format!("Existing setup status: {status}"),
            ownership: "shared".into(),
        });
    }

    let plist_path = home.join("Library/LaunchAgents/com.seedrop.daemon.plist");
    let mut daemon_ownership = "none".to_string();
    if let Ok(raw) = fs::read_to_string(&plist_path) {
        let daemon_programs = plist_program_arguments(&raw);
        daemon_ownership = if daemon_programs
            .iter()
            .any(|program| Path::new(program).starts_with(support_root))
        {
            "desktop".into()
        } else {
            "external".into()
        };
        evidence.push(ExistingInstallEvidence {
            id: "space_daemon".into(),
            label: "Always-on Space daemon".into(),
            path: plist_path.display().to_string(),
            detail: match daemon_programs.first() {
                Some(program) => format!(
                    "{} daemon using {program}",
                    if daemon_running {
                        "Running"
                    } else {
                        "Installed"
                    }
                ),
                None => "Daemon plist exists but its command is unreadable".into(),
            },
            ownership: daemon_ownership.clone(),
        });
    }

    let cli_candidates = scan_cli_candidates(home, support_root, include_environment_path);
    for (index, candidate) in cli_candidates.iter().enumerate() {
        evidence.push(ExistingInstallEvidence {
            id: format!("seed_cli_{index}"),
            label: "Seedrop command".into(),
            path: candidate.path.clone(),
            detail: format!("{} installation → {}", candidate.kind, candidate.target),
            ownership: if candidate.kind == "desktop" {
                "desktop".into()
            } else {
                "external".into()
            },
        });
    }

    let configured_clients = scan_client_configs(home);
    for (index, client) in configured_clients.iter().enumerate() {
        evidence.push(ExistingInstallEvidence {
            id: format!("mcp_client_{index}"),
            label: format!("{client} MCP configuration"),
            path: client_config_path(home, client).display().to_string(),
            detail: "Existing Seedrop MCP wiring".into(),
            ownership: "external".into(),
        });
    }

    let detected = !evidence.is_empty();
    let external_daemon = daemon_ownership == "external";
    let external_cli = cli_candidates
        .iter()
        .any(|candidate| candidate.kind != "desktop");
    let external_ownership = external_daemon || external_cli || !configured_clients.is_empty();
    let can_adopt = passport_valid;
    let requires_choice = detected && external_ownership;
    let mut would_replace = Vec::new();
    if external_daemon {
        would_replace.push("Space daemon ownership".into());
    }
    for client in &configured_clients {
        would_replace.push(format!("{client} MCP configuration"));
    }
    let status = if !detected {
        "none"
    } else if daemon_ownership == "desktop" && !external_ownership {
        "desktop_managed"
    } else if can_adopt {
        "existing_ready"
    } else {
        "existing_partial"
    };
    let summary = match status {
        "none" => "No existing Seedrop installation found".into(),
        "desktop_managed" => "Desktop already manages this Seedrop installation".into(),
        "existing_ready" => {
            "An existing Seedrop installation can be used without replacing it".into()
        }
        _ => "Seedrop evidence exists, but no valid operator identity was found".into(),
    };

    ExistingInstallScan {
        schema_version: "1.0".into(),
        status: status.into(),
        detected,
        can_adopt,
        requires_choice,
        summary,
        operator_name,
        operator_purpose,
        daemon_running,
        daemon_ownership,
        cli_candidates,
        configured_clients,
        would_replace,
        evidence,
    }
}

fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

fn scan_client_configs(home: &Path) -> Vec<String> {
    ["Codex", "Claude", "Cursor"]
        .into_iter()
        .filter(|client| {
            let path = client_config_path(home, client);
            fs::metadata(&path)
                .ok()
                .filter(|metadata| metadata.is_file() && metadata.len() <= MAX_CONFIG_BYTES)
                .and_then(|_| fs::read_to_string(path).ok())
                .map(|raw| raw.to_ascii_lowercase().contains("seedrop"))
                .unwrap_or(false)
        })
        .map(str::to_string)
        .collect()
}

fn client_config_path(home: &Path, client: &str) -> PathBuf {
    match client {
        "Codex" => home.join(".codex/config.toml"),
        "Claude" => home.join(".claude.json"),
        "Cursor" => home.join(".cursor/mcp.json"),
        _ => home.join(".seedrop/unknown-client"),
    }
}

fn scan_cli_candidates(
    home: &Path,
    support_root: &Path,
    include_environment_path: bool,
) -> Vec<ExistingCliCandidate> {
    let mut paths = BTreeSet::new();
    for path in [
        PathBuf::from("/opt/homebrew/bin/seed"),
        PathBuf::from("/usr/local/bin/seed"),
        home.join(".local/bin/seed"),
        home.join(".volta/bin/seed"),
    ] {
        if path.exists() {
            paths.insert(path);
        }
    }
    for (root, suffix) in [
        (home.join(".nvm/versions/node"), "bin/seed"),
        (home.join(".fnm/node-versions"), "installation/bin/seed"),
        (home.join(".asdf/installs/nodejs"), "bin/seed"),
        (home.join(".local/share/mise/installs/node"), "bin/seed"),
    ] {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let candidate = entry.path().join(suffix);
                if candidate.exists() {
                    paths.insert(candidate);
                }
            }
        }
    }
    if include_environment_path {
        if let Ok(found) = which::which_all("seed") {
            paths.extend(found);
        }
    }

    paths
        .into_iter()
        .map(|path| {
            let target = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            let display = target.display().to_string();
            let kind = if target.starts_with(support_root) {
                "desktop"
            } else if display.contains("/node_modules/@seedrop/cli/")
                || display.contains("/.nvm/")
                || display.contains("/.fnm/")
                || display.contains("/.volta/")
                || display.contains("/.asdf/")
                || display.contains("/.local/share/mise/")
            {
                "npm"
            } else if display.ends_with("/cli/bin/seed.mjs") {
                "source_link"
            } else {
                "unknown"
            };
            ExistingCliCandidate {
                path: path.display().to_string(),
                target: display,
                kind: kind.into(),
            }
        })
        .collect()
}

fn plist_program_arguments(raw: &str) -> Vec<String> {
    let Some(after_key) = raw.split("<key>ProgramArguments</key>").nth(1) else {
        return Vec::new();
    };
    let Some(array) = after_key.split("</array>").next() else {
        return Vec::new();
    };
    let mut values = Vec::new();
    let mut remaining = array;
    while let Some(start) = remaining.find("<string>") {
        let after_start = &remaining[start + "<string>".len()..];
        let Some(end) = after_start.find("</string>") else {
            break;
        };
        values.push(xml_unescape(&after_start[..end]));
        remaining = &after_start[end + "</string>".len()..];
    }
    values
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("seedrop-existing-{name}-{nonce}"));
        fs::create_dir_all(&path).expect("scratch");
        path
    }

    #[test]
    fn empty_machine_has_no_existing_install() {
        let home = scratch("empty");
        let scan = scan_existing_install(&home, &home.join("support"), false, false);
        assert!(!scan.detected);
        assert_eq!(scan.status, "none");
        fs::remove_dir_all(home).expect("cleanup");
    }

    #[test]
    fn npm_legacy_install_is_adoptable_and_reports_replacement_risk() {
        let home = scratch("npm");
        let support = home.join("Library/Application Support/Seedrop");
        fs::create_dir_all(home.join(".seedrop/id")).expect("identity dir");
        fs::write(
            home.join(".seedrop/id/passport.json"),
            r#"{"schema_version":"1.0","agent_id":"mc","name":"MC","purpose":"Build"}"#,
        )
        .expect("passport");
        fs::create_dir_all(home.join(".seedrop/space")).expect("space");
        fs::write(home.join(".seedrop/space/live.db"), "existing").expect("space data");
        let package_bin = home.join(".nvm/versions/node/v20/bin");
        let package_target =
            home.join(".nvm/versions/node/v20/lib/node_modules/@seedrop/cli/bin/seed.mjs");
        fs::create_dir_all(&package_bin).expect("bin");
        fs::create_dir_all(package_target.parent().expect("target parent")).expect("package");
        fs::write(&package_target, "#!/usr/bin/env node").expect("seed");
        symlink(&package_target, package_bin.join("seed")).expect("link");
        fs::create_dir_all(home.join(".codex")).expect("codex");
        fs::write(
            home.join(".codex/config.toml"),
            "[mcp_servers.seedrop]\ncommand='node'\n",
        )
        .expect("config");
        fs::create_dir_all(home.join("Library/LaunchAgents")).expect("agents");
        fs::write(
            home.join("Library/LaunchAgents/com.seedrop.daemon.plist"),
            "<key>ProgramArguments</key><array><string>/legacy/node</string><string>/legacy/seed</string></array>",
        )
        .expect("plist");

        let scan = scan_existing_install(&home, &support, true, false);
        assert_eq!(scan.status, "existing_ready");
        assert!(scan.can_adopt);
        assert!(scan.requires_choice);
        assert_eq!(scan.daemon_ownership, "external");
        assert!(scan
            .cli_candidates
            .iter()
            .any(|candidate| candidate.kind == "npm"));
        assert!(scan
            .would_replace
            .contains(&"Space daemon ownership".into()));
        assert!(scan
            .would_replace
            .contains(&"Codex MCP configuration".into()));
        fs::remove_dir_all(home).expect("cleanup");
    }

    #[test]
    fn partial_install_fails_closed_without_a_valid_identity() {
        let home = scratch("partial");
        fs::create_dir_all(home.join(".seedrop/id")).expect("identity dir");
        fs::write(home.join(".seedrop/id/passport.json"), "not-json").expect("bad passport");
        let scan = scan_existing_install(&home, &home.join("support"), false, false);
        assert!(scan.detected);
        assert!(!scan.can_adopt);
        assert_eq!(scan.status, "existing_partial");
        fs::remove_dir_all(home).expect("cleanup");
    }
}
