// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Whether the launcher has been set up on this checkout.
//!
//! It's an environment variable, DSTNS_SETUP_COMPLETE. The launcher keeps it in config/launcher.env, which it reads
//! as it starts, so that it lasts from one start to the next; a variable already set in the shell wins, so that
//! `DSTNS_SETUP_COMPLETE=1 ./launcher` skips the setup and `DSTNS_SETUP_COMPLETE=0 ./launcher` runs it again. A reset
//! through the launcher forgets it. Scripted commands never run the setup.

use crate::paths::Paths;
use std::env;
use std::fs;

pub const ENV: &str = "DSTNS_SETUP_COMPLETE";

/// What config/launcher.env keeps, in order.
pub fn entries(paths: &Paths) -> Vec<(String, String)> {
    fs::read_to_string(paths.launcher_env())
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().trim_matches('"').to_string()))
        .collect()
}

/// What config/launcher.env holds, into this process's environment, beneath anything already set.
pub fn load_env(paths: &Paths) {
    // A copy written before it was kept owner-only, by an older launcher, is made so now.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(paths.launcher_env()) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(paths.launcher_env(), fs::Permissions::from_mode(0o600));
            }
        }
    }
    for (key, value) in entries(paths) {
        if env::var_os(&key).is_none() {
            env::set_var(key, value);
        }
    }
}

pub fn first_launch() -> bool {
    !matches!(env::var(ENV).as_deref(), Ok("1") | Ok("true") | Ok("yes"))
}

/// Keep these in config/launcher.env, and nothing else.
pub fn save_entries(paths: &Paths, entries: &[(String, String)]) -> std::io::Result<()> {
    let path = paths.launcher_env();
    if entries.is_empty() {
        return match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let mut text = String::from("# The DSTNS launcher's own state, for this checkout. Not committed; ./launcher reset clears it.\n");
    for (key, value) in entries {
        text.push_str(&format!("{key}={value}\n"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("env.tmp");
    // It may hold API keys: readable by this account only, from the moment it exists.
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let _ = fs::remove_file(&temporary);
    std::io::Write::write_all(&mut options.open(&temporary)?, text.as_bytes())?;
    fs::rename(temporary, path)
}

/// The setup is done: remember it.
pub fn complete(paths: &Paths) -> std::io::Result<()> {
    let mut entries: Vec<(String, String)> = entries(paths).into_iter().filter(|(k, _)| k != ENV).collect();
    entries.push((ENV.into(), "1".into()));
    env::set_var(ENV, "1");
    save_entries(paths, &entries)
}

/// Forget that it was set up, so that the next interactive start runs the setup again.
pub fn forget(paths: &Paths) {
    let entries: Vec<(String, String)> = entries(paths).into_iter().filter(|(k, _)| k != ENV).collect();
    let _ = save_entries(paths, &entries);
    env::remove_var(ENV);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("dstns-env-mode-{}", std::process::id()));
        let paths = Paths::new(&dir);
        save_entries(&paths, &[("DSTNS_OPENAI_API_KEY".into(), "k".into())]).unwrap();
        let mode = fs::metadata(paths.launcher_env()).unwrap().permissions().mode() & 0o777;
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn setup_is_remembered_and_forgotten() {
        let dir = env::temp_dir().join(format!("dstns-setup-{}", std::process::id()));
        fs::create_dir_all(dir.join("config")).unwrap();
        let paths = Paths::new(&dir);
        env::remove_var(ENV);
        assert!(first_launch());
        complete(&paths).unwrap();
        assert!(!first_launch());
        env::remove_var(ENV);
        load_env(&paths);
        assert!(!first_launch(), "a later start reads it back");
        forget(&paths);
        assert!(first_launch());
        assert!(!paths.launcher_env().exists());
        fs::remove_dir_all(dir).ok();
    }
}
