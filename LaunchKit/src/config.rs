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
                crate::log::info(&format!("settings: {} from {} to {}", field.key, field.display(&was_value), field.display(&now_value)));
            }
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

    /// Set it, and whatever must change with it (see RULES). Returns the other settings that changed.
    pub fn set(&self, config: &mut Value, value: Value) -> Vec<&'static str> {
        self.store(config, value.clone());
        let mut changed = vec![];
        for (when, becomes, other, to) in RULES {
            if *when == self.key && value == json!(*becomes) {
                if let Some(field) = field(other) {
                    if field.get(config) != json!(*to) {
                        field.store(config, json!(*to));
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
            // Run
            Field::new("day", "Day type", "Run", Choice, "Which demand profile the day follows: a working weekday, or a weekend's later, flatter one. --day-type overrides it for a run.", json!(0))
                .choices(vec![("weekday", json!(0)), ("weekend", json!(1))]),
            Field::new("playback.duration_seconds", "Length of a day", "Run", Integer, "Wall-clock seconds one simulated day lasts at 1× speed. 3600 plays a day in an hour.", json!(3600))
                .unit("seconds")
                .range(60.0, Some(3600.0)),
            Field::new("playback.tick_rate", "Starting speed", "Run", Number, "How fast a run plays when it starts, as a multiple of the length of a day. The observer changes it while it runs.", json!(1.0)).unit("×").range(0.0, Some(MAX_TICK_RATE)).above(),
            // Map
            Field::new("map.max_nodes", "Largest network", "Map", Integer, "The most junctions a district's road network may have. Lower keeps big cities light.", json!(50000)).unit("junctions").range(2.0, Some(50000.0)),
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
            Field::new("api.port", "Port", "Server", Integer, "The port to listen on. If it is taken, the next free one is used, and the launcher says which.", json!(8090)).range(1.0, Some(65535.0)),
            Field::new(
                "narration.mode",
                "Realistic News",
                "Server",
                Text,
                "Who writes the news: auto uses Apple Foundation Models where this Mac has them, fm insists on them, off keeps the plain wording, or give a Chat Completions endpoint (http://HOST:PORT, unix:/PATH). --narrator overrides it.",
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
            // Demo
            Field::new("demo.music", "Music in Demo Mode", "Demo", Boolean, "Demo Mode plays its score. --no-music turns it off once.", json!(true)),
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
            Field::new("model.provider", "Model", "Model", Choice, "Which model turns a request in plain words into commands at the prompt. Automatic uses Apple's Foundation Models on a Mac with Apple silicon and macOS 27 or later; else Ollama, if it answers; else Groq, if a key is kept (model key KEY).", json!("auto"))
                .choices(vec![("Automatic", json!("auto")), ("Apple Foundation Models", json!("apple")), ("Ollama", json!("ollama")), ("Groq", json!("groq")), ("Off", json!("off"))]),
            Field::new("model.name", "Model name", "Model", Text, "Which model, for Ollama (llama3.2, qwen2.5…) or Groq (llama-3.3-70b-versatile…). default uses each one's own.", json!("default")),
            Field::new("model.ollama_url", "Ollama address", "Model", Text, "Where Ollama answers.", json!("http://127.0.0.1:11434")),
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
        ]
    })
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

/// Settings that cannot be on together, or that need another: when the first becomes the value, the other becomes its
/// value too. The interface and `config set` say what else changed.
pub const RULES: &[(&str, bool, &str, bool)] = &[
    // The dynamic film plans its own length; the whole film plays every scene. One or the other.
    ("startup.dynamic_particles", true, "startup.force_animate", false),
    ("startup.force_animate", true, "startup.dynamic_particles", false),
    // Fast Boot opens with the name alone, which the whole film would undo.
    ("startup.fast_boot", true, "startup.force_animate", false),
    ("startup.force_animate", true, "startup.fast_boot", false),
    // What an AI client may do needs the MCP Handler to be on at all.
    ("mcp.allow_writes", true, "mcp.enabled", true),
    ("mcp.allow_launcher", true, "mcp.enabled", true),
    ("mcp.enabled", false, "mcp.allow_writes", false),
    ("mcp.enabled", false, "mcp.allow_launcher", false),
    // Applications that may not connect cannot appear in the observer either.
    ("fabric.applications", false, "webfabric.enabled", false),
    ("webfabric.enabled", true, "fabric.applications", true),
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
        ("DSTNS_DYNAMIC_FASTBOOT".to_string(), one("startup.dynamic_fastboot")),
        ("DSTNS_DAEMON".to_string(), daemon_settings(config).to_string()),
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

/// The seed of the world Dynamic Fastboot prepared in this map cache, if there is one.
pub fn prepared_seed(cache: &Path) -> Option<String> {
    let text = std::fs::read_to_string(cache.join("next-world.json")).ok()?;
    let seed = serde_json::from_str::<Value>(&text).ok()?.get("seed")?.as_str()?.to_string();
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
        let seed = match &options.seed {
            Some(seed) => normalise_seed(seed)?,
            // Dynamic Fastboot: the world the last run prepared, whose city is on disk already.
            None if source == "auto" && flag(&defaults, "startup.dynamic_fastboot") => prepared_seed(&paths.map_cache(cache)).unwrap_or_else(fresh_seed),
            None => fresh_seed(),
        };
        let mut map_options = Map::new();
        map_options.insert("osm_file".into(), json!(if source == "auto" { "auto".to_string() } else { absolute(&paths.root.join(&source)).to_string_lossy().into_owned() }));
        map_options.insert("max_nodes".into(), map.get("max_nodes").cloned().unwrap_or(json!(50000)));
        if let Some(radius) = map.get("tile_radius_m").filter(|r| !r.is_null() && **r != json!(0)) {
            map_options.insert("tile_radius_m".into(), radius.clone());
        }
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
        assert_eq!(prepared_seed(&dir), None, "nothing prepared");
        std::fs::write(dir.join("next-world.json"), r#"{"seed": "8675309", "city": "Lisbon", "state": "ready"}"#).unwrap();
        assert_eq!(prepared_seed(&dir).as_deref(), Some("8675309"));
        std::fs::write(dir.join("next-world.json"), r#"{"seed": "not a number"}"#).unwrap();
        assert_eq!(prepared_seed(&dir), None, "only a seed it can use");
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
    }

    #[test]
    fn setting_creates_the_sections_it_needs() {
        let mut config = json!({});
        field("mcp.allow_writes").unwrap().set(&mut config, json!(true));
        assert_eq!(config, json!({"mcp": {"allow_writes": true, "enabled": true}}));
    }
}
