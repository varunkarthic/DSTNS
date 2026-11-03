// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Starting applications, waiting until they are ready, and looking after them.
//!
//! Each application runs in its own process group, with no shell: a command is one program and its arguments, so what
//! is in the catalogue is exactly what runs. Output goes to a log of its own. The operator's credential is not passed
//! on: an application proves who it is with its own token, and its one-time launch key.

use crate::apps::App;
use crate::errors::{Kind, LauncherError, Result};
use crate::fabric;
use crate::paths::{hex, Paths};
use crate::process::Cancel;
use crate::reporting::{Level, Reporter};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(200);
const STOP_SECONDS: f64 = 4.0;
/// Doubling from here between restarts, so that one that cannot start does not spin.
const RESTART_BACKOFF_S: f64 = 1.0;
const MAX_RESTARTS: u32 = 5;
/// A run this long has recovered, so its restarts stop counting against it.
const STABLE_AFTER_S: f64 = 60.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Waiting,
    Preparing,
    Starting,
    Ready,
    Failed,
    Stopped,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Waiting => "waiting",
            Phase::Preparing => "preparing",
            Phase::Starting => "starting",
            Phase::Ready => "ready",
            Phase::Failed => "failed",
            Phase::Stopped => "stopped",
        }
    }
    pub fn word(self) -> &'static str {
        match self {
            Phase::Waiting => "Waiting",
            Phase::Preparing => "Preparing",
            Phase::Starting => "Starting",
            Phase::Ready => "Running",
            Phase::Failed => "Failed",
            Phase::Stopped => "Stopped",
        }
    }
    pub fn active(self) -> bool {
        matches!(self, Phase::Ready | Phase::Starting | Phase::Preparing)
    }
}

/// One application this supervisor looks after, as it stands.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub app: App,
    pub phase: Phase,
    pub detail: String,
    pub log: PathBuf,
}

struct Slot {
    app: App,
    log: PathBuf,
    state: Mutex<(Phase, String, u32)>,
    child: Mutex<Option<Child>>,
    stop: Cancel,
    settled: Cancel,
    /// A person asked for it to start again: the next exit is that, not a failure.
    reloading: AtomicBool,
}

pub struct Supervisor {
    pub port: u16,
    reporter: Mutex<Arc<dyn Reporter>>,
    paths: Paths,
    cancel: Cancel,
    running: Mutex<BTreeMap<String, Arc<Slot>>>,
    publish_plan: AtomicBool,
    watching: AtomicBool,
    reloads_seen: AtomicI64,
}

/// One program and its arguments, with {url}, {port}, {id} and {root} filled in.
pub fn expand(command: &str, values: &BTreeMap<&str, String>) -> Vec<String> {
    let token = Regex::new(r"\{(url|port|id|root)\}").unwrap();
    shlex::split(command).unwrap_or_default().into_iter().map(|part| token.replace_all(&part, |c: &regex::Captures| values[&c[1]].clone()).into_owned()).collect()
}

pub fn tail(path: &std::path::Path, lines: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let kept: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    kept[kept.len().saturating_sub(lines)..].join(" / ")
}

fn kill(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let group = child.id() as i32;
    unsafe {
        libc::killpg(group, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs_f64(STOP_SECONDS);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    crate::log::warn(&format!("process group {group} did not stop; killing it"));
    unsafe {
        libc::killpg(group, libc::SIGKILL);
    }
    let _ = child.wait();
}

enum Wait {
    Ready,
    NotReady(String),
}

impl Supervisor {
    pub fn new(port: u16, reporter: Arc<dyn Reporter>, paths: &Paths, cancel: Cancel) -> Arc<Self> {
        Arc::new(Self {
            port,
            reporter: Mutex::new(reporter),
            paths: paths.clone(),
            cancel,
            running: Mutex::default(),
            publish_plan: AtomicBool::new(false),
            watching: AtomicBool::new(false),
            reloads_seen: AtomicI64::new(-1),
        })
    }

    pub fn set_reporter(&self, reporter: Arc<dyn Reporter>) {
        *self.reporter.lock().unwrap() = reporter;
    }

    fn say(&self, level: Level, text: &str, detail: &str) {
        let reporter = self.reporter.lock().unwrap().clone();
        reporter.message(level, text, detail);
    }

    pub fn states(&self) -> Vec<Snapshot> {
        self.running
            .lock()
            .unwrap()
            .values()
            .map(|slot| {
                let (phase, detail, _) = slot.state.lock().unwrap().clone();
                Snapshot { app: slot.app.clone(), phase, detail, log: slot.log.clone() }
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Snapshot> {
        self.states().into_iter().find(|s| s.app.id == id)
    }

    fn changed(&self) {
        if !self.publish_plan.load(Ordering::SeqCst) {
            return;
        }
        let apps: Vec<Value> = self
            .states()
            .into_iter()
            .map(|s| {
                let mut entry = json!({"id": s.app.id, "name": s.app.title(), "state": s.phase.name(), "detail": s.detail});
                if !s.app.web_url.is_empty() {
                    entry["web_url"] = json!(s.app.web_url);
                    entry["web_label"] = json!(if s.app.web_label.is_empty() { format!("Open {}", s.app.title()) } else { s.app.web_label.clone() });
                }
                entry
            })
            .collect();
        fabric::set_plan(self.port, Some(&json!({"apps": apps})), &self.paths);
    }

    fn set(&self, slot: &Slot, phase: Phase, detail: &str) {
        {
            let mut state = slot.state.lock().unwrap();
            state.0 = phase;
            state.1 = detail.to_string();
        }
        self.changed();
    }

    /// Start these, and return once all are ready. A required one that fails is an error.
    pub fn launch(self: &Arc<Self>, apps: &[App]) -> Result<()> {
        if apps.is_empty() {
            return Ok(());
        }
        self.publish_plan.store(true, Ordering::SeqCst);
        let outcome = (|| {
            for app in apps {
                self.start(app.clone());
            }
            loop {
                let settled = {
                    let running = self.running.lock().unwrap();
                    apps.iter().all(|a| running.get(&a.id).map(|s| s.settled.is_set()).unwrap_or(true))
                };
                if settled {
                    break;
                }
                if self.cancel.is_set() {
                    self.stop_all();
                    return Err(LauncherError::cancelled());
                }
                thread::sleep(POLL);
            }
            let failed: Vec<Snapshot> = apps.iter().filter_map(|a| self.get(&a.id)).filter(|s| s.phase != Phase::Ready).collect();
            for s in &failed {
                self.say(if s.app.required { Level::Error } else { Level::Warning }, &format!("{} did not start", s.app.title()), &s.detail);
            }
            if let Some(needed) = failed.iter().find(|s| s.app.required) {
                self.stop_all();
                return Err(LauncherError::new(Kind::AppStart, format!("{} is required, and did not start: {}", needed.app.title(), needed.detail))
                    .remedy(format!("Its log is at {}. Run ./launcher apps doctor {} to check it.", needed.log.display(), needed.app.id)));
            }
            Ok(())
        })();
        if outcome.is_err() {
            self.publish_plan.store(false, Ordering::SeqCst);
            fabric::set_plan(self.port, None, &self.paths);
        }
        // The plan stays while they run: it is how the server knows which applications the launcher looks after,
        // so that one a person reloads can come back as itself, and where each one's web interface is.
        outcome
    }

    /// Start one, in the background. Its thread looks after it from then on.
    pub fn start(self: &Arc<Self>, app: App) {
        self.publish_plan.store(true, Ordering::SeqCst);
        let slot = {
            let mut running = self.running.lock().unwrap();
            if let Some(current) = running.get(&app.id) {
                if current.child.lock().unwrap().as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false) {
                    return;
                }
            }
            let log_dir = self.paths.logs().join("apps");
            let _ = fs::create_dir_all(&log_dir);
            let slot = Arc::new(Slot {
                log: log_dir.join(format!("{}.log", app.id)),
                app: app.clone(),
                state: Mutex::new((Phase::Waiting, String::new(), 0)),
                child: Mutex::new(None),
                stop: Cancel::new(),
                settled: Cancel::new(),
                reloading: AtomicBool::new(false),
            });
            running.insert(app.id.clone(), slot.clone());
            slot
        };
        let this = self.clone();
        thread::Builder::new().name(format!("app-{}", app.id)).spawn(move || this.look_after(&slot)).ok();
        if !self.watching.swap(true, Ordering::SeqCst) {
            let this = self.clone();
            thread::Builder::new().name("app-reloads".into()).spawn(move || this.watch_reloads()).ok();
        }
    }

    /// A person reloads an application in the observer: its link ends, and this starts it again.
    fn watch_reloads(self: Arc<Self>) {
        while !self.cancel.wait(0.5) {
            let asked = fabric::reloads(self.port, &self.paths);
            let sequence = |item: &Value| item.get("sequence").and_then(|s| s.as_i64()).unwrap_or(0);
            if self.reloads_seen.load(Ordering::SeqCst) < 0 {
                self.reloads_seen.store(asked.iter().map(sequence).max().unwrap_or(0), Ordering::SeqCst);
                continue;
            }
            for item in &asked {
                if sequence(item) <= self.reloads_seen.load(Ordering::SeqCst) {
                    continue;
                }
                self.reloads_seen.store(sequence(item), Ordering::SeqCst);
                let id = item.get("app").and_then(|a| a.as_str()).unwrap_or("");
                let slot = self.running.lock().unwrap().get(id).cloned();
                if let Some(slot) = slot {
                    let mut child = slot.child.lock().unwrap();
                    if let Some(child) = child.as_mut() {
                        if matches!(child.try_wait(), Ok(None)) {
                            self.say(Level::Info, &format!("Reloading {}", slot.app.title()), "");
                            slot.reloading.store(true, Ordering::SeqCst);
                            kill(child);
                        }
                    }
                }
            }
            let states = self.states();
            if !states.is_empty() && states.iter().all(|s| matches!(s.phase, Phase::Stopped | Phase::Failed)) {
                self.watching.store(false, Ordering::SeqCst);
                return;
            }
        }
    }

    fn values(&self, app: &App) -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            ("url", format!("http://127.0.0.1:{}", self.port)),
            ("port", self.port.to_string()),
            ("id", app.id.clone()),
            ("root", self.paths.root.to_string_lossy().into_owned()),
        ])
    }

    fn spawn(&self, slot: &Slot, command: &str, launch_key: &str) -> std::io::Result<Child> {
        let app = &slot.app;
        let mut log = OpenOptions::new().create(true).append(true).open(&slot.log)?;
        writeln!(log, "\n--- {} {command}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))?;
        let parts = expand(command, &self.values(app));
        if parts.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "an empty command"));
        }
        let mut process = Command::new(&parts[0]);
        process.args(&parts[1..]).current_dir(self.paths.root.join(&app.cwd)).stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log).process_group(0);
        process.env_remove("DSTNS_OPERATOR_TOKEN").env_remove("DSTNS_FABRIC_LAUNCH_KEY");
        for (key, value) in &app.env {
            process.env(key, value);
        }
        let values = self.values(app);
        process.env("DSTNS_URL", &values["url"]).env("DSTNS_PORT", self.port.to_string()).env("DSTNS_APP_ID", &app.id).env("PYTHONUNBUFFERED", "1");
        if !launch_key.is_empty() {
            process.env("DSTNS_FABRIC_LAUNCH_KEY", launch_key);
        }
        process.spawn()
    }

    fn running_child(slot: &Slot) -> bool {
        slot.child.lock().unwrap().as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false)
    }

    fn exit_status(slot: &Slot) -> Option<i32> {
        slot.child.lock().unwrap().as_mut().and_then(|c| c.try_wait().ok().flatten()).map(|s| s.code().unwrap_or(-1))
    }

    fn kill_slot(slot: &Slot) {
        if let Some(child) = slot.child.lock().unwrap().as_mut() {
            kill(child);
        }
    }

    fn look_after(self: Arc<Self>, slot: &Arc<Slot>) {
        let outcome = (|| -> std::result::Result<(), String> {
            let (main, prepare) = slot.app.commands.split_last().ok_or("no commands")?;
            for command in prepare {
                self.set(slot, Phase::Preparing, command);
                let child = self.spawn(slot, command, "").map_err(|e| format!("It could not be started: {e}"))?;
                *slot.child.lock().unwrap() = Some(child);
                let deadline = Instant::now() + Duration::from_secs_f64(slot.app.timeout_s);
                while Self::running_child(slot) {
                    if slot.stop.is_set() || self.cancel.is_set() {
                        Self::kill_slot(slot);
                        self.set(slot, Phase::Stopped, "");
                        return Ok(());
                    }
                    if Instant::now() > deadline {
                        Self::kill_slot(slot);
                        return Err(format!("Preparing took over {:.0} s: {command}", slot.app.timeout_s));
                    }
                    thread::sleep(POLL);
                }
                let code = Self::exit_status(slot).unwrap_or(-1);
                if code != 0 {
                    return Err(format!("{command} failed with status {code}. {}", tail(&slot.log, 3)).trim().to_string());
                }
            }
            self.run_main(slot, main)
        })();
        if let Err(problem) = outcome {
            self.set(slot, Phase::Failed, &problem);
        }
        slot.settled.set();
    }

    fn run_main(&self, slot: &Arc<Slot>, command: &str) -> std::result::Result<(), String> {
        let app = &slot.app;
        while !slot.stop.is_set() && !self.cancel.is_set() {
            self.set(slot, Phase::Starting, &slot.state.lock().unwrap().1.clone());
            let began = Instant::now();
            // A key for this process alone, so that it can prove to the server to be this application.
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).map_err(|e| e.to_string())?;
            let launch_key = hex(&key);
            fabric::set_launch_key(self.port, &app.id, &hex(&Sha256::digest(launch_key.as_bytes())), &self.paths);
            let child = self.spawn(slot, command, &launch_key).map_err(|e| format!("It could not be started: {e}"))?;
            *slot.child.lock().unwrap() = Some(child);
            let problem = match self.wait_ready(slot) {
                Wait::Ready => {
                    self.set(slot, Phase::Ready, "");
                    self.say(Level::Success, &format!("{} ready", app.title()), "");
                    slot.settled.set();
                    while Self::running_child(slot) && !slot.stop.is_set() && !self.cancel.is_set() {
                        thread::sleep(POLL);
                    }
                    None
                }
                Wait::NotReady(why) => Some(why),
            };
            if slot.stop.is_set() || self.cancel.is_set() {
                Self::kill_slot(slot);
                self.set(slot, Phase::Stopped, "");
                return Ok(());
            }
            if slot.reloading.swap(false, Ordering::SeqCst) {
                Self::kill_slot(slot);
                self.set(slot, Phase::Starting, "Reloading.");
                continue;
            }
            let status = Self::exit_status(slot);
            if problem.is_none() && status == Some(0) {
                self.set(slot, Phase::Stopped, "It finished by itself.");
                return Ok(());
            }
            let why = problem.unwrap_or_else(|| format!("It stopped with status {}.", status.unwrap_or(-1)));
            Self::kill_slot(slot);
            if app.restart != "on-failure" {
                return Err(format!("{why} {}", tail(&slot.log, 3)).trim().to_string());
            }
            let restarts = {
                let mut state = slot.state.lock().unwrap();
                if began.elapsed().as_secs_f64() > STABLE_AFTER_S {
                    state.2 = 0;
                }
                state.2 += 1;
                state.2
            };
            if restarts > MAX_RESTARTS {
                return Err(format!("Restarted {MAX_RESTARTS} times without staying up. {why}"));
            }
            let wait = RESTART_BACKOFF_S * 2f64.powi(restarts as i32 - 1);
            self.set(slot, Phase::Starting, &format!("Restart {restarts} of {MAX_RESTARTS} in {wait:.0} s. {why}"));
            self.say(Level::Warning, &format!("{} is being restarted", app.title()), &why);
            if slot.stop.wait(wait) {
                self.set(slot, Phase::Stopped, "");
                return Ok(());
            }
        }
        self.set(slot, Phase::Stopped, "");
        Ok(())
    }

    fn wait_ready(&self, slot: &Arc<Slot>) -> Wait {
        let app = &slot.app;
        let began = Instant::now();
        let deadline = began + Duration::from_secs_f64(app.timeout_s);
        let mut configured = false;
        loop {
            if slot.stop.is_set() || self.cancel.is_set() {
                return Wait::NotReady("It was stopped.".into());
            }
            if let Some(status) = Self::exit_status(slot) {
                return Wait::NotReady(format!("It stopped with status {status} before it was ready. {}", tail(&slot.log, 3)).trim().to_string());
            }
            if app.ready == "process" {
                if began.elapsed().as_secs_f64() >= 1.0 {
                    return Wait::Ready;
                }
            } else if let Some(seconds) = app.ready.strip_prefix("delay:") {
                if began.elapsed().as_secs_f64() >= seconds.parse::<f64>().unwrap_or(0.0) {
                    return Wait::Ready;
                }
            } else if app.ready == "fabric" {
                if let Some(health) = fabric::health(self.port, &app.id, &self.paths) {
                    if !configured {
                        self.configure(app);
                        configured = true;
                    }
                    match health.get("state").and_then(|s| s.as_str()) {
                        Some("active") => return Wait::Ready,
                        Some("failed") => {
                            let detail = health.get("detail").and_then(|d| d.as_str()).unwrap_or("");
                            return Wait::NotReady(format!("It reported that it failed. {detail}").trim().to_string());
                        }
                        _ => {}
                    }
                }
            } else if let Ok(response) = crate::api::agent(Duration::from_secs(2)).get(&app.ready).call() {
                if response.status().as_u16() < 400 {
                    return Wait::Ready;
                }
            }
            if Instant::now() > deadline {
                if app.ready == "fabric" {
                    let known = fabric::health(self.port, &app.id, &self.paths).is_some();
                    return Wait::NotReady(if known {
                        format!("It registered but did not report itself active within {:.0} s.", app.timeout_s)
                    } else {
                        format!("It did not register as {} within {:.0} s. Is that the ID in its manifest?", app.id, app.timeout_s)
                    });
                }
                return Wait::NotReady(format!("It was not ready within {:.0} s.", app.timeout_s));
            }
            thread::sleep(POLL);
        }
    }

    /// What this person already decided for it: its permissions, and its starting settings.
    fn configure(&self, app: &App) {
        if !app.grants.is_empty() {
            let described = fabric::describe(self.port, &app.id, &self.paths).unwrap_or(Value::Null);
            let list = |key: &str| -> Vec<String> {
                described.pointer(&format!("/capabilities/{key}")).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
            };
            let requested = list("requested");
            let mut wanted: Vec<String> = list("granted");
            wanted.extend(app.grants.iter().filter(|g| requested.contains(g)).cloned());
            wanted.sort();
            wanted.dedup();
            let response = fabric::grant(self.port, &app.id, &wanted, &self.paths);
            if !response.ok() {
                self.say(Level::Warning, &format!("Could not give {} its permissions", app.title()), &response.error_message());
            }
        }
        if !app.settings.is_empty() {
            let response = fabric::update_settings(self.port, &app.id, &Value::Object(app.settings.clone()), &self.paths);
            if !response.ok() {
                self.say(Level::Warning, &format!("Could not set {}'s settings", app.title()), &response.error_message());
            }
        }
    }

    pub fn stop(&self, id: &str) {
        let slot = self.running.lock().unwrap().get(id).cloned();
        if let Some(slot) = slot {
            slot.stop.set();
            Self::kill_slot(&slot);
            // Its thread notices within a poll, and marks it stopped.
            let deadline = Instant::now() + Duration::from_secs(2);
            while !slot.settled.is_set() && Instant::now() < deadline && slot.state.lock().unwrap().0 != Phase::Stopped {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }

    pub fn stop_all(&self) {
        // First, so that an application's thread finishing late can't publish the plan again after it is cleared.
        let published = self.publish_plan.swap(false, Ordering::SeqCst);
        let ids: Vec<String> = self.running.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
        if published {
            fabric::set_plan(self.port, None, &self.paths);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_expanded_without_a_shell() {
        let values = BTreeMap::from([("url", "http://127.0.0.1:8090".to_string()), ("port", "8090".into()), ("id", "org.x".into()), ("root", "/r".into())]);
        assert_eq!(expand("python3 app.py --url {url} --name 'two words'", &values), vec!["python3", "app.py", "--url", "http://127.0.0.1:8090", "--name", "two words"]);
        assert_eq!(expand("echo $(whoami) {id}", &values), vec!["echo", "$(whoami)", "org.x"], "nothing is interpreted by a shell");
    }
}
