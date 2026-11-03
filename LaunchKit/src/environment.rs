// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Environment checks: can this machine run DSTNS right now?
//!
//! Every check is a real test of this installation, and reports what it found, not just pass or fail. A failure means
//! a run cannot work; a warning means something is reduced or will be fixed automatically on start. The test-suite
//! checks are optional because they take a while.

use crate::paths::{cloud_synced, dataless, Paths};
use crate::process::{capture, which};
use crate::{buildplan, config, narration, sumo};
use regex::Regex;
use serde_json::Value;
use std::fs;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Pending,
    Running,
    Pass,
    Warning,
    Fail,
    Skipped,
}

impl State {
    /// (unicode symbol, ascii symbol, word): never colour alone.
    pub fn marker(self) -> (&'static str, &'static str, &'static str) {
        match self {
            State::Pending => ("○", "o", "Pending"),
            State::Running => ("◌", "~", "Checking"),
            State::Pass => ("✓", "+", "OK"),
            State::Warning => ("!", "!", "Warning"),
            State::Fail => ("✗", "x", "Failed"),
            State::Skipped => ("-", "-", "Skipped"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Outcome {
    pub state: State,
    pub value: String,
    pub detail: String,
    pub remedy: String,
}

impl Outcome {
    pub fn new(state: State, value: impl Into<String>) -> Self {
        Self { state, value: value.into(), detail: String::new(), remedy: String::new() }
    }
    fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }
    fn remedy(mut self, remedy: impl Into<String>) -> Self {
        self.remedy = remedy.into();
        self
    }
}

pub type CheckFn = fn(&Paths) -> Outcome;

#[derive(Clone)]
pub struct Check {
    pub key: &'static str,
    pub name: &'static str,
    pub run: CheckFn,
    pub required: bool,
    pub slow: bool,
    pub outcome: Outcome,
    pub seconds: f64,
}

impl Check {
    fn new(key: &'static str, name: &'static str, run: CheckFn) -> Self {
        Self { key, name, run, required: true, slow: false, outcome: Outcome::new(State::Pending, ""), seconds: 0.0 }
    }
    fn optional(mut self) -> Self {
        self.required = false;
        self
    }
    fn slow(mut self) -> Self {
        self.slow = true;
        self
    }
}

fn host(_paths: &Paths) -> Outcome {
    let supported = cfg!(any(target_os = "macos", target_os = "linux"));
    let (_, release, _) = capture(&["uname", "-r"], None, 5.0, &[]);
    let cores = thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let memory = unsafe {
        let pages = libc::sysconf(libc::_SC_PHYS_PAGES);
        let size = libc::sysconf(libc::_SC_PAGESIZE);
        if pages > 0 && size > 0 {
            format!(" · {:.1} GB", pages as f64 * size as f64 / 1024f64.powi(3))
        } else {
            String::new()
        }
    };
    let system = if cfg!(target_os = "macos") { "Darwin" } else { "Linux" };
    let value = format!("{system} {} · {} · {cores} cores{memory}", release.trim(), std::env::consts::ARCH);
    let outcome = Outcome::new(if supported { State::Pass } else { State::Warning }, value);
    if supported {
        outcome
    } else {
        outcome.remedy("Only macOS and Linux are supported; use WSL 2 or Docker on Windows.")
    }
}

fn rust(_paths: &Paths) -> Outcome {
    let (code, out, _) = capture(&["rustc", "--version"], None, 10.0, &[]);
    if code != 0 {
        return Outcome::new(State::Pass, format!("launcher built, rustc not on PATH")).detail("Rust is needed only to rebuild the launcher after a change.");
    }
    Outcome::new(State::Pass, out.trim().to_string())
}

fn node(_paths: &Paths) -> Outcome {
    let (code, out, _) = capture(&["node", "--version"], None, 10.0, &[]);
    if code == 127 {
        return Outcome::new(State::Warning, "not found").detail("Needed only to build the observer.").remedy("Install Node.js 20 or later if the observer must be rebuilt.");
    }
    if code != 0 {
        let broken = out.contains("Library not loaded");
        return Outcome::new(State::Warning, "installed but does not start").detail(out.lines().next().unwrap_or("").chars().take(200).collect::<String>()).remedy(if broken {
            "A library Node.js was built against is missing; reinstall it (with Homebrew: brew reinstall node)."
        } else {
            "Reinstall Node.js 20 or later."
        });
    }
    let major: u32 = Regex::new(r"v(\d+)").unwrap().captures(&out).and_then(|c| c[1].parse().ok()).unwrap_or(0);
    let outcome = Outcome::new(if major >= 20 { State::Pass } else { State::Warning }, out.trim().to_string());
    if major >= 20 {
        outcome
    } else {
        outcome.remedy("Node.js 20 or later is needed to build the observer.")
    }
}

fn toolchain(paths: &Paths) -> Outcome {
    let missing: Vec<&str> = ["cmake", "c++"].into_iter().filter(|t| which(t).is_none()).collect();
    let value = if missing.is_empty() { "cmake and a C++ compiler".to_string() } else { format!("{} missing", missing.join(", ")) };
    if paths.server().exists() {
        let outcome = Outcome::new(if missing.is_empty() { State::Pass } else { State::Warning }, value);
        return if missing.is_empty() { outcome } else { outcome.remedy("Needed only to rebuild the core after a change.") };
    }
    if missing.is_empty() {
        Outcome::new(State::Pass, value)
    } else {
        Outcome::new(State::Fail, value).remedy("Install CMake 3.22+ and a C++20 compiler; see the installation guide.")
    }
}

fn licence(paths: &Paths) -> Outcome {
    match fs::read_to_string(paths.root.join("LICENSE")) {
        Err(_) => Outcome::new(State::Warning, "LICENSE is missing").remedy("DSTNS is distributed under AGPL-3.0-or-later; the licence text should ship with it."),
        Ok(text) if text.contains("GNU AFFERO GENERAL PUBLIC LICENSE") => Outcome::new(State::Pass, "AGPL-3.0-or-later"),
        Ok(_) => Outcome::new(State::Warning, "not the AGPL text"),
    }
}

fn run_configuration(paths: &Paths) -> Outcome {
    let mut problems = vec![];
    if let Err(error) = config::load(paths) {
        problems.push(error.message);
    }
    match fs::read_to_string(paths.ui_config()) {
        Err(_) => problems.push("config/ui-config.json is missing".into()),
        Ok(text) => {
            if let Err(error) = serde_json::from_str::<Value>(&text) {
                problems.push(format!("config/ui-config.json: {error}"));
            }
        }
    }
    if problems.is_empty() {
        Outcome::new(State::Pass, "defaults.json and ui-config.json valid")
    } else {
        Outcome::new(State::Fail, "invalid").detail(problems.join("; ")).remedy("Correct the file, or restore it with git checkout -- config/")
    }
}

fn interface_configuration(paths: &Paths) -> Outcome {
    let Some(config) = fs::read_to_string(paths.ui_config()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return Outcome::new(State::Warning, "unreadable; built-in defaults apply");
    };
    let mut problems: Vec<String> = vec![];
    let mut one_of = |value: Option<&Value>, allowed: &[Value], name: &str| {
        if let Some(value) = value.filter(|v| !v.is_null()) {
            if !allowed.contains(value) {
                problems.push(format!("{name} \"{}\"", value.as_str().map(String::from).unwrap_or_else(|| value.to_string())));
            }
        }
    };
    use serde_json::json;
    let strings = |items: &[&str]| items.iter().map(|s| json!(s)).collect::<Vec<_>>();
    one_of(config.get("reduce_motion"), &strings(&["auto", "on", "off"]), "reduce_motion");
    one_of(config.pointer("/auto_focus/mode"), &strings(&["disable", "enable", "enable-force"]), "auto_focus.mode");
    one_of(config.pointer("/auto_focus/strategy"), &strings(&["round-robin", "latest"]), "auto_focus.strategy");
    one_of(config.pointer("/playback/skip_seconds"), &[json!(60), json!(300), json!(900), json!(3600)], "playback.skip_seconds");
    one_of(config.pointer("/playback/step_seconds"), &[json!(1), json!(10), json!(60), json!(300)], "playback.step_seconds");
    one_of(config.pointer("/news/style"), &strings(&["realistic", "standard"]), "news.style");
    let categories = strings(&["weather", "flooding", "incident", "traffic", "demand", "signals", "system"]);
    for value in config.pointer("/notifications/dnd_categories").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        one_of(Some(&value), &categories, "notifications.dnd_categories");
    }
    for value in config.pointer("/notifications/dnd_severities").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        one_of(Some(&value), &strings(&["info", "warning", "alert"]), "notifications.dnd_severities");
    }
    let layers = ["roads", "signals", "labels", "place_names", "other_places", "traffic", "vehicles", "buildings", "weather", "flooding", "incidents", "events"];
    if let Some(map) = config.get("layers").and_then(|v| v.as_object()) {
        for (key, value) in map {
            if !value.is_boolean() {
                problems.push(format!("layers.{key} is not true or false"));
            }
            if !layers.contains(&key.as_str()) {
                problems.push(format!("layers.{key} is not a layer"));
            }
        }
    }
    if problems.is_empty() {
        Outcome::new(State::Pass, "all values recognised")
    } else {
        Outcome::new(State::Warning, format!("{} value(s) ignored", problems.len()))
            .detail(format!("ignored: {}", problems.join(", ")))
            .remedy("Correct these values in config/ui-config.json; the defaults apply meanwhile.")
    }
}

fn map_fetcher(paths: &Paths) -> Outcome {
    let server = paths.server();
    if !server.exists() {
        return Outcome::new(State::Warning, "not built yet").remedy("Starting a run builds the server, which downloads maps itself.");
    }
    let (code, out, _) = capture(&[&server.to_string_lossy(), "--fetch-osm", "--help"], None, 15.0, &[]);
    let outcome = Outcome::new(if code == 0 { State::Pass } else { State::Fail }, if code == 0 { "built in" } else { "does not answer" })
        .detail(out.trim().chars().take(200).collect::<String>());
    if code == 0 {
        outcome
    } else {
        outcome.remedy("Rebuild the server: ./launcher start rebuilds it.")
    }
}

fn map_cache(paths: &Paths) -> Outcome {
    let configured = config::load(paths).ok().and_then(|c| c.pointer("/map/cache_dir").and_then(|v| v.as_str()).map(String::from));
    let directory = paths.map_cache(configured.as_deref());
    let probe = directory.join(format!(".preflight-{}", std::process::id()));
    if let Err(error) = fs::create_dir_all(&directory).and_then(|_| fs::write(&probe, "x")).and_then(|_| fs::remove_file(&probe)) {
        return Outcome::new(State::Fail, "not writable").detail(error.to_string()).remedy(format!("Make {} writable by this user.", directory.display()));
    }
    let extracts: Vec<u64> = fs::read_dir(&directory)
        .map(|e| e.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".osm.xml")).filter_map(|e| e.metadata().ok()).map(|m| m.len()).collect())
        .unwrap_or_default();
    if extracts.is_empty() {
        return Outcome::new(State::Pass, "empty; extracts download on demand");
    }
    let size = extracts.iter().sum::<u64>() as f64 / 1024f64.powi(2);
    Outcome::new(State::Pass, format!("{} cached extract{} · {size:.0} MiB", extracts.len(), if extracts.len() == 1 { "" } else { "s" }))
}

fn workspace(paths: &Paths) -> Outcome {
    let logs = paths.logs();
    let probe = logs.join(format!(".preflight-{}", std::process::id()));
    if let Err(error) = fs::create_dir_all(&logs).and_then(|_| fs::write(&probe, "x")).and_then(|_| fs::remove_file(&probe)) {
        return Outcome::new(State::Fail, "not writable").detail(error.to_string()).remedy(format!("Make {} writable by this user.", logs.display()));
    }
    if cloud_synced(&logs) {
        let mut evicted: Vec<String> = fs::read_dir(&logs).map(|e| e.filter_map(|e| e.ok()).filter(|e| dataless(&e.path())).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        evicted.sort();
        if !evicted.is_empty() {
            return Outcome::new(State::Warning, format!("{} runtime file(s) only in the cloud", evicted.len()))
                .detail(format!("The sync client has evicted {}; the server waits on the network to open them and may time out.", evicted.iter().take(6).cloned().collect::<Vec<_>>().join(", ")))
                .remedy(format!("Mark {} \"Always keep on this device\", run ./launcher reset, or set DSTNS_LOGS_DIR to a local folder.", paths.root.display()));
        }
        return Outcome::new(State::Pass, "logs directory writable (in a synced folder)").detail(format!("The launcher's own log is kept at {}.", paths.launcher_log().display()));
    }
    Outcome::new(State::Pass, "logs directory writable")
}

fn core(paths: &Paths) -> Outcome {
    if !paths.server().exists() {
        return Outcome::new(State::Warning, "not built").remedy("It is compiled automatically before the first run.");
    }
    let (code, out, _) = capture(&[&paths.server().to_string_lossy(), "--version"], None, 10.0, &[]);
    let first = out.lines().next().unwrap_or("").trim().to_string();
    if code == 0 && !first.is_empty() {
        Outcome::new(State::Pass, first)
    } else {
        Outcome::new(State::Warning, "present, no version reported")
    }
}

fn observer(paths: &Paths) -> Outcome {
    let index = paths.ui_dist().join("index.html");
    if !index.exists() {
        return Outcome::new(State::Warning, "not built").remedy("It is built automatically before the first run.");
    }
    let stale = crate::artifacts::needs_build(&paths.root, buildplan::UI_INPUTS, &index, &paths.ui_dist().join(".launcher-source")).needed;
    if stale {
        Outcome::new(State::Warning, "older than its sources").remedy("It is rebuilt automatically before the next run.")
    } else {
        Outcome::new(State::Pass, "current")
    }
}

fn sumo_check(_paths: &Paths) -> Outcome {
    match sumo::detect() {
        None => Outcome::new(State::Skipped, "not installed").detail("Optional: only the SUMO adapter needs it."),
        Some(found) if found.works => Outcome::new(State::Pass, if found.version.is_empty() { "found".to_string() } else { found.version }),
        Some(found) => Outcome::new(State::Warning, if found.version.is_empty() { "found".to_string() } else { found.version })
            .detail("sumo or netconvert does not start")
            .remedy("Reinstall SUMO, or set SUMO_HOME; see Troubleshooting."),
    }
}

fn narration_check(paths: &Paths) -> Outcome {
    let choice = narration::resolve(None, paths);
    match choice.fm_status() {
        narration::AVAILABLE => Outcome::new(State::Pass, narration::AVAILABLE).detail(format!("{}: news written on this Mac by the on-device model.", narration::BRAND)),
        narration::UNAVAILABLE => Outcome::new(State::Warning, narration::UNAVAILABLE).detail(format!("{}. {} is used.", choice.reason, narration::DEFAULT_WORDING)).remedy(choice.remedy.clone()),
        _ => {
            let detail = if choice.enabled() {
                format!("{} via {}.", narration::BRAND, choice.label)
            } else if !choice.fell_back() {
                format!("Turned off; {} is used.", narration::DEFAULT_WORDING)
            } else {
                format!("{}. {} is used.", choice.reason, narration::DEFAULT_WORDING)
            };
            Outcome::new(State::Skipped, narration::DISABLED).detail(detail).remedy(if choice.fell_back() { choice.remedy.clone() } else { String::new() })
        }
    }
}

fn port(paths: &Paths) -> Outcome {
    let wanted: u16 = std::env::var("DSTNS_API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or_else(|| config::load(paths).ok().and_then(|c| c.pointer("/api/port").and_then(|v| v.as_u64()).map(|p| p as u16)))
        .unwrap_or(8090);
    if TcpListener::bind(("127.0.0.1", wanted)).is_ok() {
        Outcome::new(State::Pass, format!("{wanted} available"))
    } else {
        Outcome::new(State::Pass, format!("{wanted} in use")).detail("A running DSTNS server is reused; otherwise the next free port is chosen.")
    }
}

fn ctest(paths: &Paths) -> Outcome {
    if !paths.build().join("CTestTestfile.cmake").exists() {
        return Outcome::new(State::Skipped, "not configured").remedy("Run cmake -S . -B build -DDSTNS_BUILD_TESTS=ON to enable.");
    }
    let (code, out, seconds) = capture(&["ctest", "--test-dir", &paths.build().to_string_lossy(), "--output-on-failure"], Some(&paths.root), 300.0, &[]);
    let clean = Regex::new(r"(\d+)% tests passed out of (\d+)").unwrap().captures(&out).map(|c| c[2].to_string());
    let dirty = Regex::new(r"(\d+)% tests passed,\s*(\d+) tests failed out of (\d+)").unwrap().captures(&out).map(|c| c[2].to_string());
    if code == 0 && dirty.is_none() {
        let total = clean.unwrap_or_else(|| "all".into());
        return Outcome::new(State::Pass, format!("{total}/{total} suites passed in {seconds:.1}s"));
    }
    Outcome::new(State::Fail, format!("{} suite(s) failed", dirty.unwrap_or_else(|| "some".into())))
        .detail(out.chars().rev().take(1500).collect::<String>().chars().rev().collect::<String>())
        .remedy("The core is not behaving as specified; run ctest --test-dir build --output-on-failure.")
}

/// One of the HTTP test programs ctest builds, against this checkout's server.
fn http_test(paths: &Paths, name: &str, timeout: f64) -> Option<(i32, String, f64)> {
    let program = paths.build().join("http-tests").join(name);
    if !paths.server().exists() || !program.exists() {
        return None;
    }
    let server = paths.server().to_string_lossy().into_owned();
    Some(capture(&[&program.to_string_lossy()], Some(&paths.root), timeout, &[("DSTNS_SERVER", &server)]))
}

fn api_suite(paths: &Paths) -> Outcome {
    let Some((code, out, seconds)) = http_test(paths, "api", 180.0) else {
        return Outcome::new(State::Skipped, "tests not built");
    };
    let count = Regex::new(r"(\d+) requests checked").unwrap().captures(&out).map(|c| c[1].to_string()).unwrap_or_else(|| "all".into());
    if code == 0 {
        Outcome::new(State::Pass, format!("{count} requests checked in {seconds:.1}s"))
    } else {
        Outcome::new(State::Fail, "HTTP contract violated").detail(tail(&out)).remedy("Run build/http-tests/api for details.")
    }
}

fn loading_suite(paths: &Paths) -> Outcome {
    let Some((code, out, seconds)) = http_test(paths, "loading", 60.0) else {
        return Outcome::new(State::Skipped, "tests not built");
    };
    if code == 0 {
        Outcome::new(State::Pass, format!("start-up, polling, regeneration and cancellation passed in {seconds:.1}s"))
    } else {
        Outcome::new(State::Fail, "loading regression").detail(tail(&out)).remedy("Run build/http-tests/loading for details.")
    }
}

fn observer_suite(paths: &Paths) -> Outcome {
    if !paths.observer_build().join("node_modules").exists() {
        return Outcome::new(State::Skipped, "dependencies not installed");
    }
    let (code, out, seconds) = capture(&["npx", "vitest", "run"], Some(&paths.observer_build()), 300.0, &[("CI", "1")]);
    if code == 0 {
        let count = Regex::new(r"Tests\s+(\d+)\s+passed").unwrap().captures(&out).map(|c| c[1].to_string()).unwrap_or_else(|| "all".into());
        return Outcome::new(State::Pass, format!("{count}/{count} tests passed in {seconds:.1}s"));
    }
    let failed = Regex::new(r"(\d+)\s+failed").unwrap().captures(&out).map(|c| c[1].to_string()).unwrap_or_else(|| "some".into());
    Outcome::new(State::Fail, format!("{failed} test(s) failed")).detail(tail(&out)).remedy("Run npm test --prefix WebKit for details.")
}

fn tail(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    chars[chars.len().saturating_sub(1500)..].iter().collect()
}

pub fn checks(suites: bool) -> Vec<Check> {
    let mut result = vec![
        Check::new("host", "Host platform", host),
        Check::new("rust", "Rust", rust).optional(),
        Check::new("toolchain", "Build tools", toolchain),
        Check::new("node", "Node.js", node).optional(),
        Check::new("licence", "Licence", licence).optional(),
        Check::new("configuration", "Configuration", run_configuration),
        Check::new("interface", "Observer settings", interface_configuration).optional(),
        Check::new("workspace", "Workspace", workspace),
        Check::new("fetcher", "Map downloader", map_fetcher),
        Check::new("cache", "Map cache", map_cache),
        Check::new("core", "Simulation core", core),
        Check::new("observer", "Observer bundle", observer).optional(),
        Check::new("port", "API port", port).optional(),
        Check::new("narration", "Apple Foundation Models", narration_check).optional(),
        Check::new("sumo", "SUMO", sumo_check).optional(),
    ];
    if suites {
        result.extend([
            Check::new("ctest", "Core test suites", ctest).slow(),
            Check::new("api", "API contract suite", api_suite).slow(),
            Check::new("loading", "Loading suite", loading_suite).slow(),
            Check::new("vitest", "Observer test suites", observer_suite).optional().slow(),
        ]);
    }
    result
}

/// Run every check, reporting each state change. Fast checks run four at a time; the test suites run one at a time,
/// because they compete for the machine.
pub fn run_checks(items: Vec<Check>, paths: &Paths, on_update: impl Fn(&[Check]) + Send + Sync + 'static) -> Vec<Check> {
    let shared = Arc::new(Mutex::new(items));
    let on_update = Arc::new(on_update);
    let execute = {
        let shared = shared.clone();
        let on_update = on_update.clone();
        let paths = paths.clone();
        move |index: usize| {
            let run = {
                let mut items = shared.lock().unwrap();
                items[index].outcome = Outcome::new(State::Running, "");
                on_update(&items);
                items[index].run
            };
            let started = Instant::now();
            let outcome = std::panic::catch_unwind(|| run(&paths)).unwrap_or_else(|_| Outcome::new(State::Fail, "check failed"));
            let mut items = shared.lock().unwrap();
            items[index].outcome = outcome;
            items[index].seconds = started.elapsed().as_secs_f64();
            on_update(&items);
        }
    };
    let count = shared.lock().unwrap().len();
    let quick: Vec<usize> = (0..count).filter(|i| !shared.lock().unwrap()[*i].slow).collect();
    let next = Arc::new(Mutex::new(0usize));
    let mut workers = vec![];
    for _ in 0..4 {
        let quick = quick.clone();
        let next = next.clone();
        let execute = execute.clone();
        workers.push(thread::spawn(move || loop {
            let position = {
                let mut n = next.lock().unwrap();
                let p = *n;
                *n += 1;
                p
            };
            if position >= quick.len() {
                break;
            }
            execute(quick[position]);
        }));
    }
    for worker in workers {
        let _ = worker.join();
    }
    for index in 0..count {
        if shared.lock().unwrap()[index].slow {
            execute(index);
        }
    }
    let items = shared.lock().unwrap().clone();
    items
}

/// Required checks that failed: the reasons a run cannot start.
pub fn blocking(items: &[Check]) -> Vec<&Check> {
    items.iter().filter(|c| c.required && c.outcome.state == State::Fail).collect()
}
