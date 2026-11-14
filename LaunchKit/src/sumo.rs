// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Eclipse SUMO: detection and the standalone toolchain check.

use crate::errors::{LauncherError, Result};
use crate::paths::Paths;
use crate::process::{capture, which, Run};
use crate::reporting::{duration, Level, Reporter};
use regex::Regex;
use std::fs;
use std::path::PathBuf;

pub struct Sumo {
    pub sumo: PathBuf,
    pub netconvert: PathBuf,
    pub works: bool,
    pub version: String,
}

/// Find sumo and netconvert the way the server does, and check they start.
pub fn detect() -> Option<Sumo> {
    let mut directories = vec![];
    if let Ok(home) = std::env::var("SUMO_HOME") {
        directories.push(PathBuf::from(home).join("bin"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        directories.push(PathBuf::from(home).join("sumo").join("bin"));
    }
    directories.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    let pair = directories
        .iter()
        .find(|d| d.join("sumo").exists() && d.join("netconvert").exists())
        .map(|d| (d.join("sumo"), d.join("netconvert")))
        .or_else(|| Some((which("sumo")?, which("netconvert")?)))?;
    let mut works = true;
    let mut version = String::new();
    for binary in [&pair.0, &pair.1] {
        let (code, out, _) = capture(&[&binary.to_string_lossy(), "--version"], None, 15.0, &[]);
        works &= code == 0;
        if binary == &pair.0 {
            version = Regex::new(r"Version\s+(\S+)").unwrap().captures(&out).map(|c| c[1].to_string()).unwrap_or_default();
        }
    }
    Some(Sumo { sumo: pair.0, netconvert: pair.1, works, version })
}

/// Whether sumo.enabled is on; sumo.home, when set, becomes SUMO_HOME for this process, as for the server.
pub fn configure(paths: &Paths) -> bool {
    let Ok(config) = crate::config::load(paths) else { return false };
    if let Some(home) = crate::config::sumo_home(&config) {
        std::env::set_var("SUMO_HOME", home);
    }
    crate::config::flag(&config, "sumo.enabled")
}

/// Export a synthetic grid, convert it and run SUMO on it: a toolchain check.
pub fn run_standalone(reporter: &dyn Reporter, paths: &Paths) -> Result<Vec<(String, String)>> {
    if !configure(paths) {
        return Err(LauncherError::config("SUMO is disabled.").remedy("Enable it with ./launcher config set sumo.enabled true, or under Settings, Simulation, SUMO."));
    }
    let found = detect().ok_or_else(|| {
        LauncherError::dependency("SUMO binaries (sumo, netconvert) were not found on PATH or under $SUMO_HOME").remedy("Install Eclipse SUMO, or set SUMO_HOME to its installation.")
    })?;
    if !paths.export_tool().exists() {
        crate::buildplan::ensure_built(reporter, paths, false, None)?;
    }
    let directory = paths.root.join("data").join("sumo_live_run");
    fs::create_dir_all(&directory)?;
    let tripinfo = directory.join("tripinfo.xml");
    let _ = fs::remove_file(&tripinfo);
    let d = |name: &str| directory.join(name).to_string_lossy().into_owned();
    let steps: Vec<(&str, Vec<String>)> = vec![
        ("Export a deterministic scenario", vec![paths.export_tool().to_string_lossy().into(), "--export-sumo".into(), d(""), "--grid".into(), "12x12".into()]),
        (
            "Compile the SUMO network",
            vec![
                found.netconvert.to_string_lossy().into(),
                format!("--node-files={}", d("network.nod.xml")),
                format!("--edge-files={}", d("network.edg.xml")),
                format!("--output-file={}", d("network.net.xml")),
                "--no-warnings=true".into(),
            ],
        ),
        (
            "Run the microscopic simulation",
            vec![
                found.sumo.to_string_lossy().into(),
                "-c".into(),
                d("sandbox.sumocfg"),
                "--begin".into(),
                "0".into(),
                "--end".into(),
                "3600".into(),
                "--seed".into(),
                "42".into(),
                format!("--tripinfo-output={}", tripinfo.display()),
                "--no-step-log=true".into(),
                "--duration-log.disable=true".into(),
            ],
        ),
    ];
    for (title, command) in steps {
        reporter.step_started(title);
        match Run::new(command).cwd(&directory).run(|line| reporter.step_output(title, line)) {
            Ok(out) => reporter.step_finished(title, true, &duration(out.seconds)),
            Err(error) => {
                reporter.step_finished(title, false, &error.message);
                return Err(error);
            }
        }
    }
    let mut summary = vec![("Output directory".to_string(), paths.relative(&directory))];
    if let Ok(text) = fs::read_to_string(&tripinfo) {
        let trips = text.lines().filter(|l| l.contains("<tripinfo")).count();
        summary.push(("Trip file".into(), paths.relative(&tripinfo)));
        summary.push(("Trips completed".into(), trips.to_string()));
        reporter.message(Level::Success, "SUMO toolchain works", &format!("{trips} trips"));
    }
    Ok(summary)
}
