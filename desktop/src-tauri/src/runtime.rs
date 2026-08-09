use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema_version: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub source_hash: String,
    pub node_version: String,
    pub node_archive_sha256: String,
    pub generated_at: String,
    pub entries: Vec<RuntimeManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifestEntry {
    pub path: String,
    pub kind: String,
    pub sha256: String,
    pub target: Option<String>,
    pub executable: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponent {
    pub id: String,
    pub ok: bool,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct InstalledRuntime {
    pub root: PathBuf,
    pub version: String,
    pub arch: String,
    pub source_hash: String,
    pub node_version: String,
    pub manifest_sha256: String,
    pub node_path: PathBuf,
    pub seed_path: PathBuf,
    pub mcp_path: PathBuf,
    pub observer_path: PathBuf,
    pub bin_dir: PathBuf,
    pub components: Vec<RuntimeComponent>,
}

const REQUIRED_COMPONENTS: &[(&str, &str)] = &[
    ("node", "node/bin/node"),
    ("cli", "payload/node_modules/@seedrop/cli/dist/cli.js"),
    ("mcp", "payload/node_modules/@seedrop/mcp/dist/cli.js"),
    (
        "observer",
        "payload/node_modules/@seedrop/observer/dist/cli.js",
    ),
    (
        "space-live-store",
        "payload/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    ),
];

pub fn expected_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

pub fn inspect_runtime(root: &Path) -> Result<InstalledRuntime, String> {
    let manifest = verify_release(root)?;
    let manifest_sha256 = sha256_file(&root.join("runtime-manifest.json"))
        .map_err(|error| format!("runtime manifest unreadable: {error}"))?;
    if manifest.platform != "darwin" {
        return Err(format!(
            "runtime targets {}, expected darwin",
            manifest.platform
        ));
    }
    if manifest.arch != expected_arch() {
        return Err(format!(
            "runtime targets {}, expected {}",
            manifest.arch,
            expected_arch()
        ));
    }

    let components = REQUIRED_COMPONENTS
        .iter()
        .map(|(id, relative)| {
            let path = root.join(relative);
            RuntimeComponent {
                id: (*id).to_string(),
                ok: path.is_file(),
                path: path.display().to_string(),
                message: if path.is_file() {
                    "verified".into()
                } else {
                    "missing".into()
                },
            }
        })
        .collect::<Vec<_>>();

    if let Some(missing) = components.iter().find(|component| !component.ok) {
        return Err(format!("runtime component missing: {}", missing.id));
    }

    Ok(InstalledRuntime {
        root: root.to_path_buf(),
        version: manifest.version,
        arch: manifest.arch,
        source_hash: manifest.source_hash,
        node_version: manifest.node_version,
        manifest_sha256,
        node_path: root.join("node/bin/node"),
        seed_path: root.join("payload/node_modules/@seedrop/cli/dist/cli.js"),
        mcp_path: root.join("payload/node_modules/@seedrop/mcp/dist/cli.js"),
        observer_path: root.join("payload/node_modules/@seedrop/observer/dist/cli.js"),
        bin_dir: root.join("payload/node_modules/.bin"),
        components,
    })
}

pub fn install_release(source: &Path, runtime_root: &Path) -> Result<InstalledRuntime, String> {
    let source_runtime = inspect_runtime(source)?;
    fs::create_dir_all(runtime_root).map_err(|error| error.to_string())?;
    let identity = format!(
        "{}-{}-{}",
        safe_segment(&source_runtime.version),
        source_runtime.arch,
        &source_runtime.source_hash[..source_runtime.source_hash.len().min(12)]
    );
    let target = runtime_root.join(identity);

    if target.exists() {
        if let Ok(installed) = inspect_runtime(&target) {
            return Ok(installed);
        }
        let quarantine = runtime_root.join(format!(
            ".invalid-{}-{}",
            target
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("runtime"),
            unix_seconds()
        ));
        fs::rename(&target, quarantine).map_err(|error| error.to_string())?;
    }

    let staging = runtime_root.join(format!(
        ".install-{}-{}",
        std::process::id(),
        unix_seconds()
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    copy_tree(source, &staging)?;
    let staged = inspect_runtime(&staging)?;
    if staged.source_hash != source_runtime.source_hash {
        let _ = fs::remove_dir_all(&staging);
        return Err("staged runtime does not match bundled runtime".into());
    }

    match fs::rename(&staging, &target) {
        Ok(()) => {}
        Err(error) if target.exists() => {
            let _ = fs::remove_dir_all(&staging);
            inspect_runtime(&target).map_err(|_| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let installed = inspect_runtime(&target)?;
    Ok(installed)
}

pub fn verify_release(root: &Path) -> Result<RuntimeManifest, String> {
    let manifest_path = root.join("runtime-manifest.json");
    let raw = fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "runtime manifest unavailable at {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest: RuntimeManifest =
        serde_json::from_str(&raw).map_err(|error| format!("runtime manifest invalid: {error}"))?;
    if manifest.schema_version != "1.0" {
        return Err(format!(
            "unsupported runtime manifest {}",
            manifest.schema_version
        ));
    }

    let mut declared = HashSet::new();
    for entry in &manifest.entries {
        if !declared.insert(entry.path.clone()) {
            return Err(format!("duplicate runtime manifest path: {}", entry.path));
        }
        let relative = safe_relative(&entry.path)?;
        let absolute = root.join(relative);
        if entry.kind != "file" {
            return Err(format!("unsupported runtime entry kind {}", entry.kind));
        }
        let metadata = fs::symlink_metadata(&absolute)
            .map_err(|error| format!("runtime file unreadable {}: {error}", entry.path))?;
        if !metadata.is_file() {
            return Err(format!(
                "runtime entry is not a regular file: {}",
                entry.path
            ));
        }
        #[cfg(unix)]
        if entry.executable == Some(true) {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(format!("runtime executable bit missing: {}", entry.path));
            }
        }
        let actual = sha256_file(&absolute)
            .map_err(|error| format!("runtime file unreadable {}: {error}", entry.path))?;
        if actual != entry.sha256 {
            return Err(format!("runtime integrity mismatch: {}", entry.path));
        }
    }
    let mut actual = HashSet::new();
    collect_runtime_files(root, root, &mut actual)?;
    actual.remove("runtime-manifest.json");
    if actual != declared {
        return Err("runtime contents differ from the sealed manifest".into());
    }
    Ok(manifest)
}

fn collect_runtime_files(
    root: &Path,
    current: &Path,
    output: &mut HashSet<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_runtime_files(root, &path, output)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .to_string();
            output.insert(relative);
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&source_path).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, destination_path)
                .map_err(|error| error.to_string())?;
            #[cfg(not(unix))]
            return Err("Desktop runtime symlinks require a Unix host".into());
        } else if metadata.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| error.to_string())?;
            fs::set_permissions(&destination_path, metadata.permissions())
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe runtime manifest path: {value}"));
    }
    Ok(path.to_path_buf())
}

fn safe_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
fn sha256_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("{:x}", hasher.finalize())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "seedrop-desktop-{name}-{}-{}",
            std::process::id(),
            unix_seconds()
        ))
    }

    fn write_runtime_fixture(root: &Path, source_hash: &str) {
        let mut entries = Vec::new();
        for (id, relative) in REQUIRED_COMPONENTS {
            let absolute = root.join(relative);
            fs::create_dir_all(absolute.parent().unwrap()).unwrap();
            let contents = format!("fixture:{id}");
            fs::write(&absolute, contents.as_bytes()).unwrap();
            #[cfg(unix)]
            if *id == "node" {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&absolute, fs::Permissions::from_mode(0o755)).unwrap();
            }
            entries.push(RuntimeManifestEntry {
                path: (*relative).into(),
                kind: "file".into(),
                sha256: sha256_bytes(contents.as_bytes()),
                target: None,
                executable: Some(*id == "node"),
            });
        }
        let manifest = RuntimeManifest {
            schema_version: "1.0".into(),
            version: "test".into(),
            platform: "darwin".into(),
            arch: expected_arch().into(),
            source_hash: source_hash.into(),
            node_version: "20.19.4".into(),
            node_archive_sha256: "fixture-archive-sha256".into(),
            generated_at: "test".into(),
            entries,
        };
        fs::write(
            root.join("runtime-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn rejects_parent_paths_in_manifest() {
        assert!(safe_relative("../escape").is_err());
        assert!(safe_relative("/absolute").is_err());
        assert!(safe_relative("node/bin/node").is_ok());
    }

    #[test]
    fn detects_manifest_tampering() {
        let root = scratch("integrity");
        fs::create_dir_all(root.join("node/bin")).unwrap();
        fs::write(root.join("node/bin/node"), b"node").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                root.join("node/bin/node"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let manifest = RuntimeManifest {
            schema_version: "1.0".into(),
            version: "test".into(),
            platform: "darwin".into(),
            arch: expected_arch().into(),
            source_hash: "0123456789abcdef".into(),
            node_version: "20.19.4".into(),
            node_archive_sha256: "fixture-archive-sha256".into(),
            generated_at: "test".into(),
            entries: vec![RuntimeManifestEntry {
                path: "node/bin/node".into(),
                kind: "file".into(),
                sha256: sha256_bytes(b"node"),
                target: None,
                executable: Some(true),
            }],
        };
        fs::write(
            root.join("runtime-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(verify_release(&root).is_ok());
        fs::write(root.join("node/bin/node"), b"tampered").unwrap();
        assert!(verify_release(&root)
            .unwrap_err()
            .contains("integrity mismatch"));
        fs::write(root.join("node/bin/node"), b"node").unwrap();
        fs::write(root.join("unexpected"), b"extra").unwrap();
        assert!(verify_release(&root)
            .unwrap_err()
            .contains("contents differ"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn install_is_idempotent_and_repairs_a_corrupt_current_version() {
        let source = scratch("source");
        let installed_root = scratch("installed");
        fs::create_dir_all(&source).unwrap();
        write_runtime_fixture(&source, "0123456789abcdef");

        let first = install_release(&source, &installed_root).unwrap();
        let second = install_release(&source, &installed_root).unwrap();
        assert_eq!(first.root, second.root);

        fs::write(&first.seed_path, b"corrupt").unwrap();
        assert!(inspect_runtime(&first.root).is_err());
        let repaired = install_release(&source, &installed_root).unwrap();
        assert_eq!(repaired.root, first.root);
        assert!(inspect_runtime(&repaired.root).is_ok());
        assert!(fs::read_dir(&installed_root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".invalid-")));

        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(installed_root);
    }
}
