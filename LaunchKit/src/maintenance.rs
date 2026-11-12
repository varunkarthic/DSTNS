// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Clearing runtime data. Maps, saved seeds and configuration are never touched. A reset also forgets that the
//! launcher was set up, so the next interactive start runs the setup again.

use crate::paths::Paths;
use crate::reporting::{Level, Reporter};
use std::fs;

const RUNTIME_FILES: &[&str] = &["system.log", "runtime.db", "runtime.db-wal", "runtime.db-shm"];
const RUNTIME_DIRECTORIES: &[(&str, &str)] = &[("checkpoints", "Reset checkpoints"), ("scenarios", "Reset temporary scenarios"), ("sumo_live_run", "Reset SUMO runs")];

/// What a reset deletes, for the confirmation.
pub fn describe(paths: &Paths) -> Vec<String> {
    let mut out: Vec<String> = RUNTIME_FILES.iter().map(|n| paths.logs().join(n).to_string_lossy().into_owned()).collect();
    out.extend(RUNTIME_DIRECTORIES.iter().map(|(n, _)| paths.root.join("data").join(n).to_string_lossy().into_owned()));
    out.push(format!("{} (the launcher runs its setup again)", paths.launcher_env().display()));
    out
}

/// Clears runtime data, unless a server is running: it writes to these files, and its run would lose its journal and
/// checkpoints under it. Returns why it refused.
pub fn reset(reporter: &dyn Reporter, paths: &Paths) -> Result<(), String> {
    if let Some(port) = crate::server::active_port(paths) {
        let why = format!("A DSTNS server is running on port {port}, and a reset would delete the files it is writing. Stop it first with ./launcher stop.");
        reporter.message(Level::Error, "Nothing was reset", &why);
        return Err(why);
    }
    reporter.step_started("Clear runtime logs");
    for name in RUNTIME_FILES {
        let _ = fs::remove_file(paths.logs().join(name));
    }
    reporter.step_finished("Clear runtime logs", true, "logs cleared");
    for (name, title) in RUNTIME_DIRECTORIES {
        reporter.step_started(title);
        let directory = paths.root.join("data").join(name);
        let _ = fs::remove_dir_all(&directory);
        let _ = fs::create_dir_all(&directory);
        reporter.step_finished(title, true, "done");
    }
    reporter.step_started("Forget the launcher's setup");
    crate::setup::forget(paths);
    reporter.step_finished("Forget the launcher's setup", true, "it runs again at the next start");
    reporter.message(Level::Success, "Runtime state reset", "map cache, saved seeds and configuration kept");
    Ok(())
}
