// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Building the simulation core and the observer, only when their sources changed.

use crate::artifacts::{needs_build, BuildState};
use crate::errors::{Kind, LauncherError, Result};
use crate::paths::Paths;
use crate::process::{Cancel, Run};
use crate::reporting::{duration, Level, Reporter};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const NATIVE_INPUTS: &[&str] = &["CMakeLists.txt", "Core", "Fabric"];
pub const UI_INPUTS: &[&str] = &[
    "WebKit/src",
    "WebKit/public",
    "WebKit/package.json",
    "WebKit/package-lock.json",
    "WebKit/index.html",
    "WebKit/vite.config.ts",
    "WebKit/tsconfig.json",
];
/// Not copied into the observer's local mirror.
const MIRROR_SKIP: &[&str] = &["node_modules", "dist", "test-results", "playwright-report", "tsconfig.tsbuildinfo", ".DS_Store"];

pub enum Action {
    Command(Vec<String>),
    Mirror,
}

pub struct Step {
    pub title: String,
    pub action: Action,
    /// Written once the step succeeds: (stamp file, fingerprint).
    pub stamp: Option<(PathBuf, String)>,
    /// The observer: if it cannot be built, the core still starts.
    pub observer: bool,
}

pub struct BuildPlan {
    pub steps: Vec<Step>,
}

impl BuildPlan {
    pub fn needed(&self) -> bool {
        !self.steps.is_empty()
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if MIRROR_SKIP.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Copy the observer's sources, and the configuration it reads, to its local build directory. Only for a synced
/// checkout. node_modules and dist are kept between builds; everything else is replaced.
pub fn mirror_observer(paths: &Paths) -> std::io::Result<()> {
    let target = paths.observer_build();
    fs::create_dir_all(&target)?;
    for entry in fs::read_dir(&target)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == "node_modules" || name == "dist" {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    copy_tree(&paths.ui_engine(), &target)?;
    copy_tree(&paths.root.join("config"), &target.parent().unwrap().join("config"))
}

pub fn plan(paths: &Paths, force_native: bool, force_ui: bool) -> BuildPlan {
    let native_stamp = paths.build().join(".launcher-source");
    let ui_stamp = paths.ui_dist().join(".launcher-source");
    let native: Option<BuildState> = paths.root.join("Core").exists().then(|| needs_build(&paths.root, NATIVE_INPUTS, &paths.server(), &native_stamp));
    let observer: Option<BuildState> =
        paths.ui_engine().join("src").exists().then(|| needs_build(&paths.root, UI_INPUTS, &paths.ui_dist().join("index.html"), &ui_stamp));
    let need_native = force_native || !paths.server().exists() || native.as_ref().map(|n| n.needed).unwrap_or(false);
    let need_ui = force_ui || !paths.ui_dist().join("index.html").exists() || observer.as_ref().map(|o| o.needed).unwrap_or(false);
    let need_install = need_ui && !paths.observer_build().join("node_modules").exists();
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let mut steps = vec![];
    if need_native {
        steps.push(Step {
            title: "Configure the build".into(),
            action: Action::Command(vec!["cmake".into(), "-S".into(), s(&paths.root), "-B".into(), s(&paths.build()), "-DDSTNS_BUILD_TESTS=ON".into(), "-DCMAKE_BUILD_TYPE=Release".into()]),
            stamp: None,
            observer: false,
        });
        steps.push(Step {
            title: "Compile the simulation core".into(),
            action: Action::Command(vec!["cmake".into(), "--build".into(), s(&paths.build()), "-j4".into()]),
            stamp: native.map(|n| (native_stamp, n.fingerprint)),
            observer: false,
        });
    }
    if need_ui && paths.observer_build() != paths.ui_engine() {
        steps.push(Step { title: "Copy the observer sources to local disk".into(), action: Action::Mirror, stamp: None, observer: true });
    }
    if need_install {
        steps.push(Step {
            title: "Install observer dependencies".into(),
            action: Action::Command(vec!["npm".into(), "ci".into(), "--prefix".into(), s(&paths.observer_build())]),
            stamp: None,
            observer: true,
        });
    }
    if need_ui {
        steps.push(Step {
            title: "Build the observer".into(),
            action: Action::Command(vec!["npm".into(), "run".into(), "build".into(), "--prefix".into(), s(&paths.observer_build())]),
            stamp: observer.map(|o| (ui_stamp, o.fingerprint)),
            observer: true,
        });
    }
    BuildPlan { steps }
}

/// Run each step; the first failure is returned.
pub fn execute(steps: &[&Step], reporter: &dyn Reporter, paths: &Paths, cancel: Option<&Cancel>) -> Result<()> {
    for step in steps {
        if let Some(cancel) = cancel {
            cancel.check()?;
        }
        reporter.step_started(&step.title);
        let started = Instant::now();
        let outcome = match &step.action {
            Action::Mirror => mirror_observer(paths).map_err(LauncherError::from),
            Action::Command(command) => {
                let mut run = Run::new(command.clone()).cwd(&paths.root);
                if let Some(cancel) = cancel {
                    run = run.cancel(cancel);
                }
                run.run(|line| reporter.step_output(&step.title, line)).map(|_| ())
            }
        };
        if let Err(error) = outcome {
            reporter.step_finished(&step.title, false, &error.message);
            return Err(error);
        }
        if let Some(cancel) = cancel {
            cancel.check()?;
        }
        if let Some((stamp, fingerprint)) = &step.stamp {
            if let Some(parent) = stamp.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(stamp, fingerprint);
        }
        reporter.step_finished(&step.title, true, &duration(started.elapsed().as_secs_f64()));
    }
    Ok(())
}

/// Build whatever is out of date. Returns whether anything was built.
pub fn ensure_built(reporter: &dyn Reporter, paths: &Paths, force_ui: bool, cancel: Option<&Cancel>) -> Result<bool> {
    let built = plan(paths, false, force_ui);
    if !built.needed() {
        return Ok(false);
    }
    let core: Vec<&Step> = built.steps.iter().filter(|s| !s.observer).collect();
    let observer: Vec<&Step> = built.steps.iter().filter(|s| s.observer).collect();
    execute(&core, reporter, paths, cancel)?;
    // The launcher built this server itself, so it is what is sealed.
    if !core.is_empty() {
        crate::security::seal(paths);
    }
    if !observer.is_empty() {
        if let Err(error) = execute(&observer, reporter, paths, cancel) {
            if error.is_cancelled() {
                return Err(error);
            }
            // The simulation does not need the observer to run; say what failed and serve whatever bundle is there.
            let have = paths.ui_dist().join("index.html").exists();
            reporter.message(
                Level::Warning,
                &format!("The observer could not be built; {}", if have { "serving the previous build" } else { "the simulation runs without it" }),
                &observer_remedy(&error),
            );
        }
    }
    Ok(true)
}

/// Why an observer build failed, in one line, with what to do about it.
pub fn observer_remedy(error: &LauncherError) -> String {
    let output = if error.detail.is_empty() { error.message.clone() } else { error.detail.clone() };
    if output.contains("Library not loaded") || output.contains("dyld") {
        return "Node.js is installed but does not start (a library it was built against is missing). Reinstall it - with Homebrew: brew reinstall node - then run ./launcher ui build.".into();
    }
    let certificate = ["UNABLE_TO_VERIFY", "unable to verify the first certificate", "SELF_SIGNED_CERT", "self-signed certificate", "CERT_HAS_EXPIRED", "unable to get local issuer certificate"];
    if certificate.iter().any(|m| output.contains(m)) {
        return "npm could not download packages: the connection to the registry presented a certificate this Mac does not trust, which usually means a network firewall or proxy is inspecting HTTPS. Ask your IT team for its root certificate and set NODE_EXTRA_CA_CERTS to it, or build on another network, then run ./launcher ui build.".into();
    }
    let first = output.lines().next().unwrap_or("");
    if matches!(error.kind, Kind::Dependency) || first.contains("not found") || error.kind == Kind::CommandFailed(127) {
        return "Node.js 20 or later is needed to build the observer. Install it, then run ./launcher ui build.".into();
    }
    let last = output.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or(&error.message).to_string();
    format!("{}. Fix it, then run ./launcher ui build.", last.chars().take(200).collect::<String>())
}
