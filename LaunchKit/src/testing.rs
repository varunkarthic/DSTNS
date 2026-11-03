// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The test stages `./launcher test [scope]` runs.

use crate::paths::Paths;
use crate::process::{tail_text, Run};
use crate::reporting::{duration, Reporter};

pub struct Stage {
    pub title: &'static str,
    pub command: Vec<String>,
}

pub struct StageResult {
    pub title: String,
    pub passed: bool,
    pub seconds: f64,
    pub detail: String,
}

pub const SCOPES: &[&str] = &["all", "unit", "api", "replay", "benchmark", "sumo", "ui", "launcher"];

pub fn stages(scope: &str, paths: &Paths) -> Vec<Stage> {
    let s = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
    let build = s(paths.build());
    let ui = s(paths.observer_build());
    let stage = |title: &'static str, command: &[&str]| Stage { title, command: command.iter().map(|c| c.to_string()).collect() };
    let configure = stage("Configure the test build", &["cmake", "-S", &s(paths.root.clone()), "-B", &build, "-DDSTNS_BUILD_TESTS=ON"]);
    let compile = stage("Build the core and test binaries", &["cmake", "--build", &build, "-j4"]);
    let unit = stage("Native suites (unit, property, replay, performance, HTTP)", &["ctest", "--test-dir", &build, "--output-on-failure"]);
    let replay = stage("Reproducibility verification", &[&s(paths.build().join("dstns_replay_verify"))]);
    let benchmark = stage("Load benchmark (quick)", &[&s(paths.build().join("dstns_benchmark")), "--quick"]);
    let api = stage("HTTP contract suite", &["python3", &s(paths.root.join("tests/api/api_smoke.py")), "--server", &s(paths.server())]);
    let sumo = stage("SUMO integration smoke test", &["bash", &s(paths.root.join("tests/integration/sumo_smoke.sh"))]);
    let launcher = stage("Launcher tests", &["cargo", "test", "--release", "--manifest-path", &s(paths.root.join("LaunchKit/Cargo.toml"))]);
    let observer = stage("Observer test suites", &["npm", "test", "--prefix", &ui]);
    let bundle = stage("Production observer bundle", &["npm", "run", "build", "--prefix", &ui]);
    let mut ui_stages = vec![];
    if paths.observer_build() != paths.ui_engine() {
        // A synced checkout builds and tests the observer from a local mirror.
        ui_stages.push(stage("Install observer dependencies", &["npm", "ci", "--prefix", &ui]));
    }
    ui_stages.push(observer);
    match scope {
        "unit" => vec![unit],
        "api" => vec![api],
        "replay" => vec![replay],
        "benchmark" => vec![benchmark],
        "sumo" => vec![sumo],
        "launcher" => vec![launcher],
        "ui" => ui_stages,
        _ => {
            let mut all = vec![configure, compile, unit, replay, benchmark, api, sumo, launcher];
            all.extend(ui_stages);
            all.push(bundle);
            all
        }
    }
}

/// Run every stage of `scope`; a failing stage does not stop the others.
pub fn run(scope: &str, reporter: &dyn Reporter, paths: &Paths) -> Vec<StageResult> {
    if paths.observer_build() != paths.ui_engine() && (scope == "all" || scope == "ui") {
        let _ = crate::buildplan::mirror_observer(paths);
    }
    let mut results = vec![];
    for stage in stages(scope, paths) {
        reporter.step_started(stage.title);
        let (passed, detail, seconds) = match Run::new(stage.command).cwd(&paths.root).unchecked().run(|line| reporter.step_output(stage.title, line)) {
            Ok(out) => (out.code == 0, if out.code == 0 { String::new() } else { tail_text(&out.output, 10) }, out.seconds),
            Err(error) => (false, error.message, 0.0),
        };
        let summary = if passed { duration(seconds) } else { detail.lines().last().unwrap_or("failed").chars().take(140).collect() };
        reporter.step_finished(stage.title, passed, &summary);
        results.push(StageResult { title: stage.title.into(), passed, seconds, detail });
    }
    results
}
