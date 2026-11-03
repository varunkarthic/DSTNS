// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Realistic News: which model the server should use to write the news, if any.
//!
//! The launcher decides before it starts the server, so that it can say why narration is off - fm missing, the model
//! not available, Apple's terms not accepted, an endpoint not answering - and fall back to the default wording
//! explicitly. Narration is cosmetic: whatever is chosen here, the simulation runs the same. The mode comes from
//! --narrator, else DSTNS_NARRATOR, else narration.mode in config/defaults.json, else auto.

use crate::api;
use crate::config;
use crate::paths::Paths;
use crate::process::{capture, which};
use crate::reporting::{Level, Reporter};
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const ENV: &str = "DSTNS_NARRATOR";
pub const FM_LABEL: &str = "Apple Foundation Models (on device)";
pub const DEFAULT_WORDING: &str = "Standard news";
pub const BRAND: &str = "Realistic News";
pub const AVAILABLE: &str = "Available";
pub const UNAVAILABLE: &str = "Unavailable";
pub const DISABLED: &str = "Disabled";

/// What was asked for, what the server will be told, and why.
#[derive(Clone, Debug)]
pub struct Choice {
    pub requested: String,
    /// The value passed to dstns_server --narrator.
    pub server_argument: String,
    /// What is running, for display.
    pub label: String,
    /// Why narration is off or not what was asked for.
    pub reason: String,
    pub remedy: String,
}

impl Choice {
    fn new(requested: &str, argument: &str, label: &str, reason: &str, remedy: &str) -> Self {
        Self { requested: requested.into(), server_argument: argument.into(), label: label.into(), reason: reason.into(), remedy: remedy.into() }
    }
    fn off(requested: &str, reason: impl Into<String>, remedy: &str) -> Self {
        Self::new(requested, "off", "off", &reason.into(), remedy)
    }
    pub fn enabled(&self) -> bool {
        self.server_argument != "off"
    }
    /// Narration was wanted but is not available, so the default wording applies.
    pub fn fell_back(&self) -> bool {
        !self.enabled() && self.requested != "off"
    }
    pub fn fm_status(&self) -> &'static str {
        if self.server_argument == "fm" {
            AVAILABLE
        } else if self.requested == "auto" || self.requested == "fm" {
            UNAVAILABLE
        } else {
            DISABLED
        }
    }
    pub fn summary(&self) -> String {
        if self.enabled() {
            format!("Apple Foundation Models: {} · {BRAND} via {}", self.fm_status(), self.label)
        } else {
            format!("Apple Foundation Models: {} · {DEFAULT_WORDING}{}", self.fm_status(), if self.reason.is_empty() { String::new() } else { format!(" ({})", self.reason) })
        }
    }
}

pub fn requested_mode(paths: &Paths) -> String {
    let from_env = std::env::var(ENV).unwrap_or_default().trim().to_string();
    if !from_env.is_empty() {
        return from_env;
    }
    config::load(paths).ok().and_then(|c| c.pointer("/narration/mode").and_then(|v| v.as_str()).map(String::from)).filter(|m| !m.is_empty()).unwrap_or_else(|| "auto".into())
}

pub fn find_fm() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    which("fm").or_else(|| {
        let system = PathBuf::from("/usr/bin/fm");
        system.exists().then_some(system)
    })
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(160).collect()
}

fn check_fm(requested: &str) -> Choice {
    if !cfg!(target_os = "macos") {
        return Choice::off(requested, "Apple Foundation Models are only available on macOS", "Point --narrator at a Chat Completions endpoint (llama.cpp, Ollama) to narrate here.");
    }
    let Some(fm) = find_fm() else {
        return Choice::off(requested, "the fm command was not found", "Apple Foundation Models need macOS 26 or later with Apple Intelligence on Apple silicon.");
    };
    let fm = fm.to_string_lossy().into_owned();
    let (code, out, _) = capture(&[&fm, "available"], None, 15.0, &[("NO_COLOR", "1")]);
    let lowered = out.to_lowercase();
    if code != 0 || !lowered.contains("available") || lowered.contains("not available") || lowered.contains("unavailable") {
        let shown = if first_line(&out).is_empty() { format!("exit {code}") } else { first_line(&out) };
        return Choice::off(requested, format!("the on-device model is not available ({shown})"), "Turn on Apple Intelligence in System Settings and let the model finish downloading.");
    }
    let (code, out, _) = capture(&[&fm, "license", "--status"], None, 15.0, &[("NO_COLOR", "1")]);
    let lowered = out.to_lowercase();
    if code != 0 || !lowered.contains("agreed") || lowered.contains("not agreed") {
        return Choice::off(requested, "Apple's Foundation Models terms have not been accepted", "Run fm license once in a terminal to read and accept them.");
    }
    Choice::new(requested, "fm", FM_LABEL, "", "")
}

fn check_endpoint(requested: &str) -> Choice {
    let label = format!("Chat Completions at {requested}");
    if let Some(socket) = requested.strip_prefix("unix:") {
        if !std::path::Path::new(socket).exists() {
            return Choice::off(requested, format!("no socket at {socket}"), "Start the model server first.");
        }
        return Choice::new(requested, requested, &label, "", "");
    }
    let mut url = requested.trim_end_matches('/').to_string();
    if url.ends_with("/v1") {
        url.truncate(url.len() - 3);
    }
    match api::agent(Duration::from_secs(3)).get(&format!("{url}/v1/models")).call() {
        Ok(response) if response.status().as_u16() == 200 => Choice::new(requested, requested, &label, "", ""),
        Ok(_) => Choice::off(requested, format!("{requested} did not list its models"), "Check the endpoint address."),
        Err(error) => Choice::off(requested, format!("{requested} is not answering ({error})"), "Start the model server, or set --narrator auto to use Apple's on-device model."),
    }
}

/// Decide what the server should use. Never fails: anything wrong means off.
pub fn resolve(requested: Option<&str>, paths: &Paths) -> Choice {
    let requested = requested.map(String::from).unwrap_or_else(|| requested_mode(paths)).trim().to_string();
    match requested.as_str() {
        "off" | "none" => Choice::new("off", "off", "off", "turned off", ""),
        "auto" | "fm" => check_fm(&requested),
        r if r.starts_with("http://") || r.starts_with("unix:/") => check_endpoint(r),
        r if r.starts_with("https://") => Choice::off(r, "the engine speaks plain HTTP only", "Use an http:// address, with a TLS proxy in front of a remote model."),
        r => Choice::off(r, format!("\"{r}\" is not a narration mode"), "Use auto, fm, off, http://HOST:PORT or unix:/PATH."),
    }
}

/// (state, text) for the server's /api/v1/system/narrator report.
pub fn describe_server(status: Option<&Value>) -> (String, String) {
    let Some(status) = status else { return ("unknown".into(), "the server did not report narration (an older server?)".into()) };
    if !status.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
        return ("off".into(), format!("Apple Foundation Models: {DISABLED} or {UNAVAILABLE} · {DEFAULT_WORDING}"));
    }
    let backend = status.get("backend").cloned().unwrap_or(Value::Null);
    let apple = backend.get("kind").and_then(|v| v.as_str()) == Some("apple-foundation-models");
    let name = if apple { "Apple Foundation Models".to_string() } else { format!("Chat Completions at {}", backend.get("endpoint").and_then(|v| v.as_str()).unwrap_or("?")) };
    let state = status.get("state").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
    let available = if apple { format!("{name}: {AVAILABLE}") } else { name.clone() };
    let text = match state.as_str() {
        "ready" => format!("{available} · {} items written", status.get("completed").and_then(|v| v.as_i64()).unwrap_or(0)),
        "starting" => format!("{available} · loading the model"),
        "backoff" | "unavailable" => {
            let reason = status.get("last_error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(&state).to_string();
            if apple {
                format!("{name}: {UNAVAILABLE} ({reason}); {DEFAULT_WORDING}")
            } else {
                format!("{name} is not answering ({reason}); {DEFAULT_WORDING}")
            }
        }
        _ => name,
    };
    (state, text)
}

/// Say, before the server starts, what narration it will use.
pub fn announce(choice: &Choice, reporter: &dyn Reporter) {
    let title = format!("Apple Foundation Models: {}", choice.fm_status());
    let remedy = if choice.remedy.is_empty() { String::new() } else { format!(". {}", choice.remedy) };
    match choice.fm_status() {
        AVAILABLE => reporter.message(Level::Success, &title, &format!("{BRAND} on: news written on this Mac from each event and its context")),
        UNAVAILABLE => reporter.message(Level::Warning, &title, &format!("{}{remedy} Using {DEFAULT_WORDING}.", choice.reason)),
        _ if choice.enabled() => reporter.message(Level::Info, &title, &format!("{BRAND} via {}", choice.label)),
        _ if choice.fell_back() => reporter.message(Level::Warning, &format!("{title} · {BRAND} unavailable"), &format!("{}{remedy} Using {DEFAULT_WORDING}.", choice.reason)),
        _ => reporter.message(Level::Info, &title, &format!("turned off; {DEFAULT_WORDING}")),
    }
}

pub fn server_status(port: u16, paths: &Paths) -> Option<Value> {
    api::get(port, "/api/v1/system/narrator", 3.0, paths).data().filter(|d| d.is_object()).cloned()
}

/// After the run starts, report what the server's narrator actually did. The model loads on first use, so give it a
/// few seconds; if it fails the server falls back to the default wording by itself, and this says so.
pub fn confirm(port: u16, reporter: &dyn Reporter, paths: &Paths, cancel: Option<&crate::process::Cancel>) {
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut status = server_status(port, paths);
    while let Some(s) = &status {
        let starting = s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) && s.get("state").and_then(|v| v.as_str()) == Some("starting");
        if !starting || Instant::now() > deadline || cancel.map(|c| c.is_set()).unwrap_or(false) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
        status = server_status(port, paths);
    }
    let (state, text) = describe_server(status.as_ref());
    match state.as_str() {
        "ready" => reporter.message(Level::Success, &format!("{BRAND} ready"), &text),
        "starting" => reporter.message(Level::Info, &format!("{BRAND} starting"), &format!("{text}; {DEFAULT_WORDING} is shown until it is ready")),
        "backoff" | "unavailable" => reporter.message(Level::Warning, &format!("{BRAND} unavailable: using {DEFAULT_WORDING}"), &text),
        _ => {}
    }
}
