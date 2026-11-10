// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Starting a run on a server, following it, and controlling playback.
//!
//! Everything here goes through the HTTP API, exactly as any client would. The launcher observes and requests; it
//! never computes anything the engine owns, so interface timing cannot affect a run.

use crate::api;
use crate::config::{self, RunOptions};
use crate::errors::{LauncherError, Result};
use crate::paths::Paths;
use crate::process::{capture, which, Cancel};
use crate::reporting::{Level, Reporter};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const POLL_SECONDS: f64 = 0.18;
pub const PREPARE_LIMIT: f64 = 30.0 * 60.0;
/// Failed polls before a server is called gone: few for one attached to, whose process cannot be checked, and many
/// for one this launcher started and can see is still alive.
pub const GONE_POLL_LIMIT: u32 = 8;
pub const BUSY_POLL_LIMIT: u32 = 90;

/// What the server reports about the world it loaded.
#[derive(Clone, Debug, Default)]
pub struct World {
    pub seed: String,
    pub day: i64,
    pub city: String,
    pub country: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub downloaded: Option<bool>,
    pub nodes: usize,
    pub edges: usize,
    pub places: usize,
}

impl World {
    pub fn place(&self) -> String {
        if self.city.is_empty() {
            "Pinned map".into()
        } else {
            format!("{}, {}", self.city, self.country)
        }
    }
    pub fn day_name(&self) -> &'static str {
        if self.day == 1 {
            "weekend"
        } else {
            "weekday"
        }
    }
}

/// One reading of /api/v1/fabric/engine/status.
#[derive(Clone, Debug)]
pub struct Status {
    pub reachable: bool,
    pub lifecycle: String,
    pub run_id: String,
    pub seed: String,
    pub clock: String,
    pub virtual_seconds: f64,
    pub fraction: f64,
    pub tick_rate: Option<f64>,
    pub preparation_error: String,
    /// Ready, and waiting for an open observer to finish showing its start-up.
    pub observer_hold: bool,
}

impl Status {
    pub fn unreachable() -> Self {
        Self {
            reachable: false,
            lifecycle: "UNREACHABLE".into(),
            run_id: String::new(),
            seed: String::new(),
            clock: "00:00:00".into(),
            virtual_seconds: 0.0,
            fraction: 0.0,
            tick_rate: None,
            preparation_error: String::new(),
            observer_hold: false,
        }
    }
    pub fn active(&self) -> bool {
        ["RUNNING", "PAUSED", "SEEKING", "READY"].contains(&self.lifecycle.as_str())
    }
}

/// The start request, saving it first if --save-seed was given.
pub fn prepare_request(options: &RunOptions, paths: &Paths) -> Result<Value> {
    let request = config::start_request(options, paths)?;
    if let Some(name) = &options.save_seed {
        let saved = crate::seeds::operate("save", &json!({"id": name, "description": options.description.clone().unwrap_or_default(), "config": request}), paths)?;
        return Ok(saved["config"].clone());
    }
    Ok(request)
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub fn status(port: u16, paths: &Paths) -> Status {
    let response = api::get(port, "/api/v1/fabric/engine/status", 3.0, paths);
    if !response.ok() || !response.body.is_object() {
        return Status::unreachable();
    }
    let body = &response.body;
    let data = body.get("data").cloned().unwrap_or(json!({}));
    let clock = body.get("clock").cloned().unwrap_or(json!({}));
    let run_id = text(body.get("run_id"));
    Status {
        reachable: true,
        lifecycle: data.get("lifecycle").and_then(|v| v.as_str()).unwrap_or("UNKNOWN").to_string(),
        run_id: if run_id.is_empty() { text(data.get("run_id")) } else { run_id },
        seed: text(body.get("seed")),
        clock: clock.get("simulated_current_time").and_then(|v| v.as_str()).unwrap_or("00:00:00").to_string(),
        virtual_seconds: clock.get("virtual_day_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0),
        fraction: clock.get("simulation_percentage").and_then(|v| v.as_f64()).unwrap_or(0.0),
        tick_rate: clock.get("tick_rate").and_then(|v| v.as_f64()),
        preparation_error: text(data.get("preparation_error")),
        observer_hold: data.get("observer_hold").and_then(|v| v.as_bool()).unwrap_or(false),
    }
}

pub fn map_status(port: u16, paths: &Paths) -> Value {
    api::get(port, "/api/v1/system/map-status", 2.0, paths).data().cloned().unwrap_or(json!({}))
}

/// Read the topology and check that a real OpenStreetMap network loaded.
pub fn world(port: u16, seed: &str, day: i64, paths: &Paths) -> Result<World> {
    let response = api::get(port, "/api/v1/view/topology", 60.0, paths);
    let data = response.body.get("data").cloned().unwrap_or(Value::Null);
    let count = |key: &str| data.get(key).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    if response.code != 200 || data.get("source").and_then(|v| v.as_str()) != Some("OpenStreetMap") || count("nodes") == 0 || count("edges") == 0 {
        return Err(LauncherError::start("The server did not load a usable real OSM network.").remedy("Check the map file, or start again with another seed."));
    }
    let location = data.get("location").cloned().unwrap_or(json!({}));
    Ok(World {
        seed: if seed.is_empty() { text(response.body.get("seed")) } else { seed.to_string() },
        day,
        city: text(location.get("city")),
        country: text(location.get("country")),
        latitude: location.get("anchor_lat").and_then(|v| v.as_f64()),
        longitude: location.get("anchor_lon").and_then(|v| v.as_f64()),
        downloaded: location.get("downloaded").and_then(|v| v.as_bool()),
        nodes: count("nodes"),
        edges: count("edges"),
        places: count("features"),
    })
}

/// Maps already on disk, as --osm-file arguments.
pub fn cached_maps(paths: &Paths) -> Vec<String> {
    let directory = crate::server::maps(paths);
    let mut names: Vec<String> = fs::read_dir(&directory)
        .map(|e| e.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".osm.xml")).collect())
        .unwrap_or_default();
    names.sort();
    names.into_iter().map(|name| paths.relative(&directory.join(name))).collect()
}

/// What to do when a seed's city cannot be used. A map that arrived and is too small is not a network fault.
pub fn map_recovery(paths: &Paths, message: &str) -> String {
    if message.contains("large enough to simulate") {
        return "The map downloaded correctly, so the network is not at fault. Start again with a different seed.".into();
    }
    let mut lines = vec![
        "The seed could not be resolved to a district, and no other city is substituted for it.".to_string(),
        "Check the network, VPN or proxy, or set DSTNS_OVERPASS_ENDPOINTS to a reachable Overpass instance.".to_string(),
    ];
    let cached = cached_maps(paths);
    if let Some(first) = cached.first() {
        let more = if cached.len() > 4 { format!(", and {} more", cached.len() - 4) } else { String::new() };
        lines.push(format!("Already downloaded: {}{more}.", cached.iter().take(4).cloned().collect::<Vec<_>>().join(", ")));
        lines.push(format!("Run one of them offline with: ./launcher start --osm-file {first}"));
    }
    lines.join("\n")
}

/// Start a run and wait until the world is live, reporting real progress. With an observer open, a failed download is
/// not the end: its screen offers another city, so this keeps waiting until cancelled.
pub fn start_run(port: u16, request: &Value, reporter: &dyn Reporter, paths: &Paths, cancel: Option<&Cancel>, observer_can_retry: bool) -> Result<World> {
    if let Some(cancel) = cancel {
        cancel.check()?;
    }
    let osm = request.pointer("/map/osm_file").and_then(|v| v.as_str()).unwrap_or("auto").to_string();
    let on_demand = osm == "auto";
    if on_demand {
        reporter.message(Level::Info, "Resolving the seed to a city district", "downloading from OpenStreetMap if not already cached");
    } else {
        reporter.message(Level::Info, "Loading the OpenStreetMap district", &osm);
    }
    let response = api::post(port, "/api/v1/fabric/engine/start", request, 120.0, paths);
    if response.code != 202 {
        let message = if response.code == 0 { "The server could not be reached.".to_string() } else { response.error_message() };
        return Err(match response.error_code().as_str() {
            "MAP_FETCH_FAILED" => LauncherError::start(message.clone()).remedy(map_recovery(paths, &message)),
            "CLI_START_REQUIRED" => LauncherError::start(message).remedy("The operator credential in logs/operator.token does not match this server."),
            _ => LauncherError::start(format!("Startup failed: {message}")),
        });
    }
    let mut deadline = Instant::now() + Duration::from_secs_f64(PREPARE_LIMIT);
    let mut drew = false;
    let mut reported = String::new();
    let mut current;
    loop {
        if Instant::now() > deadline {
            if drew {
                reporter.progress_done();
            }
            return Err(LauncherError::start("The world was not ready within 30 minutes."));
        }
        if cancel.map(|c| c.is_set()).unwrap_or(false) {
            api::post(port, "/api/v1/fabric/engine/reset", &json!({}), 5.0, paths);
            if drew {
                reporter.progress_done();
            }
            return Err(LauncherError::start("Start-up was cancelled."));
        }
        current = status(port, paths);
        if ["RUNNING", "PAUSED", "READY"].contains(&current.lifecycle.as_str()) {
            break;
        }
        if current.lifecycle == "IDLE" && !current.preparation_error.is_empty() {
            if observer_can_retry && on_demand {
                if current.preparation_error != reported {
                    reported = current.preparation_error.clone();
                    reporter.message(Level::Warning, "The map could not be downloaded", &format!("{reported} Choose Try another city in the observer, or press Ctrl+C to stop."));
                }
                deadline = Instant::now() + Duration::from_secs_f64(PREPARE_LIMIT);
                thread::sleep(Duration::from_secs_f64(POLL_SECONDS));
                continue;
            }
            if drew {
                reporter.progress_done();
            }
            let remedy = if on_demand { map_recovery(paths, &current.preparation_error) } else { "Check the map file.".into() };
            return Err(LauncherError::start(current.preparation_error.clone()).remedy(remedy));
        }
        if on_demand {
            let progress = map_status(port, paths);
            if progress.get("active").and_then(|v| v.as_bool()).unwrap_or(false) {
                drew = true;
                let place = progress.get("city").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("map").to_string();
                if progress.get("phase").and_then(|v| v.as_str()) == Some("download") {
                    let total = progress.get("total").and_then(|v| v.as_f64()).filter(|t| *t > 0.0);
                    reporter.progress(&format!("Downloading {place}"), progress.get("bytes").and_then(|v| v.as_f64()).unwrap_or(0.0), total);
                } else {
                    let phase = if progress.get("phase").and_then(|v| v.as_str()) == Some("parse") { "Validating" } else { "Contacting OpenStreetMap for" };
                    reporter.progress(&format!("{phase} {place}"), 0.0, None);
                }
            }
        }
        thread::sleep(Duration::from_secs_f64(POLL_SECONDS));
    }
    if drew {
        reporter.progress_done();
    }
    // The observer may have tried another city, which means another seed.
    let seed = if !reported.is_empty() && !current.seed.is_empty() { current.seed.clone() } else { text(request.get("seed")) };
    let loaded = world(port, &seed, request.get("day").and_then(|v| v.as_i64()).unwrap_or(0), paths)?;
    if !loaded.city.is_empty() {
        reporter.message(
            Level::Info,
            "District",
            &format!(
                "{} · {:.4}, {:.4}{}",
                loaded.place(),
                loaded.latitude.unwrap_or(0.0),
                loaded.longitude.unwrap_or(0.0),
                if loaded.downloaded.unwrap_or(false) { " (downloaded)" } else { " (cached)" }
            ),
        );
    }
    let waiting = current.observer_hold;
    reporter.message(
        Level::Success,
        &format!("{} · {} · {}", if waiting { "Simulation ready, waiting for the observer" } else { "Simulation running" }, loaded.seed, loaded.day_name()),
        &format!("{} road nodes · {} buildings and places", thousands(loaded.nodes), thousands(loaded.places)),
    );
    // A world copied with a state code is taken to the moment it was at, once.
    if let Some(said) = crate::state::jump_after_start(port, &[loaded.seed.as_str(), seed.as_str()], paths) {
        reporter.message(Level::Info, "Launcher state", &said);
    }
    Ok(loaded)
}

pub fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// play, pause or restart (back to 00:00:00 in the same world).
pub fn control(port: u16, action: &str, paths: &Paths) -> Result<api::Response> {
    let (route, payload) = match action {
        "play" => ("/api/v1/fabric/engine/play", json!({})),
        "pause" => ("/api/v1/fabric/engine/pause", json!({})),
        _ => ("/api/v1/fabric/engine/seek", json!({"target_time": 0, "play": true})),
    };
    let response = api::post(port, route, &payload, 60.0, paths);
    if !response.ok() {
        return Err(LauncherError::runtime(format!("Could not {action} the simulation: {}", response.error_message())));
    }
    Ok(response)
}

/// Wait until the observer page has loaded, so start-up is watched there.
pub fn wait_for_observer(port: u16, timeout: f64, paths: &Paths, cancel: Option<&Cancel>) -> Result<bool> {
    let until = Instant::now() + Duration::from_secs_f64(timeout);
    while Instant::now() < until {
        if let Some(cancel) = cancel {
            cancel.check()?;
        }
        if api::get(port, "/api/v1/system/observer", 2.0, paths).body.pointer("/data/loaded").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(150));
    }
    Ok(false)
}

const CHROMES: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

/// A Chromium-based browser, which can open a window of its own: full screen, and allowed to play sound.
pub fn chrome() -> Option<PathBuf> {
    CHROMES
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .or_else(|| ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"].iter().find_map(|n| which(n)))
}

/// Open the observer in a window of its own when it should be full screen or play sound. A page may only go full
/// screen, or play sound, after a person has done something on it; a window of its own, with its own profile, can do
/// both from the start. Without such a browser, the ordinary one opens it, and the observer asks for a click.
pub fn open_presentation(url: &str, fullscreen: bool, sound: bool, profile: &Path) -> bool {
    let browser = if fullscreen || sound { chrome() } else { None };
    let Some(browser) = browser else { return open_in_browser(url) };
    let _ = fs::create_dir_all(profile);
    let mut command = Command::new(browser);
    command.args([
        format!("--app={url}"),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--autoplay-policy=no-user-gesture-required".into(),
    ]);
    if fullscreen {
        command.arg("--start-fullscreen");
    }
    use std::os::unix::process::CommandExt;
    match command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn() {
        Ok(_) => true,
        Err(_) => open_in_browser(url),
    }
}

/// Open `url` with the platform's handler, without a shell.
pub fn open_in_browser(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    capture(&[opener, url], None, 15.0, &[]).0 == 0
}

/// The launcher's default for --open: a desktop is present.
pub fn can_open_browser() -> bool {
    cfg!(target_os = "macos") || std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Network totals the engine reports; None where it reported nothing.
#[derive(Clone, Debug, Default)]
pub struct Metrics {
    pub vehicles: Option<i64>,
    pub halting: Option<i64>,
    pub mean_speed_kmh: Option<f64>,
    pub congestion: Option<f64>,
    pub congestion_average: Option<f64>,
    pub flooded_roads: Option<i64>,
    pub closed_roads: Option<i64>,
    pub storms: Option<i64>,
    pub target_rate: Option<f64>,
}

pub fn metrics(port: u16, paths: &Paths) -> Metrics {
    let mut result = Metrics::default();
    let traffic = api::get(port, "/api/v1/view/traffic", 3.0, paths);
    if let Some(data) = traffic.data() {
        result.vehicles = data.get("vehicle_count").and_then(|v| v.as_i64());
        result.halting = data.get("halting_vehicle_count").and_then(|v| v.as_i64());
        result.mean_speed_kmh = data.get("mean_vehicle_speed_mps").and_then(|v| v.as_f64()).map(|v| v * 3.6);
        result.flooded_roads = data.get("flooded_edge_count").and_then(|v| v.as_i64());
        result.closed_roads = data.get("closed_edge_count").and_then(|v| v.as_i64());
        result.storms = data.get("active_dws_events").and_then(|v| v.as_i64());
        result.target_rate = traffic.body.pointer("/clock/target_virtual_rate").and_then(|v| v.as_f64());
    }
    if let Some(data) = api::get(port, "/api/v1/view/congestion", 3.0, paths).data() {
        result.congestion = data.get("current").and_then(|v| v.as_f64());
        result.congestion_average = data.get("average").and_then(|v| v.as_f64());
    }
    result
}

/// Wall-clock time to the end of the day at the current rate, while running.
pub fn remaining_wall_seconds(current: &Status, rate: Option<f64>) -> Option<f64> {
    let rate = rate.filter(|r| *r > 0.0)?;
    (current.lifecycle == "RUNNING").then(|| ((86400.0 - current.virtual_seconds) / rate).max(0.0))
}

/// (CPU per cent, resident MiB) of a process, measured with ps.
pub fn server_usage(pid: u32) -> Option<(f64, f64)> {
    let (code, out, _) = capture(&["ps", "-o", "%cpu=,rss=", "-p", &pid.to_string()], None, 3.0, &[]);
    if code != 0 {
        return None;
    }
    let mut parts = out.split_whitespace();
    let cpu: f64 = parts.next()?.parse().ok()?;
    let rss: f64 = parts.next()?.parse().ok()?;
    Some((cpu, rss / 1024.0))
}
