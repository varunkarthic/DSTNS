// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! `config/defaults.json`: loading, validation, editing and the start request.
//!
//! The launcher edits the existing configuration file; it keeps no configuration of its own. The bounds are the
//! engine's, so a configuration accepted here is one the engine accepts.

use crate::errors::{LauncherError, Result};
use crate::paths::{absolute, Paths};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;

/// The engine refuses anything faster (kMaxTickRate in Core/core-legacy/include/dstns/model.hpp).
pub const MAX_TICK_RATE: f64 = 10.0;
pub const MAP_SELECTION_VERSION: &str = "urban-crfg-v3";
/// The engines a run may name.
pub const ENGINES: [&str; 2] = ["core-legacy", "core-ng"];
/// The stable engine every installation starts on, and the one a reset of the settings returns to. It cannot be
/// disabled. core-ng becomes the default only with full parity (issue #22).
pub const DEFAULT_ENGINE: &str = "core-legacy";
/// core-ng's policy over chosen countries or cities (docs/concepts/deterministic-seeding.md).
pub const GEO_SELECTION_VERSION: &str = "urban-geo-v1";

pub fn load(paths: &Paths) -> Result<Value> {
    let text = fs::read_to_string(paths.config()).map_err(|_| {
        LauncherError::config(format!("{} is missing.", paths.relative(&paths.config()))).remedy("Restore it from the repository: git checkout -- config/defaults.json")
    })?;
    let config: Value = serde_json::from_str(&text).map_err(|error| {
        LauncherError::config(format!("{} is not valid JSON (line {}, column {}).", paths.relative(&paths.config()), error.line(), error.column()))
            .remedy("Correct the file, or restore it with git checkout -- config/defaults.json")
    })?;
    validate(&config)?;
    let mut config = config;
    // The observer's operator defaults live in their own file, which the server serves to the page; here they are one
    // more part of the settings, under "ui", so that every setting is edited, checked and carried in the same way.
    if let Some(object) = config.as_object_mut() {
        object.insert("ui".into(), read_ui(paths));
        // Engine policy lives in config/engines.json, which the server reads too. A launcher from 3.1 to 3.6 kept the
        // chosen engine in defaults.json as engine.implementation; it moves across the first time.
        let mut engines = read_engines(paths);
        // The operator's own choice, from before, wins over the file's template value.
        if let Some(old) = object.remove("engine").and_then(|e| e.get("implementation").cloned()) {
            engines["selected"] = old;
        }
        object.insert("engines".into(), engines);
    }
    Ok(config)
}

fn read_engines(paths: &Paths) -> Value {
    fs::read_to_string(paths.engines_config()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object()).unwrap_or_else(|| json!({"schema_version": 1}))
}

fn read_ui(paths: &Paths) -> Value {
    fs::read_to_string(paths.ui_config()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v.is_object()).unwrap_or_else(|| json!({}))
}

/// The checks the launcher has always made before a run.
pub fn validate(config: &Value) -> Result<()> {
    let duration = config.pointer("/playback/duration_seconds");
    let tick = config.pointer("/playback/tick_rate");
    let port = config.pointer("/api/port");
    if !matches!(duration.and_then(as_int), Some(60..=3600)) {
        return Err(LauncherError::config("playback.duration_seconds must be an integer in [60, 3600]"));
    }
    if !matches!(tick.and_then(as_number), Some(t) if t > 0.0 && t <= MAX_TICK_RATE) {
        return Err(LauncherError::config(format!("playback.tick_rate must be in (0, {}]", fmt_g(MAX_TICK_RATE))));
    }
    if !matches!(port.and_then(as_int), Some(1..=65535)) {
        return Err(LauncherError::config("api.port must be an integer in [1, 65535]"));
    }
    if config.pointer("/api/host").and_then(|h| h.as_str()).map(|h| h.is_empty()).unwrap_or(true) {
        return Err(LauncherError::config("api.host must be configured"));
    }
    Ok(())
}

/// Validate, then write atomically in the file's existing format.
const KEY_ADVANCED_SECURITY: &str = crate::security::KEY;

pub fn save(config: &Value, paths: &Paths) -> Result<()> {
    validate(config)?;
    // Advanced Security goes on or off only for the person at this machine, however it was changed.
    let was = load(paths).map(|c| flag(&c, KEY_ADVANCED_SECURITY)).unwrap_or(false);
    let now = flag(config, KEY_ADVANCED_SECURITY);
    if was != now {
        crate::security::confirm_change(paths, now).map_err(|why| LauncherError::config(format!("Advanced Security was not {}: {why}", if now { "turned on" } else { "turned off" })))?;
    }
    for field in fields() {
        let problem = check_field(field, &field.get(config), config);
        if !problem.is_empty() {
            return Err(LauncherError::config(format!("{}: {problem}", field.label)));
        }
    }
    // What changed, into the launcher's log: every setting, from what to what.
    if let Ok(before) = load(paths) {
        for field in fields() {
            let (was_value, now_value) = (field.get(&before), field.get(config));
            if was_value != now_value {
                if sensitive_setting(field.key) {
                    crate::log::info(&format!("settings: {} changed", field.key));
                } else {
                    crate::log::info(&format!("settings: {} from {} to {}", field.key, field.display(&was_value), field.display(&now_value)));
                }
            }
        }
    }
    // The observer's part goes to its own file, and only when it changed; the rest to defaults.json.
    let mut config = config.clone();
    if let Some(mut engines) = config.as_object_mut().and_then(|o| o.remove("engines")).filter(|e| e.is_object()) {
        engines["schema_version"] = json!(1);
        engines["default"] = json!(DEFAULT_ENGINE);
        if engines != read_engines(paths) {
            let temporary = paths.engines_config().with_extension("json.tmp");
            fs::write(&temporary, serde_json::to_string_pretty(&engines).unwrap() + "\n")?;
            fs::rename(&temporary, paths.engines_config())?;
        }
    }
    let ui = config.as_object_mut().and_then(|o| o.remove("ui"));
    if let Some(ui) = ui.filter(|u| u.is_object()) {
        if ui != read_ui(paths) {
            let temporary = paths.ui_config().with_extension("json.tmp");
            fs::write(&temporary, serde_json::to_string_pretty(&ui).unwrap() + "\n")?;
            fs::rename(&temporary, paths.ui_config())?;
        }
    }
    let text = serde_json::to_string_pretty(&config).unwrap() + "\n";
    let temporary = paths.config().with_extension("json.tmp");
    fs::write(&temporary, text)?;
    fs::rename(&temporary, paths.config())?;
    crate::security::seal(paths);
    Ok(())
}

pub fn as_int(value: &Value) -> Option<i64> {
    if value.is_boolean() {
        return None;
    }
    value.as_i64()
}

pub fn as_number(value: &Value) -> Option<f64> {
    if value.is_boolean() {
        return None;
    }
    value.as_f64().filter(|v| !v.is_nan())
}

/// A number as Python's `{:g}` writes it, which is how the launcher has always shown ranges.
pub fn fmt_g(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value}");
        text
    }
}

// --- Editable fields --------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    Integer,
    Number,
    Boolean,
    Text,
    Choice,
}

pub type Extra = fn(&Value, &Value) -> String;

/// One setting the configuration screen can edit. Only settings that the launcher or the engine actually read are
/// listed; the informational keys in defaults.json are left alone.
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub category: &'static str,
    pub kind: FieldKind,
    pub help: &'static str,
    pub unit: &'static str,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub exclusive_minimum: bool,
    pub choices: Vec<(&'static str, Value)>,
    pub default: Value,
    pub extra: Option<Extra>,
}

impl Field {
    fn new(key: &'static str, label: &'static str, category: &'static str, kind: FieldKind, help: &'static str, default: Value) -> Self {
        Self { key, label, category, kind, help, unit: "", minimum: None, maximum: None, exclusive_minimum: false, choices: vec![], default, extra: None }
    }
    fn unit(mut self, unit: &'static str) -> Self {
        self.unit = unit;
        self
    }
    fn range(mut self, minimum: f64, maximum: Option<f64>) -> Self {
        self.minimum = Some(minimum);
        self.maximum = maximum;
        self
    }
    fn above(mut self) -> Self {
        self.exclusive_minimum = true;
        self
    }
    fn choices(mut self, choices: Vec<(&'static str, Value)>) -> Self {
        self.choices = choices;
        self
    }
    fn extra(mut self, extra: Extra) -> Self {
        self.extra = Some(extra);
        self
    }

    pub fn get(&self, config: &Value) -> Value {
        let mut node = config;
        for part in self.key.split('.') {
            match node.get(part) {
                Some(next) => node = next,
                None => return self.default.clone(),
            }
        }
        node.clone()
    }

    /// Set it, and whatever must change with it (see RULES). Returns the other settings that changed.
    pub fn set(&self, config: &mut Value, value: Value) -> Vec<&'static str> {
        self.store(config, value.clone());
        let mut changed = vec![];
        for (when, becomes, other, to) in RULES {
            let (becomes, to): (Value, Value) = (serde_json::from_str(becomes).expect("a rule's value is JSON"), serde_json::from_str(to).expect("a rule's value is JSON"));
            if *when == self.key && value == becomes {
                if let Some(field) = field(other) {
                    if field.get(config) != to {
                        field.store(config, to);
                        changed.push(field.key);
                    }
                }
            }
        }
        changed
    }

    fn store(&self, config: &mut Value, value: Value) {
        let parts: Vec<&str> = self.key.split('.').collect();
        let mut node = config;
        for part in &parts[..parts.len() - 1] {
            if !node.get(*part).map(|n| n.is_object()).unwrap_or(false) {
                node[*part] = json!({});
            }
            node = node.get_mut(*part).unwrap();
        }
        node[parts[parts.len() - 1]] = value;
    }

    /// Turn what the operator typed into a value, or say why it is not one.
    pub fn parse(&self, text: &str) -> std::result::Result<Value, String> {
        let text = text.trim();
        let value = match self.kind {
            FieldKind::Integer => {
                let ok = !text.is_empty() && text.trim_start_matches('-').chars().all(|c| c.is_ascii_digit());
                if !ok {
                    return Err("Enter a whole number.".into());
                }
                json!(text.parse::<i64>().map_err(|_| "Enter a whole number.".to_string())?)
            }
            FieldKind::Number => {
                let number: f64 = text.parse().map_err(|_| "Enter a number.".to_string())?;
                if number.fract() == 0.0 && !text.contains('.') && number.abs() < 1e15 {
                    json!(number as i64)
                } else {
                    json!(number)
                }
            }
            FieldKind::Boolean => {
                let lowered = text.to_lowercase();
                if !["true", "false", "on", "off", "yes", "no", "1", "0"].contains(&lowered.as_str()) {
                    return Err("Enter on or off.".into());
                }
                json!(["true", "on", "yes", "1"].contains(&lowered.as_str()))
            }
            FieldKind::Choice => {
                let lowered = text.to_lowercase();
                let found = self.choices.iter().find(|(label, choice)| label.to_lowercase() == lowered || choice_text(choice).to_lowercase() == lowered);
                match found {
                    Some((_, choice)) => choice.clone(),
                    None => return Err(format!("Choose one of: {}.", self.choices.iter().map(|(l, _)| *l).collect::<Vec<_>>().join(", "))),
                }
            }
            FieldKind::Text => json!(text),
        };
        let problem = self.check(&value);
        if problem.is_empty() {
            Ok(value)
        } else {
            Err(problem)
        }
    }

    /// An explanation of what is wrong with `value`, or "".
    pub fn check(&self, value: &Value) -> String {
        match self.kind {
            FieldKind::Integer if as_int(value).is_none() => return "must be a whole number.".into(),
            FieldKind::Number if as_number(value).is_none() => return "must be a number.".into(),
            FieldKind::Boolean if !value.is_boolean() => return "must be on or off.".into(),
            FieldKind::Text if value.as_str().map(|s| s.trim().is_empty()).unwrap_or(true) => return "must not be empty.".into(),
            FieldKind::Choice if !self.choices.iter().any(|(_, c)| c == value) => return "is not one of the allowed values.".into(),
            _ => {}
        }
        if let Some(number) = as_number(value) {
            if let Some(minimum) = self.minimum {
                if number < minimum || (self.exclusive_minimum && number == minimum) {
                    return self.range_text();
                }
            }
            if let Some(maximum) = self.maximum {
                if number > maximum {
                    return self.range_text();
                }
            }
        }
        String::new()
    }

    pub fn range_text(&self) -> String {
        let minimum = fmt_g(self.minimum.unwrap_or(0.0));
        match self.maximum {
            None => format!("Must be at least {minimum}."),
            Some(maximum) if self.exclusive_minimum => format!("Must be greater than {minimum} and at most {}.", fmt_g(maximum)),
            Some(maximum) => format!("Must be between {minimum} and {}.", fmt_g(maximum)),
        }
    }

    pub fn display(&self, value: &Value) -> String {
        match self.kind {
            FieldKind::Boolean => if value.as_bool().unwrap_or(false) { "on" } else { "off" }.into(),
            FieldKind::Choice => self.choices.iter().find(|(_, c)| c == value).map(|(l, _)| l.to_string()).unwrap_or_else(|| choice_text(value)),
            _ => choice_text(value),
        }
    }
}

/// A setting whose value is logged only as changed: a credential, or an address that may carry one.
pub fn sensitive_setting(key: &str) -> bool {
    crate::log::secret_name(key) || key.ends_with("_url")
}

fn choice_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn dws_spacing(value: &Value, config: &Value) -> String {
    let duration = config.pointer("/playback/duration_seconds").and_then(as_int);
    if let (Some(count), Some(duration)) = (as_int(value), duration) {
        if count > 0 && (count - 1) * 5 >= duration {
            return "Storms must start at least 5 playback seconds apart; lower the count or lengthen the day.".into();
        }
    }
    String::new()
}

pub fn valid_narration(value: &str) -> bool {
    ["auto", "fm", "model", "off"].contains(&value) || value.starts_with("http://") || value.starts_with("unix:/")
}

fn narration_mode(value: &Value, _config: &Value) -> String {
    if value.as_str().map(valid_narration).unwrap_or(false) {
        String::new()
    } else {
        "Use auto, fm, model, off, http://HOST:PORT or unix:/PATH.".into()
    }
}

/// Demo Mode's scenes, by the ids the observer gives them, in the film's order.
pub const DEMO_SCENES: &[&str] = &["streets", "signals", "demand", "rush-hour", "incidents", "weather", "cities", "repeatable", "auto-focus", "webfabric", "time-control", "many-worlds", "ai-ready"];
/// Their titles, as the film shows them.
pub const DEMO_SCENE_TITLES: &[&str] = &["Mapped streets", "Signal timing", "Travel demand", "Rush hour", "Road incidents", "Simulated weather", "Cities worldwide", "Repeatable worlds", "Auto Focus", "WebFabric", "Time control", "Many worlds", "AI ready"];

/// The scenes named in demo.scenes, in order.
pub fn demo_scene_list(config: &Value) -> Vec<String> {
    setting(config, "demo.scenes").as_str().unwrap_or("").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn demo_scenes(value: &Value, _config: &Value) -> String {
    let text = value.as_str().unwrap_or("");
    match text.split(',').map(str::trim).filter(|s| !s.is_empty()).find(|id| !DEMO_SCENES.contains(id)) {
        Some(unknown) => format!("No scene {unknown}. The scenes: {}.", DEMO_SCENES.join(", ")),
        None => String::new(),
    }
}

/// The kinds of file the film can play, and how large one may be.
pub const MUSIC_TYPES: [&str; 3] = ["mp3", "m4a", "wav"];
const MUSIC_LIMIT: u64 = 64 * 1024 * 1024;

/// A music file, from the checkout (relative paths) or anywhere (absolute ones), if it is one that can be played.
pub fn music_file(value: &str) -> std::result::Result<Option<std::path::PathBuf>, String> {
    let value = value.trim();
    if value.is_empty() || value == "score" {
        return Ok(None);
    }
    let expanded = value.strip_prefix("~/").map(|rest| crate::paths::home().join(rest)).unwrap_or_else(|| std::path::PathBuf::from(value));
    let path = if expanded.is_absolute() { expanded } else { crate::paths::root().join(expanded) };
    let kind = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if !MUSIC_TYPES.contains(&kind.as_str()) {
        return Err("Use an MP3, M4A or WAV file, or score for the written score.".into());
    }
    let meta = std::fs::metadata(&path).map_err(|_| format!("There is no file at {}.", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    if meta.len() > MUSIC_LIMIT {
        return Err("That file is larger than 64 MB.".into());
    }
    Ok(Some(path))
}

fn music(value: &Value, _config: &Value) -> String {
    music_file(value.as_str().unwrap_or("")).err().unwrap_or_default()
}

fn volume(value: &Value, _config: &Value) -> String {
    if as_number(value).map(|v| (0.0..=1.0).contains(&v)).unwrap_or(false) {
        String::new()
    } else {
        "Use a number from 0 to 1.".into()
    }
}

/// One entry of Places, as the engine's ID: a country in capitals (two letters), a city in lower case with hyphens for
/// spaces; a leading - excludes it.
fn place_id(entry: &str) -> (bool, String) {
    let (excluded, name) = match entry.trim().strip_prefix('-') {
        Some(rest) => (true, rest.trim()),
        None => (false, entry.trim()),
    };
    let id = if is_country(name) { name.to_ascii_uppercase() } else { name.to_ascii_lowercase().split_whitespace().collect::<Vec<_>>().join("-") };
    (excluded, id)
}

fn is_country(name: &str) -> bool {
    name.len() == 2 && name.chars().all(|c| c.is_ascii_alphabetic())
}

/// Places as (included, excluded) IDs; all names none.
pub fn place_ids(config: &Value) -> (Vec<String>, Vec<String>) {
    let places = setting(config, "map.places");
    let text = places.as_str().unwrap_or("all").trim();
    let (mut included, mut excluded) = (vec![], vec![]);
    if text.eq_ignore_ascii_case("all") {
        return (included, excluded);
    }
    for entry in text.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let (out, id) = place_id(entry);
        let list = if out { &mut excluded } else { &mut included };
        if !list.contains(&id) {
            list.push(id);
        }
    }
    (included, excluded)
}

fn default_engine_stays(value: &Value, _config: &Value) -> String {
    if value == &json!(false) { "core-legacy is the default engine and cannot be turned off.".into() } else { String::new() }
}

/// The chosen engine must be one that may run.
fn selected_enabled(value: &Value, config: &Value) -> String {
    let id = value.as_str().unwrap_or("");
    if setting(config, &format!("engines.engines.{id}.enabled")) == json!(false) { format!("{id} is turned off; turn it on first.") } else { String::new() }
}

fn places(value: &Value, config: &Value) -> String {
    let text = value.as_str().unwrap_or("").trim();
    if text.eq_ignore_ascii_case("all") {
        return String::new();
    }
    let ok = text.split(',').map(str::trim).all(|p| {
        let name = p.strip_prefix('-').unwrap_or(p).trim();
        !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ' ')
    });
    if !ok {
        return "Write IDs separated by commas, such as IN, AE or mumbai, new-york, with - before one to leave it out (-IN); or all.".into();
    }
    if setting(config, "map.selection_mode") == json!("countries") && !text.split(',').all(|p| is_country(p.trim().trim_start_matches('-').trim())) {
        return "Countries are two-letter codes, such as IN or AE (-IN leaves India out).".into();
    }
    String::new()
}

/// The map selection of a start request: the policy and, under urban-geo-v1, which places. Every city with nothing in
/// Places is urban-crfg-v3, so a seed names the city it always has. Places with "every city" is read by what it
/// lists: two-letter codes are countries, anything else cities; and - before one leaves it out.
pub fn map_selection(config: &Value) -> Result<(String, Option<Value>)> {
    let mut mode = setting(config, "map.selection_mode").as_str().unwrap_or("global").to_string();
    let (included, excluded) = place_ids(config);
    if mode == "global" && included.is_empty() && excluded.is_empty() {
        return Ok((MAP_SELECTION_VERSION.into(), None));
    }
    let countries_listed = included.iter().all(|id| is_country(id));
    if !countries_listed && included.iter().any(|id| is_country(id)) {
        return Err(LauncherError::config("Places chooses both countries and cities; choose one or the other (a city may still be left out of a country with -)."));
    }
    if mode == "global" && !included.is_empty() {
        mode = if countries_listed { "countries" } else { "cities" }.into();
    }
    if mode == "fixed_city" && (included.len() != 1 || !excluded.is_empty()) {
        return Err(LauncherError::config("One city needs exactly one city in Places, and nothing left out."));
    }
    if mode != "global" && included.is_empty() {
        if excluded.is_empty() {
            return Err(LauncherError::config(format!("Where worlds are is {mode}, but Places names none.")).remedy("Set map.places, such as: config set map.places IN, AE (or -IN to leave India out)"));
        }
        // Only exclusions: every city, less those.
        mode = "global".into();
    }
    let (mut countries, mut cities, mut exclude_countries, mut exclude_cities) = (vec![], vec![], vec![], vec![]);
    for id in included {
        if mode == "countries" { countries.push(id) } else { cities.push(id) }
    }
    for id in excluded {
        if is_country(&id) { exclude_countries.push(id) } else { exclude_cities.push(id) }
    }
    let mut selection = json!({"mode": mode, "countries": countries, "cities": cities});
    if !exclude_countries.is_empty() {
        selection["exclude_countries"] = json!(exclude_countries);
    }
    if !exclude_cities.is_empty() {
        selection["exclude_cities"] = json!(exclude_cities);
    }
    Ok((GEO_SELECTION_VERSION.into(), Some(selection)))
}

/// Keys in defaults.json that are not settings, on purpose: the engine fixes them, or they only describe the file.
/// docs/guide/configuration.md says which is which.
pub const INFORMATIONAL: &[&str] = &[
    "schema_version",
    "seed",
    "playback.checkpoint_virtual_seconds",
    "map.source",
    "map.on_demand",
    "map.min_nodes",
    "map.max_anchor_attempts",
    "map.min_compactness",
    "map.map_selection_version",
    "bus_stops",
    "traffic",
    "dws.min_start_gap_playback_seconds",
    "dws.min_duration_virtual_min",
    "dws.max_duration_virtual_min",
    "logging",
    "ui.port",
    "ui.osm_background",
    // Launchers 3.1 to 3.6 kept the chosen engine here; it moves to config/engines.json the first time it is read.
    "engine.implementation",
];

/// Every editable setting, by category, in the order the configuration screen shows them.
pub fn fields() -> &'static [Field] {
    use FieldKind::*;
    static FIELDS: std::sync::OnceLock<Vec<Field>> = std::sync::OnceLock::new();
    FIELDS.get_or_init(|| {
        vec![
            // Run
            Field::new("day", "Day type", "Run", Choice, "Which demand profile the day follows: a working weekday, or a weekend's later, flatter one. --day-type overrides it for a run.", json!(0))
                .choices(vec![("weekday", json!(0)), ("weekend", json!(1))]),
            Field::new("playback.duration_seconds", "Length of a day", "Run", Integer, "Wall-clock seconds one simulated day lasts at 1× speed. 3600 plays a day in an hour.", json!(3600))
                .unit("seconds")
                .range(60.0, Some(3600.0)),
            Field::new("playback.tick_rate", "Starting speed", "Run", Number, "How fast a run plays when it starts, as a multiple of the length of a day. The observer changes it while it runs.", json!(1.0)).unit("×").range(0.0, Some(MAX_TICK_RATE)).above(),
            // Map
            // Engine
            Field::new("engines.selected", "Engine", "Engine", Choice, "Which engine builds and runs each world. core-legacy is the engine DSTNS has always used; core-ng is its next-generation replacement, built beside it, which gives the same world for the same seed and can also limit worlds to chosen countries or cities.", json!("core-legacy"))
                .choices(vec![("core-legacy", json!("core-legacy")), ("core-ng (next generation)", json!("core-ng"))]).extra(selected_enabled),
            Field::new("engines.auto_switch", "When a run is rejected", "Engine", Choice, "What the observer offers when a person rejects the risk of an alpha or beta engine: to start the same seed (only the seed) on an enabled stable engine, or only to stop.", json!("offer"))
                .choices(vec![("Offer a stable engine", json!("offer")), ("Only stop", json!("off"))]),
            Field::new("engines.engines.core-ng.enabled", "core-ng available", "Engine", Boolean, "Off, core-ng stays installed but nothing can start a run on it.", json!(true)),
            Field::new("engines.engines.core-ng.acknowledgment.enforce", "core-ng: hold runs until acknowledged", "Engine", Boolean, "core-ng is alpha. On, every run on it waits until a person accepts the risk, and the server defers anything that would run it (for applications and the API too). Off removes that protection: runs start at once, and the observer asks nothing.", json!(true)),
            Field::new("engines.engines.core-ng.acknowledgment.ui", "core-ng: acknowledge in the observer", "Engine", Boolean, "On, the observer asks a person to accept or reject. Off while runs are still held, the launcher asks instead: start with --accept-risk. Turning holding off turns this off.", json!(true)),
            Field::new("engines.engines.core-legacy.enabled", "core-legacy available", "Engine", Boolean, "core-legacy is the default engine, so it cannot be turned off.", json!(true)).extra(default_engine_stays),
            Field::new("map.selection_mode", "Where worlds are", "Engine", Choice, "Which cities a seed may choose: every city in the catalogue (the same city for a seed as always), only the countries or cities in Places, or always the one city in Places. With every city, anything listed in Places still applies: two-letter codes are countries, other names cities. Anything but every city needs core-ng, which this turns on.", json!("global"))
                .choices(vec![("Every city", json!("global")), ("Countries", json!("countries")), ("Cities", json!("cities")), ("One city", json!("fixed_city"))]),
            Field::new("map.places", "Places", "Engine", Text, "Countries (two-letter codes, such as IN, AE) or cities (IDs, such as mumbai, new-york), separated by commas. A - before one leaves it out: -IN is everywhere but India; IN, AE, -dubai is India and the UAE but not Dubai. all when worlds may be anywhere. Needs core-ng.", json!("all")).extra(places),
            // SUMO
            Field::new("sumo.enabled", "SUMO", "SUMO", Boolean, "Eclipse SUMO, for exporting a world and running it microscopically (POST /api/v1/export/sumo and /api/v1/system/sumo-simulate). Off, the server refuses both and does not look for SUMO.", json!(false)),
            Field::new("sumo.home", "SUMO folder", "SUMO", Text, "Where SUMO is installed (its SUMO_HOME). auto looks in SUMO_HOME, ~/sumo, Homebrew and the system's folders.", json!("auto")),
            Field::new("map.max_nodes", "Largest network", "Map", Integer, "The most junctions a district's road network may have. Lower keeps big cities light.", json!(50000)).unit("junctions").range(2.0, Some(50000.0)),
            Field::new("map.city_extent_m", "City extract", "Map", Integer, "The side of the square of city downloaded around a seed's anchor. Larger holds more of the city and takes longer to download; the default is the one every seed's city was chosen with.", json!(5000)).unit("m").range(500.0, Some(20000.0)),
            Field::new("map.district_nodes", "District size", "Map", Integer, "How many junctions the district grown from the anchor aims for, within the extract.", json!(3000)).unit("junctions").range(200.0, Some(50000.0)),
            Field::new("map.cache_policy", "Map cache at start", "Map", Choice, "What the server does with the map cache as it starts: keep every city, prune to the most recent few, or clear it.", json!("prune"))
                .choices(vec![("Prune", json!("prune")), ("Keep", json!("keep")), ("Clear", json!("clear"))]),
            Field::new("map.cache_keep", "Cities kept when pruning", "Map", Integer, "How many of the most recently used cities pruning keeps.", json!(1)).unit("cities").range(0.0, Some(1000.0)),
            Field::new("map.download_stall_s", "Download stall limit", "Map", Integer, "How long a map download may receive nothing before it is given up and the next server is tried.", json!(200)).unit("s").range(10.0, Some(3600.0)),
            Field::new("map.cache_dir", "Map cache folder", "Map", Text, "Where downloaded city extracts are kept, relative to the checkout. Dynamic Fastboot's next city is kept here too.", json!("data/maps")),
            // Modules
            Field::new("modules.traffic", "Traffic demand", "Modules", Boolean, "Base and hotspot demand on every road. Off, the roads stay empty.", json!(true)),
            Field::new("modules.signals", "Signal timing", "Modules", Boolean, "Signal controllers at junctions, each on its own schedule.", json!(true)),
            Field::new("modules.buildings", "Places and trips", "Modules", Boolean, "Demand drawn by schools, offices, shops and other places.", json!(true)),
            Field::new("modules.dws", "Weather", "Modules", Boolean, "Rain cells, scheduled and called up by hand.", json!(true)),
            Field::new("modules.flooding", "Flooding", "Modules", Boolean, "Standing water on low roads under rain, and the closures it causes.", json!(true)),
            Field::new("modules.news", "News feed", "Modules", Boolean, "A running feed of what happens in the district.", json!(true)),
            // Weather
            Field::new("dws.frequency", "Storms a day", "Weather", Integer, "How many storms are scheduled across a simulated day. 0 leaves only those called up by hand.", json!(3))
                .unit("storms")
                .range(0.0, None)
                .extra(dws_spacing),
            // Launcher
            Field::new(
                "launcher.default_settings",
                "Observer at its defaults",
                "Launcher",
                Boolean,
                "Every launch opens the observer with its own settings back at their defaults, forgetting what this browser chose. --default-settings does it once.",
                json!(false),
            ),
            Field::new("launcher.command_bar", "Command bar", "Launcher", Boolean, "The prompt at the foot of the terminal interface, where commands are typed as in a shell, joined with | && || and ;. : or / goes to it.", json!(true)),
            Field::new("launcher.scroll_lines", "Scroll speed", "Launcher", Integer, "How many lines one notch of the mouse wheel or trackpad scrolls a list or the command output.", json!(3)).unit("lines").range(1.0, Some(20.0)),
            Field::new("launcher.natural_scrolling", "Natural scrolling", "Launcher", Boolean, "Content moves the way the fingers do, as on a Mac's trackpad. Off, the wheel moves the view instead.", json!(false)),
            Field::new("launcher.small_terminal", "Small terminals", "Launcher", Choice, "What happens when the terminal is too small for the full interface: ask (Simplified Launch Control, or leave), always use Simplified Launch Control, or show the full interface anyway.", json!("ask"))
                .choices(vec![("Ask", json!("ask")), ("Simplified", json!("simplified")), ("Full anyway", json!("full"))]),
            // Server
            Field::new("api.host", "Listen address", "Server", Text, "127.0.0.1 keeps the server to this machine; 0.0.0.0 opens it to the network, which needs a gateway in front (see Deployment).", json!("127.0.0.1")),
            Field::new("api.allowed_hosts", "Other host names", "Server", Text, "Host names besides localhost that may reach a server on this machine, separated by commas (DNS rebinding protection refuses the rest). none for none.", json!("none")),
            Field::new("api.allowed_origins", "Other origins", "Server", Text, "Web origins besides the server's own that may change things, separated by commas, such as https://example.org. none for none.", json!("none")),
            Field::new("api.port", "Port", "Server", Integer, "The port to listen on. If it is taken, the next free one is used, and the launcher says which.", json!(8090)).range(1.0, Some(65535.0)),
            Field::new(
                "narration.mode",
                "Realistic News",
                "Server",
                Text,
                "Who writes the news: auto uses Apple Foundation Models where this Mac has them, else a model server on this machine (Ollama, LM Studio), never a cloud provider; model uses the launcher's own model, cloud providers included (each news item is a request); fm insists on Apple's; off keeps the plain wording; or give a Chat Completions endpoint (http://HOST:PORT, unix:/PATH). --narrator overrides it.",
                json!("auto"),
            )
            .extra(narration_mode),
            // Fabric
            Field::new("fabric.applications", "Applications may connect", "Fabric", Boolean, "Programs may register through the Fabric API. Off, nothing can, and WebFabric is off too.", json!(true)),
            Field::new("fabric.legacy_api", "Legacy routes", "Fabric", Boolean, "The older /playback and /control routes still answer. They take no credential, so turning them off leaves only the Fabric API.", json!(true)),
            Field::new("fabric.launch_proposals", "Launch proposals", "Fabric", Boolean, "Applications may propose how to start them, for a person to read and approve here.", json!(true)),
            Field::new("fabric.require_signatures", "Signed requests only", "Fabric", Boolean, "Every application must sign every request with its key (HMAC-SHA-256), not only present its token.", json!(false)),
            Field::new("fabric.world_regeneration", "New worlds from the observer", "Fabric", Boolean, "A person in the observer may ask for a new world. The seed is still the server's choice.", json!(true)),
            Field::new("fabric.allow_frames", "Embedded pages", "Fabric", Boolean, "Applications may show a page of their own inside the observer, sandboxed, from the origins they declare.", json!(true)),
            Field::new("fabric.allow_dialogs", "Dialogs", "Fabric", Boolean, "Applications may ask a person a question in a dialog.", json!(true)),
            Field::new("fabric.allow_camera", "Camera direction", "Fabric", Boolean, "Applications may ask the map to look somewhere, once a person allows it.", json!(true)),
            Field::new("fabric.allow_layers", "Layer control", "Fabric", Boolean, "Applications may hold map layers and places on or off, once a person allows it.", json!(true)),
            Field::new("fabric.allow_control", "Simulation control", "Fabric", Boolean, "Applications may play, pause, seek and change the run, once a person allows it. Every action is on the audit log.", json!(true)),
            Field::new("fabric.allow_notifications", "Notifications", "Fabric", Boolean, "Applications may send notifications, within a rate limit.", json!(true)),
            Field::new("fabric.allow_messages", "Messages between applications", "Fabric", Boolean, "Applications may send each other messages.", json!(true)),
            Field::new("fabric.allow_storage", "Storage", "Fabric", Boolean, "Applications may keep a little data of their own across restarts.", json!(true)),
            // WebFabric
            Field::new("webfabric.enabled", "WebFabric", "WebFabric", Boolean, "Applications' panels, controls and overlays appear in the observer. Off, they can still connect, but nothing of theirs is shown.", json!(true)),
            // Startup
            Field::new(
                "startup.dynamic_fastboot",
                "Dynamic Fastboot",
                "Startup",
                Boolean,
                "While a world runs, the next one is chosen, in another city, and its map fetched in the background. A new world, or the next start, then takes seconds; only the first ever start downloads while you wait.",
                json!(true),
            ),
            Field::new(
                "startup.dynamic_particles",
                "Adaptive start-up film",
                "Startup",
                Boolean,
                "The film plans itself by the server's estimate of when the world will be ready: as many scenes as fit, in a new order, then straight to the map. Turns Play the whole film off.",
                json!(true),
            ),
            Field::new(
                "startup.fast_boot",
                "Fast Boot",
                "Startup",
                Boolean,
                "Use every city downloaded in advance (./launcher fastboot download), and open with the name alone. Turns Play the whole film off.",
                json!(false),
            ),
            Field::new(
                "startup.force_animate",
                "Play the whole film",
                "Startup",
                Boolean,
                "Every scene of the start-up film plays before the map, even when the world is ready sooner. Turns the adaptive film and Fast Boot off.",
                json!(false),
            ),
            // Presentation
            Field::new("presentation.music", "Music", "Presentation", Boolean, "An original score while the start-up film plays, with a button to mute it.", json!(false)),
            Field::new("presentation.fullscreen", "Full screen", "Presentation", Boolean, "Open the observer full screen, in a window of its own.", json!(false)),
            Field::new("presentation.music_volume", "Music volume", "Presentation", Number, "From 0 (silent) to 1.", json!(0.6)).range(0.0, Some(1.0)).extra(volume),
            Field::new("presentation.music_file", "Music file", "Presentation", Text, "What the start-up film plays: score for the written score, or an MP3, M4A or WAV file (a path in this checkout, or an absolute one).", json!("score")).extra(music),
            // Demo
            Field::new("demo.music", "Music in Demo Mode", "Demo", Boolean, "Demo Mode plays its score. --no-music turns it off once.", json!(true)),
            Field::new("demo.music_file", "Demo Mode music file", "Demo", Text, "What Demo Mode plays: score for the written score, or an MP3, M4A or WAV file.", json!("score")).extra(music),
            Field::new("demo.fullscreen", "Full screen in Demo Mode", "Demo", Boolean, "Demo Mode opens full screen. --no-fullscreen opens it in a window once.", json!(true)),
            Field::new(
                "demo.scenes",
                "Demo scenes and order",
                "Demo",
                Text,
                "Which scenes Demo Mode plays, and in what order. Space turns one on or off, Shift+↑↓ moves it. The name always opens the loop. As text: ids separated by commas.",
                json!(DEMO_SCENES.join(", ")),
            )
            .extra(demo_scenes),
            // Performance
            Field::new("performance.compression", "Compression", "Performance", Choice, "How hard the server compresses large replies. Fast costs least processor time; small saves bytes on a slow link; off sends them as they are.", json!("fast"))
                .choices(vec![("Fast", json!("fast")), ("Balanced", json!("balanced")), ("Small", json!("small")), ("Off", json!("off"))]),
            Field::new("performance.api_threads", "Request threads", "Performance", Integer, "How many requests the server answers at once. 0 lets it choose from the processor count.", json!(0)).range(0.0, Some(256.0)),
            Field::new("performance.engine_threads", "Snapshot threads", "Performance", Integer, "Threads that write a large snapshot in parallel. 0 lets it choose; 1 keeps it to one.", json!(0)).range(0.0, Some(64.0)),
            Field::new("performance.map_fps", "Map frame rate", "Performance", Choice, "How often the map's moving traffic is redrawn. Automatic drops to 30 a second when the map struggles.", json!(0))
                .choices(vec![("Automatic", json!(0)), ("60 a second", json!(60)), ("30 a second", json!(30))]),
            Field::new("performance.render_scale", "Render scale", "Performance", Number, "The most pixels the map draws per point on a high-density screen. Lower is lighter on the graphics processor.", json!(2)).range(0.5, Some(3.0)),
            Field::new("performance.film_particles", "Film particles", "Performance", Integer, "How many particles the start-up film draws. Fewer is lighter; a struggling page draws fewer by itself.", json!(32000)).range(4000.0, Some(32000.0)),
            // MCP
            Field::new(
                "mcp.enabled",
                "MCP Handler",
                "MCP",
                Boolean,
                "An AI client may connect through the Model Context Protocol (./launcher mcp serve) and read. No agent is included: this opens the door, which is closed by default.",
                json!(false),
            ),
            Field::new("mcp.allow_writes", "AI may change things", "MCP", Boolean, "An AI client may call routes that change the simulation (POST, PUT, DELETE). Turns the MCP Handler on.", json!(false)),
            Field::new("mcp.allow_launcher", "AI may start and stop runs", "MCP", Boolean, "An AI client may start and stop simulations and change settings through the launcher. Turns the MCP Handler on.", json!(false)),
            // The launcher's own model, for commands asked for in plain words
            Field::new("model.provider", "Model", "Model", Choice, "Which model answers requests in plain words, here and wherever DSTNS asks one. Automatic uses Apple's Foundation Models where this Mac has them; else a model server on this machine (Ollama, LM Studio); else each cloud provider with a key (model key PROVIDER KEY) in turn.", json!("auto"))
                .choices(vec![
                    ("Automatic", json!("auto")),
                    ("Apple Foundation Models", json!("apple")),
                    ("Ollama", json!("ollama")),
                    ("LM Studio", json!("lmstudio")),
                    ("Anthropic", json!("anthropic")),
                    ("OpenAI", json!("openai")),
                    ("Google Gemini", json!("gemini")),
                    ("Groq", json!("groq")),
                    ("Mistral", json!("mistral")),
                    ("OpenRouter", json!("openrouter")),
                    ("Hugging Face", json!("huggingface")),
                    ("Another Chat Completions server", json!("custom")),
                    ("Off", json!("off")),
                ]),
            Field::new("model.name", "Model name", "Model", Text, "Which model of the chosen provider (model list shows them). default uses each provider's own.", json!("default")),
            Field::new("model.base_url", "Provider address", "Model", Text, "Where the chosen provider answers, for a server of your own or a regional endpoint; needed for Another Chat Completions server. default uses the provider's own.", json!("default")),
            Field::new("model.ollama_url", "Ollama address", "Model", Text, "Where Ollama answers.", json!("http://127.0.0.1:11434")),
            Field::new("model.apple_cloud", "Private Cloud Compute", "Model", Boolean, "When Apple's model on this Mac cannot answer, use Apple's larger model through Private Cloud Compute (macOS 27 or later). Requests leave the Mac for Apple's servers, which keep nothing.", json!(true)),
            Field::new("model.key_store", "Where keys are kept", "Model", Choice, "Where model key keeps a provider's API key: config/launcher.env on this machine, or the system's credential store (macOS Keychain, Windows Credential Manager, Secret Service on Linux). Keys in the environment are always read too.", json!("env"))
                .choices(vec![("config/launcher.env", json!("env")), ("System credential store", json!("system"))]),
            Field::new("worlds.keep_history", "Keep history across worlds", "Run", Boolean, "Off, a new world starts clean: the observer's notification history and the launcher's conversation with its model begin again, as the report and its list of jumps always do. On, both carry over from one world to the next.", json!(false)),
            Field::new("assist.enabled", "Answers for other programs", "Model", Boolean, "Other programs may ask about DSTNS too: the MCP tool dstns_ask (when the MCP Handler is on) and POST /v1/assist on CoreAI's service. Answers only inform; nothing is run or changed. The command bar and ask always answer.", json!(true)),
            Field::new("model.timeout_seconds", "Model time limit", "Model", Integer, "How long to wait for a model's answer before trying the next or giving up.", json!(60)).range(5.0, Some(600.0)),
            // The daemons, inside the server
            Field::new("daemon.enabled", "Daemons", "Daemons", Boolean, "Small watchers inside the server: the Resource Control Subsystem, memory, disk, a stalled run, and the cache handler. They say what they notice in the launcher and the observer, and on the daemon queues for applications.", json!(true)),
            Field::new("daemon.sustain_s", "Hold before alerting", "Daemons", Number, "How long a condition must hold before a daemon says anything, so that a brief spike is not an alarm.", json!(5)).unit("s").range(0.0, Some(300.0)),
            Field::new("daemon.rcs", "Resource Control Subsystem", "Daemons", Boolean, "Each module's memory and processor against its α, β and γ (Resource Control).", json!(true)),
            Field::new("daemon.memory", "Memory watch", "Daemons", Boolean, "The machine's available memory: a warning when it is low, an emergency when it is critical.", json!(true)),
            Field::new("daemon.disk", "Disk watch", "Daemons", Boolean, "Free space where the logs and maps are kept.", json!(true)),
            Field::new("daemon.stall", "Stall watch", "Daemons", Boolean, "A run that should be running but whose clock has stopped.", json!(true)),
            Field::new("daemon.cache", "Auto cache handler", "Daemons", Boolean, "Clears what nothing needs: old cities beyond the cache's budget, abandoned downloads, stray files. Never the running world's city or the next one.", json!(true)),
            Field::new("cache.max_mib", "Map cache budget", "Daemons", Integer, "The most the map cache may hold; the cities least recently used go first.", json!(2048)).unit("MiB").range(0.0, Some(1048576.0)),
            Field::new("cache.interval_min", "Cache sweep every", "Daemons", Integer, "How often the cache handler looks; it also looks at once when disk space is low.", json!(10)).unit("min").range(1.0, Some(1440.0)),
            // The Resource Control Subsystem's lines, α, β and γ, for each module
            Field::new("rcs.engine.memory", "Engine memory", "Resource Control", Text, "α, β, γ in MiB: the least the engine should use while it works, where it is using a lot (a warning), and the most it ever should (an alert).", json!("4, 2048, 4096")).extra(rcs_lines),
            Field::new("rcs.engine.cpu", "Engine processor", "Resource Control", Text, "α, β, γ as a percentage of one core. Below α while the run is running, something may be wrong.", json!("0.2, 180, 380")).extra(rcs_lines),
            Field::new("rcs.downloads.memory", "Map downloads memory", "Resource Control", Text, "α, β, γ in MiB, for the map downloads while they run.", json!("0, 768, 2048")).extra(rcs_lines),
            Field::new("rcs.downloads.cpu", "Map downloads processor", "Resource Control", Text, "α, β, γ as a percentage of one core.", json!("0, 150, 300")).extra(rcs_lines),
            Field::new("rcs.launcher.memory", "Launcher memory", "Resource Control", Text, "α, β, γ in MiB, for this launcher.", json!("1, 256, 1024")).extra(rcs_lines),
            Field::new("rcs.launcher.cpu", "Launcher processor", "Resource Control", Text, "α, β, γ as a percentage of one core.", json!("0, 60, 150")).extra(rcs_lines),
            Field::new("rcs.applications.memory", "Applications memory", "Resource Control", Text, "α, β, γ in MiB, for the applications this launcher starts, together.", json!("0, 1024, 4096")).extra(rcs_lines),
            Field::new("rcs.applications.cpu", "Applications processor", "Resource Control", Text, "α, β, γ as a percentage of one core, together.", json!("0, 200, 400")).extra(rcs_lines),
            // Security
            Field::new(
                KEY_ADVANCED_SECURITY,
                "Advanced Security",
                "Security",
                Boolean,
                "The launcher asks for Touch ID or your system password as it opens, and before any single command that changes something. No program can change the launcher or the engine through the MCP Handler. Turning it off asks again.",
                json!(false),
            ),
            // ---- The observer's operator defaults, kept in config/ui-config.json (see load and save) ----
            // Appearance
            Field::new("ui.accessibility.theme", "Theme", "Appearance", Choice, "Dark, light, or following each viewer's system. A viewer's own choice in their browser comes first.", json!("system"))
                .choices(vec![("Follow the system", json!("system")), ("Dark", json!("dark")), ("Light", json!("light"))]),
            Field::new("ui.accessibility.color_vision", "Colour vision", "Appearance", Choice, "Palettes for road and severity colours that do not rely on telling red from green, or blue from yellow.", json!("standard"))
                .choices(vec![("Standard", json!("standard")), ("Protanopia", json!("protanopia")), ("Deuteranopia", json!("deuteranopia")), ("Tritanopia", json!("tritanopia")), ("Monochrome", json!("monochrome"))]),
            Field::new("ui.reduce_motion", "Reduce motion", "Appearance", Choice, "Short fades instead of movement. Following the system uses each viewer's own setting.", json!("auto"))
                .choices(vec![("Follow the system", json!("auto")), ("On", json!("on")), ("Off", json!("off"))]),
            Field::new("ui.accessibility.reduce_transparency", "Reduce transparency", "Appearance", Boolean, "Solid surfaces instead of glass.", json!(false)),
            Field::new("ui.accessibility.high_contrast", "High contrast", "Appearance", Boolean, "Text at full strength, firmer edges and outlines.", json!(false)),
            Field::new("ui.accessibility.advanced", "Specialist detail", "Appearance", Boolean, "Off, measures meant for specialists (identifiers, hashes, coordinates) give way to plain language.", json!(true)),
            // Notifications
            Field::new("ui.notifications.enabled", "Notifications", "Notifications", Boolean, "What happens in the simulation appears over the map as it happens.", json!(true)),
            Field::new("ui.notifications.dnd", "Do Not Disturb", "Notifications", Boolean, "Notifications are kept in history without being shown.", json!(false)),
            Field::new("ui.notifications.important_first", "Important first", "Notifications", Boolean, "An alert goes ahead of what is waiting to be shown.", json!(true)),
            Field::new("ui.notifications.max_visible", "Shown at once", "Notifications", Integer, "How many notifications the capsule holds before it groups the rest.", json!(3)).range(1.0, Some(8.0)),
            Field::new("ui.notifications.dwell_ms", "Shown for", "Notifications", Integer, "How long a notification stays before it gives way.", json!(7000)).unit("ms").range(1000.0, Some(60000.0)),
            // Auto Focus
            Field::new("ui.auto_focus.mode", "Auto Focus", "Auto Focus", Choice, "Whether the camera follows what matters: offered once per run, on, or off.", json!("enable-force"))
                .choices(vec![("On", json!("enable-force")), ("Offer once per run", json!("enable")), ("Off", json!("disable"))]),
            Field::new("ui.auto_focus.strategy", "Order", "Auto Focus", Choice, "Which event the camera shows: each in turn, or always the latest.", json!("round-robin"))
                .choices(vec![("Each in turn", json!("round-robin")), ("The latest", json!("latest"))]),
            Field::new("ui.auto_focus.dwell_seconds", "Stays for", "Auto Focus", Number, "How long the camera stays on one event before the next, in turn.", json!(9)).unit("s").range(2.0, Some(120.0)),
            Field::new("ui.auto_focus.zoom", "Closeness", "Auto Focus", Number, "How close the camera goes to an event: 1 frames it, more goes closer.", json!(1.6)).unit("×").range(0.2, Some(8.0)),
            // Playback controls
            Field::new("ui.playback.skip_seconds", "Back and Forward jump", "Playback controls", Choice, "How far the observer's Back and Forward buttons, and J and L, go.", json!(900))
                .choices(vec![("1 minute", json!(60)), ("5 minutes", json!(300)), ("15 minutes", json!(900)), ("30 minutes", json!(1800)), ("1 hour", json!(3600))]),
            Field::new("ui.playback.step_seconds", "Step", "Playback controls", Choice, "How far Step, and K, advance before holding.", json!(60))
                .choices(vec![("1 second", json!(1)), ("10 seconds", json!(10)), ("1 minute", json!(60)), ("5 minutes", json!(300))]),
            Field::new("ui.playback.fine_control", "Ask how far", "Playback controls", Boolean, "Back and Forward open a menu of distances each time, instead of one jump.", json!(false)),
            // Clock and units
            Field::new("ui.clock.hour12", "12-hour clock", "Clock, units and news", Boolean, "Times as 3:00 PM instead of 15:00. Holding the clock switches it at any time.", json!(false)),
            Field::new("ui.display.byte_units", "Data sizes", "Clock, units and news", Choice, "Decimal (kB, MB, as drives are sold) or binary (KiB, MiB, as memory is counted).", json!("decimal"))
                .choices(vec![("Decimal (MB)", json!("decimal")), ("Binary (MiB)", json!("binary"))]),
            Field::new("ui.news.style", "News style", "Clock, units and news", Choice, "Realistic News, written by a model where one is available, or the standard plain lines.", json!("realistic"))
                .choices(vec![("Realistic", json!("realistic")), ("Standard", json!("standard"))]),
            // Map layers shown at first
            Field::new("ui.layers.roads", "Roads", "Map layers", Boolean, "Shown when a viewer first opens the observer; each can change their own.", json!(true)),
            Field::new("ui.layers.traffic", "Traffic", "Map layers", Boolean, "Roads coloured by how congested they are.", json!(true)),
            Field::new("ui.layers.vehicles", "Flow markers", "Map layers", Boolean, "Vehicles moving along the roads.", json!(true)),
            Field::new("ui.layers.signals", "Signals", "Map layers", Boolean, "Signalled junctions and their phases.", json!(true)),
            Field::new("ui.layers.buildings", "Buildings and places", "Map layers", Boolean, "Footprints, and the places that draw traffic.", json!(true)),
            Field::new("ui.layers.place_names", "Place names", "Map layers", Boolean, "Names beside places, as there is room.", json!(false)),
            Field::new("ui.layers.other_places", "Unclassified places", "Map layers", Boolean, "Places with no kind of their own.", json!(false)),
            Field::new("ui.layers.labels", "Street names", "Map layers", Boolean, "Names along the roads.", json!(false)),
            Field::new("ui.layers.weather", "Weather", "Map layers", Boolean, "Rain cells as they cross the district.", json!(true)),
            Field::new("ui.layers.flooding", "Flooding", "Map layers", Boolean, "Roads under water.", json!(true)),
            Field::new("ui.layers.incidents", "Incidents", "Map layers", Boolean, "Collisions, breakdowns and closures.", json!(true)),
            Field::new("ui.layers.events", "Demand", "Map layers", Boolean, "Places drawing extra traffic now.", json!(true)),
            // Tutorial
            Field::new("ui.tutorial.enabled", "Tutorial", "Tutorial", Boolean, "The guided tour is offered from the header.", json!(true)),
            Field::new("ui.tutorial.show_on_startup", "Show at start-up", "Tutorial", Boolean, "The tour opens by itself, once, when a viewer first arrives.", json!(false)),
            // Backpressure reporting
            Field::new("ui.asb.enabled", "Report how it keeps up", "Backpressure", Boolean, "The observer tells the server how far behind it is, so Adaptive Simulation Backpressure can ease the rate before it falls behind.", json!(true)),
            Field::new("ui.asb.report_interval_ms", "Report every", "Backpressure", Integer, "How often it reports.", json!(1000)).unit("ms").range(250.0, Some(10000.0)),
        ]
    })
}

/// The settings as a person finds them: sections, each a heading over its categories, in a sensible order.
pub const SECTIONS: &[(&str, &[&str])] = &[
    ("Simulation", &["Run", "Engine", "Modules", "Weather", "Map", "SUMO"]),
    ("Start-up", &["Startup", "Presentation", "Demo"]),
    ("Observer", &["Appearance", "Notifications", "Auto Focus", "Playback controls", "Clock, units and news", "Map layers", "Tutorial", "Backpressure"]),
    ("Server", &["Server", "Performance", "Resource Control", "Daemons"]),
    ("Applications", &["Fabric", "WebFabric", "MCP"]),
    ("Intelligence", &["Model"]),
    ("Launcher", &["Launcher", "Security"]),
];

/// Where a category belongs: its section's name.
pub fn section_of(category: &str) -> &'static str {
    SECTIONS.iter().find(|(_, categories)| categories.contains(&category)).map(|(name, _)| *name).unwrap_or("Other")
}

/// α, β, γ: three numbers, each at least the one before.
pub fn rcs_triple(value: &Value) -> Option<[f64; 3]> {
    let parts: Vec<f64> = value.as_str()?.split(',').map(|p| p.trim().parse::<f64>()).collect::<std::result::Result<_, _>>().ok()?;
    match parts.as_slice() {
        [a, b, g] if *a >= 0.0 && a <= b && b <= g => Some([*a, *b, *g]),
        _ => None,
    }
}

fn rcs_lines(value: &Value, _config: &Value) -> String {
    if rcs_triple(value).is_some() {
        String::new()
    } else {
        "Write α, β and γ as three numbers, each at least the one before, such as 4, 2048, 4096.".into()
    }
}

/// The daemons' settings, for the server.
pub fn daemon_settings(config: &Value) -> Value {
    let mut modules = serde_json::Map::new();
    for module in ["engine", "downloads", "launcher", "applications"] {
        let line = |metric: &str| rcs_triple(&setting(config, &format!("rcs.{module}.{metric}"))).map(|t| json!(t)).unwrap_or(Value::Null);
        modules.insert(module.into(), json!({"memory_mib": line("memory"), "cpu_percent": line("cpu")}));
    }
    json!({
        "enabled": flag(config, "daemon.enabled"),
        "sustain_s": as_number(&setting(config, "daemon.sustain_s")).unwrap_or(5.0),
        "daemons": {"rcs": flag(config, "daemon.rcs"), "memory": flag(config, "daemon.memory"), "disk": flag(config, "daemon.disk"), "stall": flag(config, "daemon.stall"), "cache": flag(config, "daemon.cache")},
        "rcs": {"modules": modules},
        "cache": {"interval_s": as_int(&setting(config, "cache.interval_min")).unwrap_or(10) * 60, "max_mib": as_int(&setting(config, "cache.max_mib")).unwrap_or(2048)},
    })
}

pub fn categories() -> Vec<&'static str> {
    // In the order of their sections, then any a section does not name, so none is ever hidden.
    let mut out: Vec<&'static str> = SECTIONS.iter().flat_map(|(_, c)| c.iter().copied()).filter(|c| fields().iter().any(|f| f.category == *c)).collect();
    for field in fields() {
        if !out.contains(&field.category) {
            out.push(field.category);
        }
    }
    out
}

pub fn field(key: &str) -> Option<&'static Field> {
    fields().iter().find(|f| f.key == key)
}

pub fn setting(config: &Value, key: &str) -> Value {
    field(key).map(|f| f.get(config)).unwrap_or(Value::Null)
}

pub fn flag(config: &Value, key: &str) -> bool {
    setting(config, key).as_bool().unwrap_or(false)
}

pub fn check_field(field: &Field, value: &Value, config: &Value) -> String {
    let problem = field.check(value);
    if problem.is_empty() {
        if let Some(extra) = field.extra {
            return extra(value, config);
        }
    }
    problem
}

/// Which switch turns off which capabilities.
const CAPABILITIES: &[(&str, &[&str])] = &[
    ("fabric.allow_frames", &["ui.frames"]),
    ("fabric.allow_dialogs", &["ui.dialogs"]),
    ("fabric.allow_camera", &["ui.camera"]),
    ("fabric.allow_layers", &["ui.layers"]),
    ("fabric.allow_control", &["control.playback", "control.events", "control.world"]),
    ("fabric.allow_notifications", &["ui.notifications"]),
    ("fabric.allow_messages", &["apps.messages"]),
    ("fabric.allow_storage", &["storage"]),
];

/// Settings that cannot be on together, or that need another: when the first becomes the value, the other becomes its
/// value too, each written as JSON. The interface and `config set` say what else changed.
pub const RULES: &[(&str, &str, &str, &str)] = &[
    // The dynamic film plans its own length; the whole film plays every scene. One or the other.
    ("startup.dynamic_particles", "true", "startup.force_animate", "false"),
    ("startup.force_animate", "true", "startup.dynamic_particles", "false"),
    // Fast Boot opens with the name alone, which the whole film would undo.
    ("startup.fast_boot", "true", "startup.force_animate", "false"),
    ("startup.force_animate", "true", "startup.fast_boot", "false"),
    // What an AI client may do needs the MCP Handler to be on at all.
    ("mcp.allow_writes", "true", "mcp.enabled", "true"),
    ("mcp.allow_launcher", "true", "mcp.enabled", "true"),
    ("mcp.enabled", "false", "mcp.allow_writes", "false"),
    ("mcp.enabled", "false", "mcp.allow_launcher", "false"),
    // Applications that may not connect cannot appear in the observer either.
    ("fabric.applications", "false", "webfabric.enabled", "false"),
    ("webfabric.enabled", "true", "fabric.applications", "true"),
    // Only core-ng chooses among countries or cities; core-legacy draws from every city.
    ("map.selection_mode", "\"countries\"", "engines.selected", "\"core-ng\""),
    ("map.selection_mode", "\"cities\"", "engines.selected", "\"core-ng\""),
    ("map.selection_mode", "\"fixed_city\"", "engines.selected", "\"core-ng\""),
    ("engines.selected", "\"core-legacy\"", "map.selection_mode", "\"global\""),
    ("engines.selected", "\"core-legacy\"", "map.places", "\"all\""),
    // Nothing held means nothing to acknowledge.
    ("engines.engines.core-ng.acknowledgment.enforce", "false", "engines.engines.core-ng.acknowledgment.ui", "false"),
];

/// How the observer should present itself, as the server will tell it.
pub fn presentation(config: &Value, demo: bool) -> Value {
    let fast = flag(config, "startup.fast_boot");
    json!({
        "webfabric": flag(config, "webfabric.enabled"),
        "fast_boot": fast,
        "force_animate": flag(config, "startup.force_animate") && !fast && !flag(config, "startup.dynamic_particles"),
        "dynamic_fastboot": flag(config, "startup.dynamic_fastboot"),
        "dynamic_particles": flag(config, "startup.dynamic_particles"),
        "demo": demo,
        "demo_scenes": demo_scene_list(config),
        "music": flag(config, if demo { "demo.music" } else { "presentation.music" }),
        "fullscreen": flag(config, if demo { "demo.fullscreen" } else { "presentation.fullscreen" }),
        "music_volume": as_number(&setting(config, "presentation.music_volume")).unwrap_or(0.6),
        "map_fps": as_int(&setting(config, "performance.map_fps")).unwrap_or(0),
        "render_scale": as_number(&setting(config, "performance.render_scale")).unwrap_or(2.0),
        "film_particles": as_int(&setting(config, "performance.film_particles")).unwrap_or(32000),
        "keep_history": flag(config, "worlds.keep_history"),
    })
}

/// The server's arguments that come from the settings.
pub fn server_arguments(config: &Value) -> Vec<String> {
    vec![
        "--map-cache".into(),
        setting(config, "map.cache_policy").as_str().unwrap_or("prune").to_string(),
        "--map-cache-keep".into(),
        as_int(&setting(config, "map.cache_keep")).unwrap_or(1).max(0).to_string(),
    ]
}

/// sumo.home, unless it is auto.
pub fn sumo_home(config: &Value) -> Option<String> {
    setting(config, "sumo.home").as_str().map(str::trim).filter(|h| !h.is_empty() && *h != "auto").map(String::from)
}

/// The environment that carries these settings to a server as it starts.
pub fn server_switches(config: &Value, demo: bool) -> Vec<(String, String)> {
    let one = |key: &str| if flag(config, key) { "1" } else { "0" }.to_string();
    let mut disabled: Vec<&str> = CAPABILITIES.iter().filter(|(key, _)| !flag(config, key)).flat_map(|(_, names)| names.iter().copied()).collect();
    disabled.sort();
    let mut env = vec![
        ("DSTNS_FABRIC_APPS".to_string(), one("fabric.applications")),
        ("DSTNS_LEGACY_API".to_string(), one("fabric.legacy_api")),
        ("DSTNS_LAUNCH_PROPOSALS".to_string(), one("fabric.launch_proposals")),
        ("DSTNS_REQUIRE_SIGNATURES".to_string(), one("fabric.require_signatures")),
        ("DSTNS_DISABLED_CAPABILITIES".to_string(), disabled.join(",")),
        ("DSTNS_PRESENTATION".to_string(), presentation(config, demo).to_string()),
        // The one file the server will play to the observer, or nothing.
        ("DSTNS_MUSIC_FILE".to_string(), music_file(setting(config, if demo { "demo.music_file" } else { "presentation.music_file" }).as_str().unwrap_or("")).ok().flatten().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
        ("DSTNS_DYNAMIC_FASTBOOT".to_string(), one("startup.dynamic_fastboot")),
        ("DSTNS_DAEMON".to_string(), daemon_settings(config).to_string()),
        ("DSTNS_SUMO".to_string(), one("sumo.enabled")),
        ("DSTNS_MAP_STALL_S".to_string(), as_int(&setting(config, "map.download_stall_s")).unwrap_or(200).to_string()),
    ];
    for (key, name) in [("api.allowed_hosts", "DSTNS_ALLOWED_HOSTS"), ("api.allowed_origins", "DSTNS_ALLOWED_ORIGINS")] {
        let list = setting(config, key).as_str().unwrap_or("none").trim().to_string();
        if !list.is_empty() && !list.eq_ignore_ascii_case("none") {
            env.push((name.into(), list.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(",")));
        }
    }
    if let Some(home) = sumo_home(config) {
        env.push(("SUMO_HOME".into(), home));
    }
    if !flag(config, "fabric.world_regeneration") {
        env.push(("DSTNS_DISABLE_WORLD_REGENERATION".into(), "1".into()));
    }
    env.push(("DSTNS_COMPRESSION".into(), setting(config, "performance.compression").as_str().unwrap_or("fast").to_string()));
    for (key, name) in [("performance.api_threads", "DSTNS_API_THREADS"), ("performance.engine_threads", "DSTNS_ENGINE_THREADS")] {
        if let Some(n) = as_int(&setting(config, key)).filter(|n| *n > 0) {
            env.push((name.into(), n.to_string()));
        }
    }
    env
}

// --- Run options and the start request -----------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct RunOptions {
    pub seed: Option<String>,
    pub saved_seed: Option<String>,
    pub save_seed: Option<String>,
    pub description: Option<String>,
    pub day_type: Option<String>,
    pub duration: Option<String>,
    pub speed: Option<String>,
    /// core-legacy or core-ng, for this run only; otherwise engines.selected.
    pub engine: Option<String>,
    pub max_nodes: Option<String>,
    pub osm_file: Option<String>,
    /// Applications to start with this run, by ID, comma separated. None: those set to start by themselves.
    pub apps: Option<String>,
    pub no_apps: bool,
    /// Accept an unstable engine's risk for this run (--accept-risk), instead of in the observer.
    pub accept_risk: bool,
    pub default_settings: bool,
}

impl RunOptions {
    pub fn explicit(&self) -> bool {
        [&self.seed, &self.saved_seed, &self.save_seed, &self.day_type, &self.osm_file, &self.max_nodes, &self.duration, &self.speed, &self.engine].iter().any(|v| v.is_some())
    }
}

/// A seed exactly as the engine and the observer show it: decimal.
pub fn normalise_seed(text: &str) -> Result<String> {
    let bad = || LauncherError::config("Seed must be a decimal integer or 0x hexadecimal, within 128 bits");
    let value: u128 = if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        if hex.is_empty() || hex.len() > 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(bad());
        }
        u128::from_str_radix(hex, 16).map_err(|_| bad())?
    } else {
        if text.is_empty() || text.len() > 39 || !text.chars().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        text.parse::<u128>().map_err(|_| LauncherError::config("Seed exceeds 128 bits"))?
    };
    Ok(value.to_string())
}

/// A new 64-bit seed: short enough to read off the screen and retype.
pub fn fresh_seed() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("the system's random source");
    u64::from_be_bytes(bytes).to_string()
}

/// The seed of the world Dynamic Fastboot prepared in this map cache, if there is one that a start from here can use.
/// The launcher starts worlds under urban-crfg-v3 over every city, with the engine's default 5 km extract, so a seed
/// prepared under another policy or extent (it would name a different city here), or in a pointer format newer than
/// 2, is left alone. A pointer from before policies were recorded is urban-crfg-v3.
pub fn prepared_seed(cache: &Path, extent_m: f64) -> Option<String> {
    let text = std::fs::read_to_string(cache.join("next-world.json")).ok()?;
    let pointer = serde_json::from_str::<Value>(&text).ok()?;
    if pointer.get("format").and_then(Value::as_u64).unwrap_or(1) > 2 {
        return None;
    }
    if pointer.get("extent_m").and_then(Value::as_f64).unwrap_or(5000.0) != extent_m {
        return None;
    }
    if let Some(selection) = pointer.get("selection") {
        let empty = |key: &str| selection.get(key).and_then(Value::as_array).is_none_or(|list| list.is_empty());
        let legacy = selection.get("policy").and_then(Value::as_str) == Some(MAP_SELECTION_VERSION)
            && selection.get("mode").and_then(Value::as_str).unwrap_or("global") == "global"
            && empty("countries")
            && empty("cities");
        if !legacy {
            return None;
        }
    }
    let seed = pointer.get("seed")?.as_str()?.to_string();
    (!seed.is_empty() && seed.chars().all(|c| c.is_ascii_digit())).then_some(seed)
}

/// The body of POST /api/v1/playback/start for these options.
pub fn start_request(options: &RunOptions, paths: &Paths) -> Result<Value> {
    if options.seed.is_some() && options.saved_seed.is_some() {
        return Err(LauncherError::config("--seed and --saved-seed are mutually exclusive"));
    }
    if let Some(day) = &options.day_type {
        if day != "weekday" && day != "weekend" {
            return Err(LauncherError::config("--day-type must be weekday or weekend"));
        }
    }
    let mut request = if let Some(name) = &options.saved_seed {
        crate::seeds::operate("use", &json!({"id": name}), paths)?["config"].clone()
    } else {
        let defaults = load(paths)?;
        let map = defaults.get("map").cloned().unwrap_or(json!({}));
        // "auto" lets the seed choose a real city district; a path pins a file.
        let source = options.osm_file.clone().or_else(|| map.get("osm_file").and_then(|v| v.as_str()).map(String::from)).unwrap_or_else(|| "auto".into());
        let cache = map.get("cache_dir").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        let (selection_version, selection) = map_selection(&defaults)?;
        let seed = match &options.seed {
            Some(seed) => normalise_seed(seed)?,
            // A world brought by a launcher state code, waiting for this start.
            None if crate::state::pending_seed().is_some() => normalise_seed(&crate::state::pending_seed().unwrap_or_default())?,
            // Dynamic Fastboot: the world the last run prepared, whose city is on disk already.
            // Fastboot prepares under urban-crfg-v3 only, so a narrower policy takes a fresh seed.
            None if source == "auto" && selection.is_none() && flag(&defaults, "startup.dynamic_fastboot") => prepared_seed(&paths.map_cache(cache), as_number(&setting(&defaults, "map.city_extent_m")).unwrap_or(5000.0)).unwrap_or_else(fresh_seed),
            None => fresh_seed(),
        };
        let mut map_options = Map::new();
        map_options.insert("osm_file".into(), json!(if source == "auto" { "auto".to_string() } else { absolute(&paths.root.join(&source)).to_string_lossy().into_owned() }));
        map_options.insert("max_nodes".into(), map.get("max_nodes").cloned().unwrap_or(json!(50000)));
        // Sent only when they differ from the engine's own defaults, so a request is what it always was by default.
        for (key, default) in [("city_extent_m", 5000), ("district_nodes", 3000)] {
            let value = setting(&defaults, &format!("map.{key}"));
            if value != json!(default) {
                map_options.insert(key.into(), value);
            }
        }
        if let Some(radius) = map.get("tile_radius_m").filter(|r| !r.is_null() && **r != json!(0)) {
            map_options.insert("tile_radius_m".into(), radius.clone());
        }
        if cache.is_some() || paths.synced() {
            map_options.insert("cache_dir".into(), json!(paths.map_cache(cache).to_string_lossy()));
        }
        let mut request = json!({
            "seed": seed,
            "engine": setting(&defaults, "engines.selected"),
            "day": defaults.get("day").cloned().unwrap_or(json!(0)),
            "playback_duration_seconds": defaults["playback"]["duration_seconds"],
            "tick_rate": defaults["playback"]["tick_rate"],
            "map": Value::Object(map_options),
            "modules": defaults.get("modules").cloned().unwrap_or(Value::Null),
            "dws": defaults.get("dws").cloned().unwrap_or(Value::Null),
            "map_selection_version": selection_version,
        });
        if let Some(selection) = selection {
            request["map_selection"] = selection;
        }
        request
    };
    if let Some(file) = &options.osm_file {
        request["map"]["osm_file"] = json!(absolute(&paths.root.join(file)).to_string_lossy());
    }
    let osm = request["map"]["osm_file"].as_str().unwrap_or("auto").to_string();
    if osm != "auto" && !Path::new(&osm).exists() {
        return Err(LauncherError::config("OSM data unavailable; provide --osm-file PATH"));
    }
    if let Some(engine) = &options.engine {
        if !ENGINES.contains(&engine.as_str()) {
            return Err(LauncherError::config(format!("--engine must be {}", ENGINES.join(" or "))));
        }
        request["engine"] = json!(engine);
    }
    if request["engine"] == json!("core-legacy") && request.get("map_selection").is_some() {
        return Err(LauncherError::config("core-legacy chooses from every city, but this run names countries or cities (Places).")
            .remedy("Choose core-ng (--engine core-ng, or config set engines.selected core-ng), or set Places to all."));
    }
    if let Some(day) = &options.day_type {
        request["day"] = json!(if day == "weekend" { 1 } else { 0 });
    }
    for (value, key, minimum, maximum, integer) in [
        (&options.duration, "duration", 60.0, 3600.0, true),
        (&options.speed, "speed", 0.01, MAX_TICK_RATE, false),
        (&options.max_nodes, "max-nodes", 2.0, 50000.0, true),
    ] {
        let Some(text) = value.as_ref().filter(|v| !v.is_empty()) else { continue };
        let number: f64 = text.trim().parse().unwrap_or(f64::NAN);
        if !(minimum..=maximum).contains(&number) || (integer && number.fract() != 0.0) {
            return Err(LauncherError::config(format!("--{key} must be in [{},{}]", fmt_g(minimum), fmt_g(maximum))));
        }
        match key {
            "max-nodes" => request["map"]["max_nodes"] = json!(number as i64),
            "duration" => request["playback_duration_seconds"] = json!(number as i64),
            _ => request["tick_rate"] = if number.fract() == 0.0 { json!(number as i64) } else { json!(number) },
        }
    }
    let tick = request.get("tick_rate").and_then(as_number);
    if !matches!(tick, Some(t) if t > 0.0 && t <= MAX_TICK_RATE) {
        return Err(LauncherError::config(format!("tick_rate must be in (0, {}]", fmt_g(MAX_TICK_RATE))));
    }
    Ok(request)
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_music_file_is_a_playable_file_or_the_score() {
        let dir = std::env::temp_dir().join(format!("dstns-music-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let track = dir.join("Theme.M4A");
        std::fs::write(&track, b"not checked for sound here").unwrap();
        assert_eq!(music_file("score").unwrap(), None);
        assert_eq!(music_file("").unwrap(), None);
        assert_eq!(music_file(track.to_str().unwrap()).unwrap(), Some(track.clone()));
        assert!(music_file(dir.join("missing.mp3").to_str().unwrap()).unwrap_err().contains("no file"));
        let text = dir.join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        assert!(music_file(text.to_str().unwrap()).unwrap_err().contains("MP3, M4A or WAV"));
        assert!(music_file(dir.to_str().unwrap()).is_err(), "a folder is not a file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    fn base() -> Value {
        json!({"playback": {"duration_seconds": 3600, "tick_rate": 1}, "api": {"port": 8090, "host": "127.0.0.1"}})
    }

    #[test]
    fn the_observer_settings_are_kept_in_their_own_file() {
        let paths = Paths::new(std::env::temp_dir().join(format!("dstns-ui-{}", std::process::id())));
        std::fs::create_dir_all(paths.config().parent().unwrap()).unwrap();
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../config/defaults.json"), paths.config()).unwrap();
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../config/ui-config.json"), paths.ui_config()).unwrap();
        let mut config = load(&paths).unwrap();
        assert_eq!(field("ui.auto_focus.mode").unwrap().get(&config), json!("enable-force"), "read from ui-config.json");
        field("ui.layers.labels").unwrap().set(&mut config, json!(true));
        field("ui.playback.fine_control").unwrap().set(&mut config, json!(true));
        save(&config, &paths).unwrap();
        let ui: Value = serde_json::from_str(&std::fs::read_to_string(paths.ui_config()).unwrap()).unwrap();
        assert_eq!(ui.pointer("/layers/labels"), Some(&json!(true)));
        assert_eq!(ui.pointer("/playback/fine_control"), Some(&json!(true)));
        assert!(ui.get("_about").is_some() && ui.get("_help").is_some(), "what the file says about itself stays");
        let rest: Value = serde_json::from_str(&std::fs::read_to_string(paths.config()).unwrap()).unwrap();
        assert!(rest.get("ui").is_none(), "nothing of the observer's goes into defaults.json");
        assert!(field("ui.auto_focus.zoom").unwrap().check(&json!(20)).len() > 0, "held to what the observer accepts");
        assert!(categories().iter().all(|c| section_of(c) != "Other"), "every category has a section");
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    /// A checkout of its own, with every setting at its default: tests never depend on the settings of the machine
    /// they run on.
    pub(crate) fn fresh_checkout(name: &str) -> Paths {
        let paths = Paths::new(std::env::temp_dir().join(format!("dstns-{name}-{}-{}", std::process::id(), fresh_seed())));
        std::fs::create_dir_all(paths.config().parent().unwrap()).unwrap();
        let mut defaults: Value = serde_json::from_str(include_str!("../../config/defaults.json")).unwrap();
        defaults.as_object_mut().unwrap().remove("engine");
        for field in fields() {
            field.store(&mut defaults, field.default.clone());
        }
        defaults.as_object_mut().unwrap().remove("ui");
        defaults.as_object_mut().unwrap().remove("engines");
        std::fs::write(paths.config(), defaults.to_string()).unwrap();
        paths
    }

    #[test]
    fn the_engine_and_where_worlds_are_go_into_the_start_request() {
        let paths = fresh_checkout("engine");
        let options = RunOptions { seed: Some("42".into()), ..Default::default() };
        let request = start_request(&options, &paths).unwrap();
        assert_eq!((request["engine"].clone(), request["map_selection_version"].clone()), (json!("core-legacy"), json!(MAP_SELECTION_VERSION)));
        assert!(request.get("map_selection").is_none(), "every city is the policy every seed has always had");
        assert!(request["map"].get("city_extent_m").is_none() && request["map"].get("district_nodes").is_none(), "the engine's defaults are not sent");

        let mut config = load(&paths).unwrap();
        assert_eq!(field("map.selection_mode").unwrap().set(&mut config, json!("countries")), vec!["engines.selected"], "only core-ng chooses countries");
        save(&config, &paths).unwrap();
        assert!(start_request(&options, &paths).unwrap_err().message.contains("Places names none"));
        field("map.places").unwrap().set(&mut config, json!("in, ae"));
        save(&config, &paths).unwrap();
        let request = start_request(&options, &paths).unwrap();
        assert_eq!(request["engine"], json!("core-ng"));
        assert_eq!(request["map_selection_version"], json!(GEO_SELECTION_VERSION));
        assert_eq!(request["map_selection"], json!({"mode": "countries", "countries": ["IN", "AE"], "cities": []}));
        field("map.places").unwrap().set(&mut config, json!("-in"));
        save(&config, &paths).unwrap();
        assert_eq!(start_request(&options, &paths).unwrap()["map_selection"], json!({"mode": "global", "countries": [], "cities": [], "exclude_countries": ["IN"]}), "-IN is everywhere but India");
        field("map.places").unwrap().set(&mut config, json!("IN, -Navi Mumbai"));
        field("map.selection_mode").unwrap().set(&mut config, json!("global"));
        save(&config, &paths).unwrap();
        assert_eq!(start_request(&options, &paths).unwrap()["map_selection"], json!({"mode": "countries", "countries": ["IN"], "cities": [], "exclude_cities": ["navi-mumbai"]}), "every city, with Places, is read by what it lists");
        field("map.selection_mode").unwrap().set(&mut config, json!("countries"));
        field("map.places").unwrap().set(&mut config, json!("in, ae"));
        field("map.city_extent_m").unwrap().set(&mut config, json!(8000));
        save(&config, &paths).unwrap();
        assert_eq!(start_request(&options, &paths).unwrap()["map"]["city_extent_m"], json!(8000));
        assert!(!check_field(field("map.places").unwrap(), &json!("India"), &config).is_empty(), "a country is its two-letter code");

        field("map.selection_mode").unwrap().set(&mut config, json!("fixed_city"));
        field("map.places").unwrap().set(&mut config, json!("New York"));
        save(&config, &paths).unwrap();
        assert_eq!(start_request(&options, &paths).unwrap()["map_selection"]["cities"], json!(["new-york"]));
        field("map.places").unwrap().set(&mut config, json!("mumbai, delhi"));
        save(&config, &paths).unwrap();
        assert!(start_request(&options, &paths).is_err(), "one city is one city");

        field("map.places").unwrap().set(&mut config, json!("mumbai"));
        save(&config, &paths).unwrap();
        let once = |engine: &str| start_request(&RunOptions { engine: Some(engine.into()), ..options.clone() }, &paths);
        assert!(once("core-legacy").unwrap_err().message.contains("every city"), "--engine core-legacy cannot run one city");
        assert!(once("core-next").unwrap_err().message.contains("--engine must be"));

        field("engines.selected").unwrap().set(&mut config, json!("core-legacy"));
        assert_eq!(setting(&config, "map.selection_mode"), json!("global"), "back to core-legacy is back to every city");
        save(&config, &paths).unwrap();
        assert_eq!(once("core-ng").unwrap()["engine"], json!("core-ng"), "--engine chooses for one run");
        assert_eq!(start_request(&options, &paths).unwrap()["engine"], json!("core-legacy"), "and only that run");
        let _ = std::fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn every_key_in_defaults_is_a_setting_or_said_to_be_informational() {
        let defaults: Value = serde_json::from_str(include_str!("../../config/defaults.json")).unwrap();
        fn leaves(value: &Value, prefix: &str, out: &mut Vec<String>) {
            match value.as_object() {
                Some(object) => object.iter().for_each(|(k, v)| leaves(v, &if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") }, out)),
                None => out.push(prefix.to_string()),
            }
        }
        let mut keys = vec![];
        leaves(&defaults, "", &mut keys);
        let missing: Vec<&String> = keys.iter().filter(|k| !k.starts_with('$') && !k.starts_with('_') && field(k).is_none() && !INFORMATIONAL.iter().any(|i| *k == i || k.starts_with(&format!("{i}.")))).collect();
        assert!(missing.is_empty(), "add a field, or list it in INFORMATIONAL with why: {missing:?}");
    }

    #[test]
    fn settings_that_conflict_are_never_on_together() {
        let mut config = json!({});
        let changed = field("startup.force_animate").unwrap().set(&mut config, json!(true));
        assert!(changed.contains(&"startup.dynamic_particles"));
        assert!(!flag(&config, "startup.dynamic_particles") && flag(&config, "startup.force_animate"));
        field("startup.dynamic_particles").unwrap().set(&mut config, json!(true));
        assert!(!flag(&config, "startup.force_animate"), "and the other way round");
        field("mcp.allow_launcher").unwrap().set(&mut config, json!(true));
        assert!(flag(&config, "mcp.enabled"), "a permission needs the handler on");
        field("mcp.enabled").unwrap().set(&mut config, json!(false));
        assert!(!flag(&config, "mcp.allow_launcher"), "and goes with it");
        assert!(field("startup.fast_boot").unwrap().set(&mut config, json!(false)).is_empty(), "turning something off that nothing needs changes nothing else");
    }

    #[test]
    fn demo_scenes_are_named_by_id_in_order() {
        let scenes = field("demo.scenes").unwrap();
        assert_eq!(check_field(scenes, &json!("ai-ready, streets"), &json!({})), "");
        assert!(check_field(scenes, &json!("ai-ready, newsroom"), &json!({})).contains("No scene newsroom"));
        let config = json!({"demo": {"scenes": "ai-ready , time-control"}});
        assert_eq!(demo_scene_list(&config), vec!["ai-ready", "time-control"]);
        assert_eq!(presentation(&config, true)["demo_scenes"], json!(["ai-ready", "time-control"]));
    }

    #[test]
    fn a_start_takes_the_world_dynamic_fastboot_prepared() {
        let dir = std::env::temp_dir().join(format!("dstns-next-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(prepared_seed(&dir, 5000.0), None, "nothing prepared");
        std::fs::write(dir.join("next-world.json"), r#"{"seed": "8675309", "city": "Lisbon", "state": "ready"}"#).unwrap();
        assert_eq!(prepared_seed(&dir, 5000.0).as_deref(), Some("8675309"));
        std::fs::write(dir.join("next-world.json"), r#"{"seed": "not a number"}"#).unwrap();
        assert_eq!(prepared_seed(&dir, 5000.0), None, "only a seed it can use");
        let pointer = |extra: &str| std::fs::write(dir.join("next-world.json"), format!(r#"{{"seed": "8675309", "extent_m": 5000, "state": "ready"{extra}}}"#)).unwrap();
        pointer(r#", "format": 2, "selection": {"policy": "urban-crfg-v3", "mode": "global", "countries": [], "cities": [], "fingerprint": "sha256:x"}"#);
        assert_eq!(prepared_seed(&dir, 5000.0).as_deref(), Some("8675309"), "prepared under the policy a start uses");
        pointer(r#", "format": 2, "selection": {"policy": "urban-geo-v1", "mode": "fixed_city", "cities": ["berlin"]}"#);
        assert_eq!(prepared_seed(&dir, 5000.0), None, "prepared under another policy: it would name another city here");
        pointer(r#", "format": 2, "selection": {"policy": "urban-crfg-v3", "mode": "countries", "countries": ["IN"]}"#);
        assert_eq!(prepared_seed(&dir, 5000.0), None, "a filtered selection is not the launcher's");
        pointer(r#", "format": 3"#);
        assert_eq!(prepared_seed(&dir, 5000.0), None, "a pointer format it does not know");
        std::fs::write(dir.join("next-world.json"), r#"{"seed": "8675309", "extent_m": 8000}"#).unwrap();
        assert_eq!(prepared_seed(&dir, 5000.0), None, "another extent");
        assert_eq!(prepared_seed(&dir, 8000.0).as_deref(), Some("8675309"), "the extent this launcher is set to");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn seeds_are_normalised_to_decimal() {
        assert_eq!(normalise_seed("0x10").unwrap(), "16");
        assert_eq!(normalise_seed("382923").unwrap(), "382923");
        assert_eq!(normalise_seed("0xffffffffffffffffffffffffffffffff").unwrap(), u128::MAX.to_string());
        assert!(normalise_seed("12a").is_err());
        assert!(normalise_seed("999999999999999999999999999999999999999").is_err());
    }

    #[test]
    fn the_engines_bounds_are_kept() {
        assert!(validate(&base()).is_ok());
        let mut fast = base();
        fast["playback"]["tick_rate"] = json!(11);
        assert!(validate(&fast).unwrap_err().message.contains("(0, 10]"));
    }

    #[test]
    fn fields_parse_what_is_typed() {
        let speed = field("playback.tick_rate").unwrap();
        assert_eq!(speed.parse("2").unwrap(), json!(2));
        assert_eq!(speed.parse("2.5").unwrap(), json!(2.5));
        assert!(speed.parse("0").unwrap_err().contains("greater than 0"));
        assert_eq!(field("modules.dws").unwrap().parse("off").unwrap(), json!(false));
        assert_eq!(field("day").unwrap().parse("weekend").unwrap(), json!(1));
        assert_eq!(field("performance.compression").unwrap().parse("Small").unwrap(), json!("small"));
    }

    #[test]
    fn switches_carry_every_setting_to_the_server() {
        let mut config = base();
        field("fabric.allow_camera").unwrap().set(&mut config, json!(false));
        field("startup.fast_boot").unwrap().set(&mut config, json!(true));
        field("performance.api_threads").unwrap().set(&mut config, json!(6));
        let env: std::collections::HashMap<_, _> = server_switches(&config, false).into_iter().collect();
        assert_eq!(env["DSTNS_DISABLED_CAPABILITIES"], "ui.camera");
        assert_eq!(env["DSTNS_API_THREADS"], "6");
        let shown: Value = serde_json::from_str(&env["DSTNS_PRESENTATION"]).unwrap();
        assert_eq!(shown["fast_boot"], json!(true));
        assert_eq!(shown["force_animate"], json!(false), "Fast Boot turns force_animate off");
        assert_eq!(env["DSTNS_SUMO"], "0", "SUMO is off by default");
        assert!(!env.contains_key("SUMO_HOME"), "auto leaves SUMO_HOME to the environment");
        field("sumo.enabled").unwrap().set(&mut config, json!(true));
        field("sumo.home").unwrap().set(&mut config, json!("/opt/sumo"));
        let env: std::collections::HashMap<_, _> = server_switches(&config, false).into_iter().collect();
        assert_eq!((env["DSTNS_SUMO"].as_str(), env["SUMO_HOME"].as_str()), ("1", "/opt/sumo"));
        assert_eq!(env["DSTNS_MAP_STALL_S"], "200");
        assert!(!env.contains_key("DSTNS_ALLOWED_HOSTS"), "none is none");
        field("api.allowed_hosts").unwrap().set(&mut config, json!("dstns.local, lab.example "));
        field("map.cache_policy").unwrap().set(&mut config, json!("keep"));
        let env: std::collections::HashMap<_, _> = server_switches(&config, false).into_iter().collect();
        assert_eq!(env["DSTNS_ALLOWED_HOSTS"], "dstns.local,lab.example");
        assert_eq!(server_arguments(&config), vec!["--map-cache", "keep", "--map-cache-keep", "1"]);
    }

    #[test]
    fn setting_creates_the_sections_it_needs() {
        let mut config = json!({});
        field("mcp.allow_writes").unwrap().set(&mut config, json!(true));
        assert_eq!(config, json!({"mcp": {"allow_writes": true, "enabled": true}}));
    }
}
