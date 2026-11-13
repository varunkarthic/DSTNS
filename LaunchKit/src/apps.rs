// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The applications this launcher can start: what they are and how to start each.
//!
//! config/apps.json belongs to the person at this machine. What is in it runs, so nothing but the launcher writes
//! it: the Fabric API can only propose an entry, and a person approves it here.

use crate::config::RunOptions;
use crate::errors::{LauncherError, Result};
use crate::paths::Paths;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

pub const RESTARTS: &[&str] = &["never", "on-failure"];
const MAX_COMMANDS: usize = 8;
const MAX_COMMAND_BYTES: usize = 1024;
/// What is given to an application, never taken from it.
pub const RESERVED_ENV: &[&str] = &["DSTNS_APP_ID", "DSTNS_OPERATOR_TOKEN", "DSTNS_PORT", "DSTNS_URL"];

fn default_cwd() -> String {
    ".".into()
}
fn default_ready() -> String {
    "fabric".into()
}
fn default_timeout() -> f64 {
    60.0
}
fn default_restart() -> String {
    "never".into()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct App {
    #[serde(skip)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Run in order. Each must finish successfully; the last is the application, and stays running.
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// fabric: it reports itself active. process: it stays up. delay:S: a fixed wait. A URL: it answers.
    #[serde(default = "default_ready")]
    pub ready: String,
    #[serde(default = "default_timeout")]
    pub timeout_s: f64,
    #[serde(default = "default_restart")]
    pub restart: String,
    /// A required application that fails stops the simulation from starting.
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub autostart: bool,
    /// Permissions this person has already decided to give it, and the settings it should start with.
    #[serde(default)]
    pub grants: Vec<String>,
    #[serde(default)]
    pub settings: Map<String, Value>,
    /// A web interface of its own: the observer offers a button that opens it in a new tab.
    #[serde(default)]
    pub web_url: String,
    #[serde(default)]
    pub web_label: String,
}

impl App {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.into(),
            name: String::new(),
            commands: vec![],
            cwd: ".".into(),
            env: BTreeMap::new(),
            ready: "fabric".into(),
            timeout_s: 60.0,
            restart: "never".into(),
            required: false,
            autostart: false,
            grants: vec![],
            settings: Map::new(),
            web_url: String::new(),
            web_label: String::new(),
        }
    }
    pub fn title(&self) -> String {
        if self.name.is_empty() {
            self.id.clone()
        } else {
            self.name.clone()
        }
    }
    pub fn to_json(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap();
        value["id"] = json!(self.id);
        value
    }
}

pub fn validate(app: &App) -> Result<()> {
    let id = Regex::new(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$").unwrap();
    if !(3..=64).contains(&app.id.len()) || !id.is_match(&app.id) {
        return Err(LauncherError::config(format!("\"{}\" is not an application ID.", app.id))
            .remedy("Use 3 to 64 lower-case letters, digits, dots and hyphens, such as org.example.planner."));
    }
    if app.commands.is_empty() || app.commands.len() > MAX_COMMANDS {
        return Err(LauncherError::config(format!("{} needs 1 to {MAX_COMMANDS} commands.", app.id)).remedy("Add one with --command \"python3 app.py --url {url}\"."));
    }
    for command in &app.commands {
        if command.trim().is_empty() || command.len() > MAX_COMMAND_BYTES {
            return Err(LauncherError::config(format!("{} has a command that is empty or over {MAX_COMMAND_BYTES} bytes.", app.id)));
        }
        if shlex::split(command).is_none() {
            return Err(LauncherError::config(format!("{} has a command that cannot be read: No closing quotation", app.id)).remedy(command.clone()));
        }
    }
    let ready = Regex::new(r"^(?:fabric|process|delay:\d+(?:\.\d+)?|https?://\S+)$").unwrap();
    if !ready.is_match(&app.ready) {
        return Err(LauncherError::config(format!("\"{}\" is not a way of being ready.", app.ready)).remedy("Use fabric, process, delay:SECONDS or an http(s) URL."));
    }
    if !(1.0..=600.0).contains(&app.timeout_s) {
        return Err(LauncherError::config(format!("{}: the timeout must be 1 to 600 seconds.", app.id)));
    }
    if !RESTARTS.contains(&app.restart.as_str()) {
        return Err(LauncherError::config(format!("\"{}\" is not a restart policy.", app.restart)).remedy("Use never or on-failure."));
    }
    if !app.web_url.is_empty() && (!Regex::new(r"^https?://\S+$").unwrap().is_match(&app.web_url) || app.web_url.len() > 2000) {
        return Err(LauncherError::config(format!("{}: the web address must be an http or https URL.", app.id)).remedy("For example http://127.0.0.1:5173/"));
    }
    if app.web_label.chars().count() > 40 {
        return Err(LauncherError::config(format!("{}: the web button's label is at most 40 characters.", app.id)));
    }
    let env_name = Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap();
    for name in app.env.keys() {
        if !env_name.is_match(name) || RESERVED_ENV.contains(&name.as_str()) {
            let remedy = if RESERVED_ENV.contains(&name.as_str()) { format!("{} are the launcher's.", RESERVED_ENV.join(", ")) } else { String::new() };
            return Err(LauncherError::config(format!("{name} cannot be set for an application.")).remedy(remedy));
        }
    }
    Ok(())
}

pub fn catalogue_path(paths: &Paths) -> PathBuf {
    std::env::var("DSTNS_APPS_FILE").ok().filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| paths.root.join("config").join("apps.json"))
}

pub fn load(paths: &Paths) -> Result<BTreeMap<String, App>> {
    let path = catalogue_path(paths);
    let text = match fs::read_to_string(&path) {
        Err(_) => return Ok(BTreeMap::new()),
        Ok(text) => text,
    };
    let saved: Value = serde_json::from_str(&text)
        .map_err(|e| LauncherError::config(format!("{} is not valid JSON (line {}).", path.display(), e.line())).remedy("Correct the file, or remove it to start again."))?;
    let mut out = BTreeMap::new();
    if let Some(apps) = saved.get("apps").and_then(|a| a.as_object()) {
        for (id, record) in apps {
            let mut app: App = serde_json::from_value(record.clone()).map_err(|e| LauncherError::config(format!("{id}: {e}")))?;
            app.id = id.clone();
            validate(&app)?;
            out.insert(id.clone(), app);
        }
    }
    Ok(out)
}

pub fn save(catalogue: &BTreeMap<String, App>, paths: &Paths) -> Result<()> {
    let path = catalogue_path(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let records: Map<String, Value> = catalogue.iter().map(|(id, app)| (id.clone(), serde_json::to_value(app).unwrap())).collect();
    let text = serde_json::to_string_pretty(&json!({"version": 1, "apps": records})).unwrap() + "\n";
    // Written beside the target and renamed, so that a crash leaves the old file whole.
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, text)?;
    fs::rename(temporary, path)?;
    Ok(())
}

pub fn put(app: App, paths: &Paths) -> Result<App> {
    validate(&app)?;
    let mut catalogue = load(paths)?;
    catalogue.insert(app.id.clone(), app.clone());
    save(&catalogue, paths)?;
    Ok(app)
}

pub fn remove(id: &str, paths: &Paths) -> Result<()> {
    let mut catalogue = load(paths)?;
    if catalogue.remove(id).is_none() {
        return Err(LauncherError::config(format!("No application {id}.")).remedy("./launcher apps list shows them."));
    }
    save(&catalogue, paths)
}

pub fn get(id: &str, paths: &Paths) -> Result<App> {
    load(paths)?.remove(id).ok_or_else(|| LauncherError::config(format!("No application {id}.")).remedy("./launcher apps list shows them."))
}

/// What this run should start: those named, or else those set to start by themselves.
pub fn selection(options: &RunOptions, paths: &Paths) -> Result<Vec<App>> {
    if options.no_apps {
        return Ok(vec![]);
    }
    let catalogue = load(paths)?;
    let Some(names) = &options.apps else { return Ok(catalogue.into_values().filter(|a| a.autostart).collect()) };
    let names: Vec<&str> = names.split(',').map(str::trim).filter(|n| !n.is_empty()).collect();
    let missing: Vec<&str> = names.iter().copied().filter(|n| !catalogue.contains_key(*n)).collect();
    if !missing.is_empty() {
        return Err(LauncherError::config(format!("No application {}.", missing.join(", "))).remedy("./launcher apps list shows them, and ./launcher apps add adds one."));
    }
    Ok(names.into_iter().map(|n| catalogue[n].clone()).collect())
}

/// What will stop it from starting, found before trying.
pub fn problems(app: &App, paths: &Paths) -> Vec<String> {
    let mut found = vec![];
    let place = crate::paths::absolute(&paths.root.join(&app.cwd));
    if !place.is_dir() {
        found.push(format!("The working directory {} does not exist.", app.cwd));
    }
    for command in &app.commands {
        let Some(program) = shlex::split(command).and_then(|p| p.into_iter().next()) else { continue };
        if program.contains('/') {
            let target = place.join(&program);
            use std::os::unix::fs::PermissionsExt;
            if !target.exists() {
                found.push(format!("{program} does not exist in {}.", app.cwd));
            } else if target.metadata().map(|m| m.permissions().mode() & 0o111 == 0).unwrap_or(true) {
                found.push(format!("{program} is not executable."));
            }
        } else if crate::process::which(&program).is_none() {
            found.push(format!("{program} is not on this machine's PATH."));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> App {
        let mut app = App::new("org.example.planner");
        app.commands = vec!["python3 planner.py --url {url}".into()];
        app
    }

    #[test]
    fn a_good_application_validates() {
        assert!(validate(&app()).is_ok());
    }

    #[test]
    fn bad_entries_say_what_is_wrong() {
        let mut bad = app();
        bad.id = "Bad ID".into();
        assert!(validate(&bad).unwrap_err().message.contains("not an application ID"));
        let mut bad = app();
        bad.ready = "whenever".into();
        assert!(validate(&bad).unwrap_err().message.contains("not a way of being ready"));
        let mut bad = app();
        bad.env.insert("DSTNS_OPERATOR_TOKEN".into(), "x".into());
        assert!(validate(&bad).unwrap_err().message.contains("cannot be set"));
        let mut bad = app();
        bad.web_url = "javascript:alert(1)".into();
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn the_catalogue_round_trips() {
        let _environment = crate::paths::test_environment();
        let dir = std::env::temp_dir().join(format!("dstns-apps-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("DSTNS_APPS_FILE", dir.join("apps.json"));
        let paths = Paths::new(&dir);
        put(app(), &paths).unwrap();
        let loaded = get("org.example.planner", &paths).unwrap();
        assert_eq!(loaded, app());
        let written: Value = serde_json::from_str(&fs::read_to_string(dir.join("apps.json")).unwrap()).unwrap();
        assert_eq!(written["version"], json!(1));
        assert!(written["apps"]["org.example.planner"].get("id").is_none(), "the ID is the key, not a field");
        remove("org.example.planner", &paths).unwrap();
        assert!(load(&paths).unwrap().is_empty());
        std::env::remove_var("DSTNS_APPS_FILE");
        fs::remove_dir_all(dir).ok();
    }
}
