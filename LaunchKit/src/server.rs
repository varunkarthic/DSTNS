// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Finding, starting, watching and stopping the DSTNS server process.

use crate::api;
use crate::config;
use crate::errors::{LauncherError, Result};
use crate::narration;
use crate::paths::Paths;
use crate::process::Cancel;
use crate::reporting::{Level, Quiet, Reporter};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const HEALTH_TIMEOUT: f64 = 15.0;

/// A server this launcher is using: one it started, or one it attached to.
pub struct ServerHandle {
    pub port: u16,
    pub health: Value,
    pub process: Option<Arc<Mutex<Child>>>,
    pub output: Arc<Mutex<VecDeque<String>>>,
}

impl ServerHandle {
    pub fn attached(port: u16) -> Self {
        Self { port, health: json!({}), process: None, output: Arc::default() }
    }
    pub fn managed(&self) -> bool {
        self.process.is_some()
    }
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }
    pub fn pid(&self) -> Option<u32> {
        self.process.as_ref().map(|p| p.lock().unwrap().id())
    }
    pub fn exit_code(&self) -> Option<i32> {
        let process = self.process.as_ref()?;
        let status = process.lock().unwrap().try_wait().ok()??;
        Some(status.code().unwrap_or(-1))
    }
    pub fn running(&self, paths: &Paths) -> bool {
        match &self.process {
            Some(process) => matches!(process.lock().unwrap().try_wait(), Ok(None)),
            None => api::health(self.port, paths).is_some(),
        }
    }
    pub fn tail(&self, lines: usize) -> String {
        let output = self.output.lock().unwrap();
        output.iter().skip(output.len().saturating_sub(lines)).cloned().collect::<Vec<_>>().join("\n")
    }
}

pub fn maps(paths: &Paths) -> PathBuf {
    let configured = config::load(paths).ok().and_then(|c| c.pointer("/map/cache_dir").and_then(|v| v.as_str()).map(String::from));
    paths.map_cache(configured.as_deref())
}

fn read_active(paths: &Paths) -> Option<u16> {
    let text = fs::read_to_string(paths.active_server()).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("port").and_then(|p| p.as_u64()).map(|p| p as u16)
}

fn write_active(paths: &Paths, port: u16) {
    let _ = fs::create_dir_all(paths.logs());
    let _ = fs::write(paths.active_server(), json!({"port": port, "observer_ui_version": "observer-v2"}).to_string());
}

/// The port to try first: DSTNS_API_PORT, else the last one used, else api.port.
pub fn configured_port(paths: &Paths) -> Result<u16> {
    let config = config::load(paths)?;
    if let Ok(raw) = std::env::var("DSTNS_API_PORT") {
        if !raw.is_empty() {
            return raw
                .parse::<u16>()
                .ok()
                .filter(|p| *p >= 1)
                .ok_or_else(|| LauncherError::config("Invalid DSTNS_API_PORT").remedy("Set it to a port number between 1 and 65535."));
        }
    }
    if let Some(previous) = read_active(paths) {
        if api::is_current(api::health(previous, paths).as_ref()) {
            return Ok(previous);
        }
    }
    Ok(config.pointer("/api/port").and_then(|p| p.as_u64()).unwrap_or(8090) as u16)
}

/// The port of a current DSTNS server this launcher can reach, if any.
pub fn active_port(paths: &Paths) -> Option<u16> {
    let mut candidates = vec![];
    if let Some(previous) = read_active(paths) {
        candidates.push(previous);
    }
    if let Ok(port) = configured_port(paths) {
        candidates.push(port);
    }
    candidates.dedup();
    candidates.into_iter().find(|port| api::is_current(api::health(*port, paths).as_ref()))
}

/// What the launcher's settings tell a server as it starts.
pub fn switches(config: &Value, paths: &Paths, demo: bool) -> Vec<(String, String)> {
    let mut env = config::server_switches(config, demo);
    if config::flag(config, "startup.fast_boot") {
        env.push(("DSTNS_FASTBOOT_DIR".into(), paths.fastboot().to_string_lossy().into_owned()));
    }
    env
}

/// Attach to a healthy current server, or build and start one.
pub fn start(reporter: &dyn Reporter, paths: &Paths, build_first: bool, cancel: Option<&Cancel>, demo: bool) -> Result<ServerHandle> {
    start_with(reporter, paths, build_first, cancel, demo, config::load(paths)?)
}

/// As `start`, with these settings in force for a server it starts, without saving them.
pub fn start_with(reporter: &dyn Reporter, paths: &Paths, build_first: bool, cancel: Option<&Cancel>, demo: bool, config: Value) -> Result<ServerHandle> {
    let check = || cancel.map(|c| c.check()).unwrap_or(Ok(()));
    check()?;
    let mut port = configured_port(paths)?;
    let host = config.pointer("/api/host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1").to_string();
    let _ = fs::create_dir_all(paths.logs());
    if build_first {
        crate::buildplan::ensure_built(reporter, paths, false, cancel)?;
    }
    check()?;

    if api::port_open(port, &host) {
        let existing = api::health(port, paths);
        if api::is_current(existing.as_ref()) {
            write_active(paths, port);
            let lifecycle = existing.as_ref().and_then(|h| h.get("lifecycle")).and_then(|v| v.as_str()).unwrap_or("READY").to_string();
            reporter.message(Level::Info, "Attached to the running DSTNS server", &format!("port {port} · {lifecycle}"));
            // Its settings were decided when it started too. Say so if they are not what is set now.
            let features = api::get(port, "/api/v1/system/features", 3.0, paths).data().cloned().unwrap_or(Value::Null);
            let wanted = config::presentation(&config, demo);
            if !features.is_null() {
                if features.pointer("/presentation/demo") != Some(&wanted["demo"]) {
                    return Err(LauncherError::start("A server is already running, started for something else.").remedy("Stop it with ./launcher stop, then try again."));
                }
                let differs = features.get("applications").and_then(|v| v.as_bool()) != Some(config::flag(&config, "fabric.applications"))
                    || features.get("legacy_api").and_then(|v| v.as_bool()) != Some(config::flag(&config, "fabric.legacy_api"))
                    || features.pointer("/presentation/fast_boot") != Some(&wanted["fast_boot"]);
                if differs {
                    reporter.message(Level::Warning, "The running server was started with other settings", "They apply from its next start: ./launcher stop, then start again.");
                }
            }
            let (_, text) = narration::describe_server(narration::server_status(port, paths).as_ref());
            reporter.message(Level::Info, &format!("{} on the running server", narration::BRAND), &text);
            return Ok(ServerHandle { port, health: existing.unwrap_or(json!({})), process: None, output: Arc::default() });
        }
        let replacement = api::free_port(port + 1, &host).ok_or_else(|| LauncherError::start("No available network ports found"))?;
        reporter.message(
            Level::Warning,
            &format!("Port {port} is serving {}", if existing.is_some() { "an older DSTNS version" } else { "another service" }),
            &format!("using {replacement}"),
        );
        port = replacement;
    }

    // Advanced Security: what decides the run must be as the launcher left it.
    let changed = crate::security::tampered(paths);
    if !changed.is_empty() {
        return Err(LauncherError::start(format!("Changed outside the launcher: {}", changed.join(", "))).remedy("If you made these changes, accept them with ./launcher security accept, which asks first and records it."));
    }
    let choice = narration::resolve(None, paths);
    narration::announce(&choice, reporter);
    check()?;
    reporter.message(Level::Info, "Starting the DSTNS server", &format!("127.0.0.1:{port}"));
    let mut command = Command::new(paths.server());
    command
        .args(["--host", &host, "--port", &port.to_string(), "--logs", &paths.logs().to_string_lossy(), "--maps", &maps(paths).to_string_lossy(), "--narrator", &choice.server_argument])
        .current_dir(&paths.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(token) = &choice.token {
        command.env("DSTNS_NARRATOR_TOKEN", token);
    }
    for (key, value) in paths.server_environment().into_iter().chain(switches(&config, paths, demo)) {
        command.env(key, value);
    }
    crate::log::info(&format!("server start: {:?}", command));
    let mut child = command
        .spawn()
        .map_err(|_| LauncherError::start("The DSTNS server could not be started.").remedy("Build it with ./launcher test unit, or run cmake --build build."))?;
    let output: Arc<Mutex<VecDeque<String>>> = Arc::default();
    // Reading continuously keeps the server from blocking on a full pipe.
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)]
        .into_iter()
        .flatten()
    {
        let sink = output.clone();
        thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(|l| l.ok()) {
                let mut sink = sink.lock().unwrap();
                sink.push_back(line);
                if sink.len() > 500 {
                    sink.pop_front();
                }
            }
        });
    }
    let handle = ServerHandle { port, health: json!({}), process: Some(Arc::new(Mutex::new(child))), output };
    let deadline = Instant::now() + Duration::from_secs_f64(HEALTH_TIMEOUT);
    while Instant::now() < deadline {
        if let Err(error) = check() {
            stop_handle(&handle);
            return Err(error);
        }
        if let Some(code) = handle.exit_code() {
            return Err(LauncherError::start(format!("The server exited with status {code} before it was ready."))
                .remedy("See the server output below, or logs/system.log.")
                .detail(handle.tail(14)));
        }
        if let Some(health) = api::health(port, paths) {
            write_active(paths, port);
            let lifecycle = health.get("lifecycle").and_then(|v| v.as_str()).unwrap_or("READY").to_string();
            reporter.message(Level::Success, "The DSTNS server is healthy", &format!("port {port} · {lifecycle}"));
            return Ok(ServerHandle { health, ..handle });
        }
        thread::sleep(Duration::from_millis(250));
    }
    let tail = handle.tail(14);
    stop_handle(&handle);
    Err(LauncherError::start(format!("Server did not become healthy within {}s on port {port}.", config::fmt_g(HEALTH_TIMEOUT)))
        .remedy("Check that logs/ is writable, then try again; ./launcher reset clears stale runtime files.")
        .detail(tail))
}

/// --mode=server: build if needed, then run the server attached to this terminal.
pub fn run_foreground(paths: &Paths) -> Result<i32> {
    let config = config::load(paths)?;
    let mut port = configured_port(paths)?;
    let host = config.pointer("/api/host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1").to_string();
    let _ = fs::create_dir_all(paths.logs());
    crate::buildplan::ensure_built(&Quiet, paths, false, None)?;
    if api::port_open(port, &host) {
        if api::is_current(api::health(port, paths).as_ref()) {
            write_active(paths, port);
            println!("A DSTNS server is already running on port {port}.");
            return Ok(0);
        }
        port = api::free_port(port + 1, &host).unwrap_or(port + 1);
    }
    let choice = narration::resolve(None, paths);
    println!("{}", choice.summary());
    if choice.fell_back() && !choice.remedy.is_empty() {
        println!("  {}", choice.remedy);
    }
    let mut command = Command::new(paths.server());
    command
        .args(["--host", &host, "--port", &port.to_string(), "--logs", &paths.logs().to_string_lossy(), "--maps", &maps(paths).to_string_lossy(), "--narrator", &choice.server_argument])
        .current_dir(&paths.root);
    if let Some(token) = &choice.token {
        command.env("DSTNS_NARRATOR_TOKEN", token);
    }
    for (key, value) in paths.server_environment().into_iter().chain(switches(&config, paths, false)) {
        command.env(key, value);
    }
    let status = command.status().map_err(|e| LauncherError::start(format!("The DSTNS server could not be started: {e}")))?;
    Ok(status.code().unwrap_or(1))
}

/// SIGTERM, then SIGKILL if it has not exited within a moment and a half.
pub fn stop_handle(handle: &ServerHandle) {
    if let Some(process) = &handle.process {
        let mut child = process.lock().unwrap();
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Ask the server to terminate, wait, then escalate for a server this launcher started. Returns whether it stopped.
pub fn shut_down(handle: &ServerHandle, paths: &Paths) -> bool {
    let response = api::post(handle.port, "/api/v1/system/terminate", &json!({}), 5.0, paths);
    crate::log::info(&format!("terminate requested on port {}: HTTP {}", handle.port, response.code));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !handle.running(paths) {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    if handle.managed() {
        stop_handle(handle);
        return handle.exit_code().is_some();
    }
    !handle.running(paths)
}
