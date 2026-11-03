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

/// The engine refuses anything faster (kMaxTickRate in Core/include/dstns/model.hpp).
pub const MAX_TICK_RATE: f64 = 10.0;
pub const MAP_SELECTION_VERSION: &str = "urban-crfg-v3";

pub fn load(paths: &Paths) -> Result<Value> {
    let text = fs::read_to_string(paths.config()).map_err(|_| {
        LauncherError::config(format!("{} is missing.", paths.relative(&paths.config()))).remedy("Restore it from the repository: git checkout -- config/defaults.json")
    })?;
    let config: Value = serde_json::from_str(&text).map_err(|error| {
        LauncherError::config(format!("{} is not valid JSON (line {}, column {}).", paths.relative(&paths.config()), error.line(), error.column()))
            .remedy("Correct the file, or restore it with git checkout -- config/defaults.json")
    })?;
    validate(&config)?;
    Ok(config)
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
pub fn save(config: &Value, paths: &Paths) -> Result<()> {
    validate(config)?;
    for field in fields() {
        let problem = check_field(field, &field.get(config), config);
        if !problem.is_empty() {
            return Err(LauncherError::config(format!("{}: {problem}", field.label)));
        }
    }
    let text = serde_json::to_string_pretty(config).unwrap() + "\n";
    let temporary = paths.config().with_extension("json.tmp");
    fs::write(&temporary, text)?;
    fs::rename(&temporary, paths.config())?;
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

    pub fn set(&self, config: &mut Value, value: Value) {
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
    ["auto", "fm", "off"].contains(&value) || value.starts_with("http://") || value.starts_with("unix:/")
}

fn narration_mode(value: &Value, _config: &Value) -> String {
    if value.as_str().map(valid_narration).unwrap_or(false) {
        String::new()
    } else {
        "Use auto, fm, off, http://HOST:PORT or unix:/PATH.".into()
    }
}

fn volume(value: &Value, _config: &Value) -> String {
    if as_number(value).map(|v| (0.0..=1.0).contains(&v)).unwrap_or(false) {
        String::new()
    } else {
        "Use a number from 0 to 1.".into()
    }
}

/// Every editable setting, by category, in the order the configuration screen shows them.
pub fn fields() -> &'static [Field] {
    use FieldKind::*;
    static FIELDS: std::sync::OnceLock<Vec<Field>> = std::sync::OnceLock::new();
    FIELDS.get_or_init(|| {
        vec![
            Field::new("day", "Day type", "Run", Choice, "Weekday or weekend demand profiles. --day-type overrides it.", json!(0))
                .choices(vec![("weekday", json!(0)), ("weekend", json!(1))]),
            Field::new("playback.duration_seconds", "Day duration", "Run", Integer, "Wall-clock seconds one virtual day takes at 1×.", json!(3600))
                .unit("seconds")
                .range(60.0, Some(3600.0)),
            Field::new("playback.tick_rate", "Speed", "Run", Number, "Initial playback multiplier.", json!(1.0)).unit("×").range(0.0, Some(MAX_TICK_RATE)).above(),
            Field::new("map.max_nodes", "Graph size cap", "Map", Integer, "Upper bound on the number of junctions.", json!(50000)).unit("nodes").range(2.0, Some(50000.0)),
            Field::new("map.cache_dir", "Map cache", "Map", Text, "Where downloaded city extracts are kept.", json!("data/maps")),
            Field::new("modules.traffic", "Traffic demand", "Modules", Boolean, "Base and hotspot demand on every road.", json!(true)),
            Field::new("modules.signals", "Traffic signals", "Modules", Boolean, "Signal controllers at junctions.", json!(true)),
            Field::new("modules.buildings", "Places", "Modules", Boolean, "Demand from schools, offices, shops and other places.", json!(true)),
            Field::new("modules.dws", "Weather", "Modules", Boolean, "Scheduled and manual rain.", json!(true)),
            Field::new("modules.flooding", "Flooding", "Modules", Boolean, "Standing water and flood closures.", json!(true)),
            Field::new("modules.news", "News", "Modules", Boolean, "The operator news feed.", json!(true)),
            Field::new("dws.frequency", "Storms per day", "Weather", Integer, "Scheduled storms in a virtual day.", json!(3))
                .unit("storms")
                .range(0.0, None)
                .extra(dws_spacing),
            Field::new(
                "launcher.default_settings",
                "Open with default settings",
                "Launcher",
                Boolean,
                "Each launch opens the observer with its settings at their defaults, forgetting what this browser had chosen. --default-settings does the same once.",
                json!(false),
            ),
            Field::new(
                "launcher.command_bar",
                "Command bar",
                "Launcher",
                Boolean,
                "A line at the bottom of the terminal interface where commands can be typed, as in a shell. : or / opens it.",
                json!(true),
            ),
            Field::new("api.host", "Bind address", "Server", Text, "127.0.0.1 keeps the server local; 0.0.0.0 exposes it to the network.", json!("127.0.0.1")),
            Field::new("api.port", "Port", "Server", Integer, "Preferred port; the next free one is used if it is taken.", json!(8090)).range(1.0, Some(65535.0)),
            Field::new(
                "narration.mode",
                "Narration",
                "Server",
                Text,
                "Plain-language news: auto uses Apple Foundation Models where available, fm requires them, off keeps the default wording, or a Chat Completions endpoint (http://HOST:PORT, unix:/PATH). --narrator overrides it.",
                json!("auto"),
            )
            .extra(narration_mode),
            Field::new("fabric.applications", "Applications", "Fabric", Boolean, "Programs may connect through the Fabric API. Off, nothing can register.", json!(true)),
            Field::new(
                "fabric.legacy_api",
                "Legacy API",
                "Fabric",
                Boolean,
                "The older /playback and /control routes answer. They have no credential, so turning them off leaves only the Fabric API.",
                json!(true),
            ),
            Field::new("fabric.launch_proposals", "Launch proposals", "Fabric", Boolean, "Applications may propose how to start them, for a person to approve here.", json!(true)),
            Field::new("fabric.require_signatures", "Require signatures", "Fabric", Boolean, "Every application must sign every request it makes.", json!(false)),
            Field::new("fabric.world_regeneration", "New worlds from the observer", "Fabric", Boolean, "The observer may ask the engine for a new world.", json!(true)),
            Field::new("fabric.allow_frames", "Applications' own pages", "Fabric", Boolean, "Applications may show a page of their own, in a sandbox.", json!(true)),
            Field::new("fabric.allow_dialogs", "Applications' dialogs", "Fabric", Boolean, "Applications may ask a question in a dialog.", json!(true)),
            Field::new("fabric.allow_camera", "Applications move the map", "Fabric", Boolean, "Applications may ask the map to look somewhere, once a person allows it.", json!(true)),
            Field::new("fabric.allow_layers", "Applications show layers", "Fabric", Boolean, "Applications may hold layers and places on or off, once a person allows it.", json!(true)),
            Field::new("fabric.allow_control", "Applications control the run", "Fabric", Boolean, "Applications may play, pause and change the simulation, once a person allows it.", json!(true)),
            Field::new("fabric.allow_notifications", "Applications' notifications", "Fabric", Boolean, "Applications may send notifications.", json!(true)),
            Field::new("fabric.allow_messages", "Messages between applications", "Fabric", Boolean, "Applications may send each other messages.", json!(true)),
            Field::new("fabric.allow_storage", "Applications' storage", "Fabric", Boolean, "Applications may keep values across restarts.", json!(true)),
            Field::new("webfabric.enabled", "WebFabric", "WebFabric", Boolean, "Applications appear in the observer. Off, they can still connect, but nothing of theirs is shown.", json!(true)),
            Field::new(
                "startup.fast_boot",
                "Fast Boot",
                "Startup",
                Boolean,
                "Use maps downloaded in advance with ./launcher fastboot download, so that a world is ready in seconds, and open with the name alone.",
                json!(false),
            ),
            Field::new(
                "startup.force_animate",
                "Play the whole film",
                "Startup",
                Boolean,
                "The start-up film plays to its end before the map, even when the world is ready sooner. Fast Boot turns this off.",
                json!(true),
            ),
            Field::new("presentation.music", "Music", "Presentation", Boolean, "Original music while the start-up film plays, with a button to mute it.", json!(false)),
            Field::new("presentation.fullscreen", "Full screen", "Presentation", Boolean, "Open the observer full screen.", json!(false)),
            Field::new("presentation.music_volume", "Music volume", "Presentation", Number, "From 0 to 1.", json!(0.6)).range(0.0, Some(1.0)).extra(volume),
            Field::new("demo.music", "Music in Demo Mode", "Demo", Boolean, "Demo Mode plays its music. ./launcher demo starts it.", json!(true)),
            Field::new("demo.fullscreen", "Full screen in Demo Mode", "Demo", Boolean, "Demo Mode opens full screen.", json!(true)),
            Field::new("performance.compression", "Compression", "Performance", Choice, "How hard the server compresses what it sends. Fast costs least; small saves bytes on a slow link.", json!("fast"))
                .choices(vec![("Fast", json!("fast")), ("Balanced", json!("balanced")), ("Small", json!("small")), ("Off", json!("off"))]),
            Field::new("performance.api_threads", "API threads", "Performance", Integer, "Requests the server answers at once. 0 lets it choose.", json!(0)).range(0.0, Some(256.0)),
            Field::new("performance.engine_threads", "Engine threads", "Performance", Integer, "Threads that write a large snapshot. 0 lets it choose; 1 keeps it to one.", json!(0)).range(0.0, Some(64.0)),
            Field::new("performance.map_fps", "Map frame rate", "Performance", Choice, "How often the map's moving traffic is redrawn. Automatic drops to 30 when the map struggles.", json!(0))
                .choices(vec![("Automatic", json!(0)), ("60 a second", json!(60)), ("30 a second", json!(30))]),
            Field::new("performance.render_scale", "Render scale", "Performance", Number, "The most pixels the map draws per point on a high-density screen. Lower is lighter.", json!(2)).range(0.5, Some(3.0)),
            Field::new("performance.film_particles", "Film particles", "Performance", Integer, "How many particles the start-up film has. Fewer is lighter.", json!(32000)).range(4000.0, Some(32000.0)),
            Field::new(
                "mcp.enabled",
                "MCP Handler",
                "MCP",
                Boolean,
                "./launcher mcp serve answers the Model Context Protocol, so that an AI client can call the API. No agent is included; this is the door, closed by default.",
                json!(false),
            ),
            Field::new("mcp.allow_writes", "Allow changes", "MCP", Boolean, "An AI client may call routes that change things (POST, PUT, DELETE). Off, it can only read.", json!(false)),
            Field::new("mcp.allow_launcher", "Allow launcher actions", "MCP", Boolean, "An AI client may start and stop simulations through the launcher, as you could.", json!(false)),
        ]
    })
}

pub fn categories() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = vec![];
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

/// How the observer should present itself, as the server will tell it.
pub fn presentation(config: &Value, demo: bool) -> Value {
    let fast = flag(config, "startup.fast_boot");
    json!({
        "webfabric": flag(config, "webfabric.enabled"),
        "fast_boot": fast,
        "force_animate": flag(config, "startup.force_animate") && !fast,
        "demo": demo,
        "music": flag(config, if demo { "demo.music" } else { "presentation.music" }),
        "fullscreen": flag(config, if demo { "demo.fullscreen" } else { "presentation.fullscreen" }),
        "music_volume": as_number(&setting(config, "presentation.music_volume")).unwrap_or(0.6),
        "map_fps": as_int(&setting(config, "performance.map_fps")).unwrap_or(0),
        "render_scale": as_number(&setting(config, "performance.render_scale")).unwrap_or(2.0),
        "film_particles": as_int(&setting(config, "performance.film_particles")).unwrap_or(32000),
    })
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
    ];
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
    pub max_nodes: Option<String>,
    pub osm_file: Option<String>,
    /// Applications to start with this run, by ID, comma separated. None: those set to start by themselves.
    pub apps: Option<String>,
    pub no_apps: bool,
    pub default_settings: bool,
}

impl RunOptions {
    pub fn explicit(&self) -> bool {
        [&self.seed, &self.saved_seed, &self.save_seed, &self.day_type, &self.osm_file, &self.max_nodes, &self.duration, &self.speed].iter().any(|v| v.is_some())
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
        let seed = match &options.seed {
            Some(seed) => normalise_seed(seed)?,
            None => fresh_seed(),
        };
        let map = defaults.get("map").cloned().unwrap_or(json!({}));
        // "auto" lets the seed choose a real city district; a path pins a file.
        let source = options.osm_file.clone().or_else(|| map.get("osm_file").and_then(|v| v.as_str()).map(String::from)).unwrap_or_else(|| "auto".into());
        let mut map_options = Map::new();
        map_options.insert("osm_file".into(), json!(if source == "auto" { "auto".to_string() } else { absolute(&paths.root.join(&source)).to_string_lossy().into_owned() }));
        map_options.insert("max_nodes".into(), map.get("max_nodes").cloned().unwrap_or(json!(50000)));
        if let Some(radius) = map.get("tile_radius_m").filter(|r| !r.is_null() && **r != json!(0)) {
            map_options.insert("tile_radius_m".into(), radius.clone());
        }
        let cache = map.get("cache_dir").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        if cache.is_some() || paths.synced() {
            map_options.insert("cache_dir".into(), json!(paths.map_cache(cache).to_string_lossy()));
        }
        json!({
            "seed": seed,
            "day": defaults.get("day").cloned().unwrap_or(json!(0)),
            "playback_duration_seconds": defaults["playback"]["duration_seconds"],
            "tick_rate": defaults["playback"]["tick_rate"],
            "map": Value::Object(map_options),
            "modules": defaults.get("modules").cloned().unwrap_or(Value::Null),
            "dws": defaults.get("dws").cloned().unwrap_or(Value::Null),
            "map_selection_version": MAP_SELECTION_VERSION,
        })
    };
    if let Some(file) = &options.osm_file {
        request["map"]["osm_file"] = json!(absolute(&paths.root.join(file)).to_string_lossy());
    }
    let osm = request["map"]["osm_file"].as_str().unwrap_or("auto").to_string();
    if osm != "auto" && !Path::new(&osm).exists() {
        return Err(LauncherError::config("OSM data unavailable; provide --osm-file PATH"));
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
    use super::*;

    fn base() -> Value {
        json!({"playback": {"duration_seconds": 3600, "tick_rate": 1}, "api": {"port": 8090, "host": "127.0.0.1"}})
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
    }

    #[test]
    fn setting_creates_the_sections_it_needs() {
        let mut config = json!({});
        field("mcp.allow_writes").unwrap().set(&mut config, json!(true));
        assert_eq!(config, json!({"mcp": {"allow_writes": true}}));
    }
}
