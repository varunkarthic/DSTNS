// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Where the launcher finds and writes things.
//!
//! Every path is derived from the repository root, so the launcher works from any working directory. A checkout inside
//! OneDrive, iCloud Drive, Dropbox or Google Drive keeps everything DSTNS generates on local disk, and only the
//! sources stay in the synced folder: the client would otherwise evict those files, and reading one would wait on the
//! network. `DSTNS_LOGS_DIR` and `DSTNS_BUILD_DIR` choose the logs and the build outright.

use sha2::{Digest, Sha256};
use std::env;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

const SYNC_PREFIXES: &[&str] = &["OneDrive", "Dropbox", "Google Drive", "GoogleDrive", "iCloud Drive"];
const SYNC_NAMES: &[&str] = &["Box", "Mobile Documents", "CloudStorage"];

/// The repository: DSTNS_ROOT (which ./launcher sets), else the nearest directory above the program that holds
/// CMakeLists.txt and config/defaults.json, else the working directory.
pub fn root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        if let Ok(value) = env::var("DSTNS_ROOT") {
            if !value.is_empty() {
                return absolute(Path::new(&value));
            }
        }
        let looks_right = |dir: &Path| dir.join("CMakeLists.txt").is_file() && dir.join("config").join("defaults.json").exists();
        let mut starts = vec![];
        if let Ok(exe) = env::current_exe() {
            starts.push(exe);
        }
        if let Ok(cwd) = env::current_dir() {
            starts.push(cwd);
        }
        for start in starts {
            let mut dir = Some(start.as_path());
            while let Some(d) = dir {
                if looks_right(d) {
                    return d.to_path_buf();
                }
                dir = d.parent();
            }
        }
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    })
}

/// Absolute and normalised, without requiring the path to exist.
pub fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() { path.to_path_buf() } else { env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `path` lies in a folder a cloud client syncs (and may evict).
pub fn cloud_synced(path: &Path) -> bool {
    absolute(path).components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        SYNC_NAMES.contains(&name.as_ref()) || SYNC_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
    })
}

/// Whether `path` is a cloud placeholder, so that reading it would wait on the network (macOS SF_DATALESS).
pub fn dataless(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(name) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
        let mut info: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::stat(name.as_ptr(), &mut info) } != 0 {
            return false;
        }
        info.st_flags & 0x4000_0000 != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

fn home() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Logs that must stay on this machine.
pub fn local_state_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        return home().join("Library").join("Logs").join("DSTNS");
    }
    env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(".local").join("state")).join("dstns")
}

/// Rebuildable files that must stay on this machine.
pub fn local_cache_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        return home().join("Library").join("Caches").join("DSTNS");
    }
    env::var_os("XDG_CACHE_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(".cache")).join("dstns")
}

/// A short, stable name for one checkout, so two checkouts never share a build.
pub fn checkout_id(root: &Path) -> String {
    let digest = Sha256::digest(absolute(root).to_string_lossy().as_bytes());
    hex(&digest)[..10].to_string()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub root: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        Self { root: root().to_path_buf() }
    }
}

impl Paths {
    #[cfg(test)]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn config(&self) -> PathBuf {
        self.root.join("config").join("defaults.json")
    }
    pub fn ui_config(&self) -> PathBuf {
        self.root.join("config").join("ui-config.json")
    }
    /// The launcher's own state, such as whether it has been set up: kept in the checkout, and never committed.
    pub fn launcher_env(&self) -> PathBuf {
        if let Ok(value) = env::var("DSTNS_LAUNCHER_ENV") {
            if !value.is_empty() {
                return PathBuf::from(value);
            }
        }
        self.root.join("config").join("launcher.env")
    }
    pub fn synced(&self) -> bool {
        cloud_synced(&self.root)
    }
    pub fn local_workspace(&self) -> PathBuf {
        local_cache_dir().join(format!("checkout-{}", checkout_id(&self.root)))
    }
    pub fn logs(&self) -> PathBuf {
        if let Ok(value) = env::var("DSTNS_LOGS_DIR") {
            if !value.is_empty() {
                return absolute(Path::new(&value));
            }
        }
        if self.synced() {
            return local_state_dir().join(format!("logs-{}", checkout_id(&self.root)));
        }
        self.root.join("logs")
    }
    pub fn active_server(&self) -> PathBuf {
        self.logs().join("launcher.json")
    }
    pub fn launcher_log(&self) -> PathBuf {
        let logs = self.logs();
        if cloud_synced(&logs) {
            return local_state_dir().join("launcher.log");
        }
        logs.join("launcher.log")
    }
    pub fn token(&self) -> PathBuf {
        self.logs().join("operator.token")
    }
    pub fn runtime_db(&self) -> PathBuf {
        self.logs().join("runtime.db")
    }
    pub fn system_log(&self) -> PathBuf {
        self.logs().join("system.log")
    }
    pub fn build(&self) -> PathBuf {
        if let Ok(value) = env::var("DSTNS_BUILD_DIR") {
            if !value.is_empty() {
                let expanded = value.strip_prefix("~/").map(|rest| home().join(rest)).unwrap_or_else(|| PathBuf::from(&value));
                return absolute(&expanded);
            }
        }
        if self.synced() {
            self.local_workspace().join("build")
        } else {
            self.root.join("build")
        }
    }
    pub fn server(&self) -> PathBuf {
        self.build().join("dstns_server")
    }
    pub fn export_tool(&self) -> PathBuf {
        self.build().join("dstns_scenario_export")
    }
    /// The observer's sources.
    pub fn ui_engine(&self) -> PathBuf {
        self.root.join("WebKit")
    }
    /// Where npm installs and builds the observer: the sources themselves, or a local mirror of them in a synced
    /// checkout (node_modules alone is tens of thousands of files a sync client would upload and then evict).
    pub fn observer_build(&self) -> PathBuf {
        if self.synced() {
            self.local_workspace().join("source").join("WebKit")
        } else {
            self.ui_engine()
        }
    }
    pub fn ui_dist(&self) -> PathBuf {
        self.observer_build().join("dist")
    }
    /// Where city extracts are cached: `map.cache_dir`, except that the default, data/maps, moves to local disk in a
    /// synced checkout.
    pub fn map_cache(&self, configured: Option<&str>) -> PathBuf {
        let configured = configured.filter(|c| !c.is_empty()).unwrap_or("data/maps");
        if self.synced() && Path::new(configured) == Path::new("data/maps") {
            return self.local_workspace().join("maps");
        }
        absolute(&self.root.join(configured))
    }
    /// Where Fast Boot keeps every city, compressed, apart from the map cache, which is pruned.
    pub fn fastboot(&self) -> PathBuf {
        self.map_cache(None).join("fastboot")
    }
    /// What the server needs besides its arguments: where the observer is, when not in the checkout.
    pub fn server_environment(&self) -> Vec<(String, String)> {
        if self.ui_dist() != self.ui_engine().join("dist") {
            return vec![("DSTNS_UI_DIST".into(), self.ui_dist().to_string_lossy().into_owned())];
        }
        vec![]
    }
    pub fn seed_store(&self) -> PathBuf {
        if let Ok(value) = env::var("DSTNS_SEED_DB") {
            if !value.is_empty() {
                return PathBuf::from(value);
            }
        }
        self.root.join("data").join("seed-store").join("seeds.sqlite3")
    }
    /// A path to show: relative to the checkout where it is inside it.
    pub fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synced_folders_are_recognised() {
        assert!(cloud_synced(Path::new("/Users/a/Library/CloudStorage/OneDrive-X/DSTNS")));
        assert!(cloud_synced(Path::new("/Users/a/Dropbox/DSTNS")));
        assert!(!cloud_synced(Path::new("/Users/a/Code/DSTNS")));
    }

    #[test]
    fn a_synced_checkout_keeps_its_build_and_maps_local() {
        let paths = Paths::new("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/DSTNS");
        assert!(paths.build().starts_with(local_cache_dir()));
        assert!(paths.map_cache(None).starts_with(local_cache_dir()));
        assert!(!paths.map_cache(Some("elsewhere")).starts_with(local_cache_dir()));
    }

    #[test]
    fn checkout_ids_are_short_and_stable() {
        assert_eq!(checkout_id(Path::new("/a/b")), checkout_id(Path::new("/a/b")));
        assert_ne!(checkout_id(Path::new("/a/b")), checkout_id(Path::new("/a/c")));
        assert_eq!(checkout_id(Path::new("/a/b")).len(), 10);
    }
}
