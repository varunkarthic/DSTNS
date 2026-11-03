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

fn read(paths: &Paths) -> Vec<(String, String)> {
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
    for (key, value) in read(paths) {
        if env::var_os(&key).is_none() {
            env::set_var(key, value);
        }
    }
}

pub fn first_launch() -> bool {
    !matches!(env::var(ENV).as_deref(), Ok("1") | Ok("true") | Ok("yes"))
}

fn write(paths: &Paths, entries: &[(String, String)]) -> std::io::Result<()> {
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
    fs::write(&temporary, text)?;
    fs::rename(temporary, path)
}

/// The setup is done: remember it.
pub fn complete(paths: &Paths) -> std::io::Result<()> {
    let mut entries: Vec<(String, String)> = read(paths).into_iter().filter(|(k, _)| k != ENV).collect();
    entries.push((ENV.into(), "1".into()));
    env::set_var(ENV, "1");
    write(paths, &entries)
}

/// Forget that it was set up, so that the next interactive start runs the setup again.
pub fn forget(paths: &Paths) {
    let entries: Vec<(String, String)> = read(paths).into_iter().filter(|(k, _)| k != ENV).collect();
    let _ = write(paths, &entries);
    env::remove_var(ENV);
}

#[cfg(test)]
mod tests {
    use super::*;

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
