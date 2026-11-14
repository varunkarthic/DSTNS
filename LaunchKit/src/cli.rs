// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Command line: arguments, scripted commands, and choosing an interface.
//!
//! Scripted commands (start without a terminal, test, seeds...) print plain lines and return an exit status, exactly
//! as they always have. Interactive use opens the terminal interface, and falls back to compatibility mode, plain
//! numbered menus, if that cannot start.

use crate::config::{self, RunOptions};
use crate::errors::{LauncherError, Result};
use crate::modules;
use crate::output::{LineReporter, Output};
use crate::paths::Paths;
use crate::reporting::{Level, Reporter};
use crate::session::Session;
use crate::terminal::Capabilities;
use crate::version::{self, engine_version, PRODUCT};
use crate::{logs, maintenance, narration, seeds, server, simulation, sumo, testing};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILURE: i32 = 1;
pub const EXIT_INTERRUPTED: i32 = 130;
pub const EXIT_TERMINATED: i32 = 143;

const VALUE_OPTIONS: &[&str] = &["--seed", "--saved-seed", "--save-seed", "--day-type", "--osm-file", "--max-nodes", "--duration", "--speed", "--engine", "--description", "--apps"];
pub const COMMANDS: &[&str] = &["start", "stop", "console", "seeds", "ui", "logs", "config", "engine", "places", "countries", "cities", "test", "sumo", "reset", "setup", "help", "version", "license"];

#[derive(Clone, Debug, Default)]
pub struct Arguments {
    pub command: Option<String>,
    pub topic: Option<String>,
    pub item: Option<String>,
    /// Anything after those: `config set KEY VALUE` reads it.
    pub extra: Vec<String>,
    /// What a module's command reads for itself.
    pub rest: Vec<String>,
    pub run: RunOptions,
    pub mode: Option<String>,
    pub yes: bool,
    pub verbose: bool,
    pub open: bool,
    pub no_splash: bool,
    pub no_animation: bool,
    pub debug: bool,
    pub reduced_ui: bool,
    pub no_tui: bool,
    pub no_color: bool,
}

pub fn parse(argv: &[String]) -> Result<Arguments> {
    let mut args = Arguments { open: simulation::can_open_browser(), ..Default::default() };
    // A module's command reads its own arguments: everything after its name is its own.
    if let Some(first) = argv.first() {
        if modules::find(first).is_some() {
            args.command = Some(first.clone());
            args.rest = argv[1..].to_vec();
            return Ok(args);
        }
    }
    let mut positional: Vec<String> = vec![];
    let mut index = 0;
    while index < argv.len() {
        let arg = argv[index].as_str();
        match arg {
            "--yes" | "-y" => args.yes = true,
            "--verbose" | "-v" => args.verbose = true,
            "--open" | "-o" => args.open = true,
            "--no-open" => args.open = false,
            "--default-settings" => args.run.default_settings = true,
            "--no-apps" => args.run.no_apps = true,
            "--accept-risk" => args.run.accept_risk = true,
            "--help" | "-h" => positional.push("help".into()),
            "--version" | "-V" => positional.push("version".into()),
            "--license" | "--licence" => positional.push("license".into()),
            "--no-splash" => args.no_splash = true,
            "--no-animation" => args.no_animation = true,
            "--debug" => args.debug = true,
            "--reduced-ui" => args.reduced_ui = true,
            "--no-tui" => args.no_tui = true,
            "--no-color" => args.no_color = true,
            _ if arg == "--narrator" || arg.starts_with("--narrator=") => {
                let value = if let Some((_, v)) = arg.split_once('=') {
                    v.to_string()
                } else if index + 1 < argv.len() && !argv[index + 1].starts_with("--") {
                    index += 1;
                    argv[index].clone()
                } else {
                    return Err(LauncherError::config("Missing value for --narrator").remedy("Use auto, fm, off, http://HOST:PORT or unix:/PATH."));
                };
                if !config::valid_narration(&value) {
                    return Err(LauncherError::config(format!("\"{value}\" is not a narration mode")).remedy("Use auto, fm, off, http://HOST:PORT or unix:/PATH."));
                }
                // The server is started deep inside either interface; the environment carries the choice there.
                std::env::set_var(narration::ENV, value);
            }
            _ if arg.starts_with("--mode=") => args.mode = Some(arg["--mode=".len()..].to_string()),
            "--mode" if index + 1 < argv.len() => {
                index += 1;
                args.mode = Some(argv[index].clone());
            }
            _ if VALUE_OPTIONS.contains(&arg) => {
                if index + 1 >= argv.len() || argv[index + 1].starts_with("--") {
                    return Err(LauncherError::config(format!("Missing value for {arg}")));
                }
                index += 1;
                let value = Some(argv[index].clone());
                match arg {
                    "--seed" => args.run.seed = value,
                    "--saved-seed" => args.run.saved_seed = value,
                    "--save-seed" => args.run.save_seed = value,
                    "--day-type" => args.run.day_type = value,
                    "--osm-file" => args.run.osm_file = value,
                    "--max-nodes" => args.run.max_nodes = value,
                    "--duration" => args.run.duration = value,
                    "--speed" => args.run.speed = value,
                    "--engine" => args.run.engine = value,
                    "--description" => args.run.description = value,
                    _ => args.run.apps = value,
                }
            }
            _ if arg.starts_with('-') && !(positional.first().map(|c| c == "config").unwrap_or(false) && positional.len() >= 3) => {
                return Err(LauncherError::config(format!("Unknown option: {arg}")).remedy("./launcher help lists every option."));
            }
            _ => positional.push(arg.to_string()),
        }
        index += 1;
    }
    let mut positional = positional.into_iter();
    args.command = positional.next();
    args.topic = positional.next();
    args.item = positional.next();
    args.extra = positional.collect();
    if let Some(day) = &args.run.day_type {
        if day != "weekday" && day != "weekend" {
            return Err(LauncherError::config("--day-type must be weekday or weekend"));
        }
    }
    Ok(args)
}

pub fn help() -> String {
    let modules = modules::help_lines().join("\n");
    format!(
        "{PRODUCT} launcher

Usage: ./launcher [command] [options]

Commands
  (none)                 Open the launcher; without a terminal, start a run
  start                  Build what changed, start or reuse the server, start a run
  stop                   Stop the running server, and the applications this launcher started
  console                Open the launcher dashboard
  setup                  Run the first-launch setup again
  seeds save|list|inspect|delete [ID]
                         Manage saved seeds (prints JSON)
  ui PAGE               Open the interface on a page: start, apps, seeds, config, demo (runs
                         Demo Mode), logs, diagnostics, tests, tools, about, setup
  ui open|dev|build|install
                         Open the observer, run its dev server, build or install it
  logs [system|api|event|playback]
                         Show the server's logs
  config [get KEY|set KEY VALUE|docs]
                         Edit config/defaults.json; or read or change one setting
  engine [use|enable|disable NAME | auto-switch offer|off]
                         Show the engines and their policy, or change it (config/engines.json)
  places [IN, AE | mumbai | -IN | all]
                         Show or set where worlds may be
  countries [FILTER]     List the countries worlds can be in, with their codes
  cities [FILTER] | cities export [FILE] [FILTER]
                         List every supported city, or save the list as CSV
  test [all|unit|api|replay|benchmark|sumo|ui|launcher]
                         Run test stages
  sumo                   Check the SUMO toolchain on a synthetic grid
{modules}
  reset [SCOPE...] [--yes]
                         Reset everything but connected applications and their settings. Scopes:
                         all, runtime, cache, settings, setup, seeds, keys, apps, app-settings [ID]
  version                Show the version of every part: launcher, server, API, observer and engines
  help, license

Run options (start, seeds save)
  --seed N               Decimal or 0x hexadecimal, up to 128 bits
  --saved-seed ID        Run a saved configuration
  --save-seed ID         Save this configuration under ID
  --description TEXT     Note stored with --save-seed
  --day-type weekday|weekend
  --duration SECONDS     60 to 3600: wall-clock length of the day at 1x
  --speed X              0.01 to 10
  --max-nodes N          2 to 50000
  --engine NAME          core-legacy or core-ng, for this run (engines.selected otherwise)
  --accept-risk          Accept, for this run, the risk of an alpha or beta engine instead of acknowledging it in
                         the observer
  --osm-file PATH        Run this map instead of letting the seed choose
  --default-settings     Open the observer with its settings at their defaults
  --apps ID,ID           Start these applications with the run. The run waits until they are ready
  --no-apps              Start no applications, not even those set to start with every run
  --open, --no-open      Open the observer in a browser (default: when a desktop is present)
  --narrator MODE        Plain-language news: auto (Apple Foundation Models where available),
                         fm, off, or a Chat Completions endpoint http://HOST:PORT | unix:/PATH.
                         Falls back to the default wording, and says why, when unavailable

Interface options
  --reduced-ui           Use compatibility mode (numbered menus)
  --no-tui               Use plain line-oriented mode
  --no-color             Disable colour (NO_COLOR is also honoured)
  --no-splash            Skip the start-up screen
  --no-animation         Keep activity indicators static
  --debug                Verbose diagnostics
  --verbose, -v          Show command output while tests and builds run
  --yes, -y              Do not ask for confirmation (reset)
  --mode=server          Run the C++ server in the foreground

Console
  -c 'LINE'              Run a command line: commands joined by | && || and ;
  shell                  Read command lines until exit
  ls, cat, tail, head, ps, get, env, uptime
                         Read the launcher's state as plain text, to pipe: ./launcher ps | grep server
  grep, wc, sort, uniq, cut, tee, echo
                         Filter what is piped to them, inside a -c line or the shell

  ./launcher -c 'logs api | grep 500 | wc -l'
  ./launcher -c 'stop && start --seed 42 --no-open'

In the terminal interface, : or / opens the command bar, where all of this can be typed as in a
shell, with cd, kill and history besides.

Documentation: https://dstns.readthedocs.io/guide/operator-cli/
"
    )
}

/// Everything a command is given to work with.
pub struct Context {
    pub args: Arguments,
    pub caps: Capabilities,
    pub out: Output,
    pub reporter: Arc<LineReporter>,
    pub session: Arc<Session>,
    pub paths: Paths,
}

// --- Scripted commands --------------------------------------------------------------------------------------------

fn command_seeds(context: &Context) -> Result<i32> {
    let action = context.args.topic.clone().unwrap_or_default();
    if !["save", "list", "inspect", "delete"].contains(&action.as_str()) {
        return Err(LauncherError::config("Usage: dstns seeds save|list|inspect|delete [ID]"));
    }
    let mut data = json!({"id": context.args.item, "description": context.args.run.description});
    if action == "save" {
        data["config"] = config::start_request(&context.args.run, &context.paths)?;
        data["description"] = json!(context.args.run.description.clone().unwrap_or_default());
    }
    println!("{}", serde_json::to_string_pretty(&seeds::operate(&action, &data, &context.paths)?).unwrap());
    Ok(EXIT_OK)
}

fn command_ui(context: &Context) -> Result<i32> {
    let paths = &context.paths;
    let reporter = context.reporter.as_ref();
    let s = |p: std::path::PathBuf| p.to_string_lossy().into_owned();
    match context.args.topic.clone().unwrap_or_else(|| "open".into()).to_lowercase().as_str() {
        "build" => {
            let plan = crate::buildplan::plan(paths, false, true);
            let observer: Vec<&crate::buildplan::Step> = plan.steps.iter().filter(|s| s.observer).collect();
            crate::buildplan::execute(&observer, reporter, paths, None)?;
            reporter.message(Level::Success, "Observer bundle rebuilt", "");
        }
        "dev" => {
            reporter.message(Level::Info, "Starting the observer development server (Vite)", "");
            if paths.observer_build() != paths.ui_engine() {
                crate::buildplan::mirror_observer(paths)?;
            }
            let status = std::process::Command::new("npm").args(["run", "dev", "--prefix", &s(paths.observer_build())]).status()?;
            return Ok(status.code().unwrap_or(1));
        }
        "install" => {
            if paths.observer_build() != paths.ui_engine() {
                crate::buildplan::mirror_observer(paths)?;
            }
            crate::process::Run::new(vec!["npm".into(), "install".into(), "--prefix".into(), s(paths.observer_build())]).run(|line| reporter.step_output("npm", line))?;
            reporter.message(Level::Success, "Observer dependencies installed", "");
        }
        "open" => {
            let port = server::active_port(paths).ok_or_else(|| LauncherError::generic("No current observer server is running. Use ./launcher start first."))?;
            let url = format!("http://127.0.0.1:{port}/");
            if simulation::open_in_browser(&url) {
                reporter.message(Level::Success, "Opened the observer", &url);
            } else {
                reporter.message(Level::Warning, "Open this address in your browser", &url);
            }
        }
        other => return Err(LauncherError::config(format!("Unknown UI action: {other}. Available actions: open, dev, build, install"))),
    }
    Ok(EXIT_OK)
}

fn command_logs(context: &Context) -> Result<i32> {
    let out = &context.out;
    let source = context.args.topic.clone().unwrap_or_else(|| "system".into()).to_lowercase();
    if source == "system" {
        match logs::system_tail(100, &context.paths) {
            None => out.message(Level::Info, "No system log yet", ""),
            Some(lines) => {
                out.message(Level::Info, &format!("System log · last {} lines", lines.len()), "");
                for line in lines {
                    out.line(&line);
                }
            }
        }
        return Ok(EXIT_OK);
    }
    if !logs::TABLES.iter().any(|(key, _, _)| *key == source) {
        out.message(Level::Warning, "Unknown log source", &source);
        return Ok(EXIT_OK);
    }
    match logs::journal(&source, 100, &context.paths) {
        None => out.message(Level::Info, "No runtime database yet", ""),
        Some(table) if table.rows.is_empty() => out.message(Level::Info, "No log records found", ""),
        Some(table) => out.table(&table.columns.iter().map(|c| c.as_str()).collect::<Vec<_>>(), &table.rows, 60),
    }
    Ok(EXIT_OK)
}

fn shown(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// config, config get KEY, config set KEY VALUE.
pub fn command_config(context: &Context) -> Result<i32> {
    let out = &context.out;
    let paths = &context.paths;
    match context.args.topic.as_deref() {
        // The schemas in config/schema/ and each file's _help, from the settings table; values are left as they are.
        Some("docs") => {
            for line in crate::schema::write(paths)? {
                out.message(Level::Success, "Written", &line);
            }
            Ok(EXIT_OK)
        }
        Some("get") => {
            let key = context.args.item.clone().ok_or_else(|| LauncherError::config("Usage: ./launcher config get KEY"))?;
            let field = config::field(&key).ok_or_else(|| LauncherError::config(format!("No setting {key}.")).remedy("./launcher config lists them."))?;
            println!("{}", shown(&field.get(&config::load(paths)?)));
            Ok(EXIT_OK)
        }
        Some("set") => {
            let key = context.args.item.clone().ok_or_else(|| LauncherError::config("Usage: ./launcher config set KEY VALUE"))?;
            set_setting(context, &key, &context.args.extra.join(" "))
        }
        Some(other) => Err(LauncherError::config(format!("Unknown config action: {other}")).remedy("Use ./launcher config, config get KEY or config set KEY VALUE.")),
        None => {
            let current = config::load(paths)?;
            out.heading("config/defaults.json");
            for category in config::categories() {
                out.heading(category);
                let rows: Vec<(String, String)> = config::fields()
                    .iter()
                    .filter(|f| f.category == category)
                    .map(|f| (f.key.to_string(), format!("{} {}", f.display(&f.get(&current)), f.unit).trim().to_string()))
                    .collect();
                out.pairs(&rows, 30);
            }
            out.blank();
            out.muted("Edit interactively with ./launcher config in a terminal, or ./launcher config set KEY VALUE.");
            Ok(EXIT_OK)
        }
    }
}

/// One setting changed, checked as the configuration screen checks it, with what changed with it said.
fn set_setting(context: &Context, key: &str, text: &str) -> Result<i32> {
    let out = &context.out;
    let paths = &context.paths;
    let field = config::field(key).ok_or_else(|| LauncherError::config(format!("No setting {key}.")).remedy("./launcher config lists them."))?;
    let mut current = config::load(paths)?;
    let value = field.parse(text).map_err(|problem| LauncherError::config(format!("{}: {problem}", field.label)))?;
    let problem = config::check_field(field, &value, &current);
    if !problem.is_empty() {
        return Err(LauncherError::config(format!("{}: {problem}", field.label)));
    }
    // Removing the protection of an unstable engine is confirmed, and said to be a risk.
    if let Some(risk) = config::risky_change(field, &value) {
        out.message(Level::Warning, "This is a risk", &risk);
        if !context.args.yes && !(context.caps.interactive && out.confirm("Change it anyway?", false)) {
            return Err(LauncherError::config("Not changed.").remedy(format!("./launcher config set {key} {text} --yes changes it without asking.")));
        }
    }
    let also = field.set(&mut current, value.clone());
    config::save(&current, paths)?;
    out.message(Level::Success, &format!("{} is now {}", field.label, field.display(&value)), key);
    for other in also {
        if let Some(other) = config::field(other) {
            out.message(Level::Info, &format!("{} is now {}, as it must be", other.label, other.display(&other.get(&current))), other.key);
        }
    }
    Ok(EXIT_OK)
}

/// `./launcher engine`: the engines and their policy, or one change to it.
fn command_engine(context: &Context) -> Result<i32> {
    let usage = || LauncherError::config("Usage: ./launcher engine [use NAME | enable NAME | disable NAME | auto-switch offer|off]").remedy(format!("Engines: {}.", config::ENGINES.join(", ")));
    let name = || -> Result<String> {
        let name = context.args.item.clone().ok_or_else(usage)?;
        if !config::ENGINES.contains(&name.as_str()) {
            return Err(LauncherError::config(format!("No engine {name}.")).remedy(format!("Engines: {}.", config::ENGINES.join(", "))));
        }
        Ok(name)
    };
    match context.args.topic.as_deref() {
        None | Some("show") | Some("list") => {
            context.out.heading("Engines");
            for line in config::engines_summary(&context.paths) {
                println!("  {line}");
            }
            context.out.blank();
            context.out.muted("Change with: ./launcher engine use NAME, engine enable NAME, engine disable NAME, engine auto-switch offer|off.");
            Ok(EXIT_OK)
        }
        Some("use") | Some("select") => set_setting(context, "engines.selected", &name()?),
        Some("enable") => set_setting(context, &format!("engines.engines.{}.enabled", name()?), "true"),
        Some("disable") => {
            let name = name()?;
            // The selected engine must be one that may run: disabling it selects the default instead.
            if config::setting(&config::load(&context.paths)?, "engines.selected") == json!(name) && name != config::DEFAULT_ENGINE {
                set_setting(context, "engines.selected", config::DEFAULT_ENGINE)?;
            }
            set_setting(context, &format!("engines.engines.{name}.enabled"), "false")
        }
        Some("auto-switch") => set_setting(context, "engines.auto_switch", &context.args.item.clone().ok_or_else(usage)?),
        Some(_) => Err(usage()),
    }
}

/// `./launcher places`: where worlds may be; `places IN, AE`, `places -IN` or `places all` changes it.
fn command_places(context: &Context) -> Result<i32> {
    let words: Vec<String> = context.args.topic.iter().chain(context.args.item.iter()).chain(context.args.extra.iter()).cloned().collect();
    if words.is_empty() {
        let current = config::load(&context.paths)?;
        let (version, _) = config::map_selection(&current)?;
        let shown = |key: &str| config::field(key).map(|f| f.display(&f.get(&current))).unwrap_or_default();
        context.out.pairs(&[("Places".into(), shown("map.places")), ("Where worlds are".into(), shown("map.selection_mode")), ("Policy".into(), version)], 18);
        context.out.muted("Change with: ./launcher places IN, AE (countries), places mumbai, delhi (cities), places -IN (all but India) or places all.");
        return Ok(EXIT_OK);
    }
    // Every city, read by what Places lists: two-letter codes are countries, other names cities. Only core-ng chooses
    // among them, so anything but all moves to it.
    if !words.join(" ").trim().eq_ignore_ascii_case("all") && config::setting(&config::load(&context.paths)?, "engines.selected") != serde_json::json!("core-ng") {
        set_setting(context, "engines.selected", "core-ng")?;
    }
    set_setting(context, "map.selection_mode", "global")?;
    set_setting(context, "map.places", &words.join(" "))
}

/// `./launcher countries [FILTER]` and `./launcher cities [FILTER]`, or `cities export [FILE] [FILTER]`: the catalogue.
fn command_catalogue(context: &Context) -> Result<i32> {
    let all = crate::modules::fastboot::cities(&context.paths)?;
    let export = context.args.command.as_deref() == Some("cities") && context.args.topic.as_deref() == Some("export");
    let words: Vec<String> = if export {
        context.args.extra.clone()
    } else {
        context.args.topic.iter().chain(context.args.item.iter()).chain(context.args.extra.iter()).cloned().collect()
    };
    let needle = words.join(" ").to_lowercase();
    let text = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let matches = |c: &Value| needle.is_empty() || ["city", "country", "country_code", "id"].iter().any(|k| text(c, k).to_lowercase().contains(&needle));
    let shown: Vec<&Value> = all.iter().filter(|c| matches(c)).collect();
    if export {
        let target = context.args.item.clone().map(std::path::PathBuf::from).unwrap_or_else(|| context.paths.root.join("output").join("dstns-supported-cities.csv"));
        if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| LauncherError::generic(format!("{} could not be made: {e}", parent.display())))?;
        }
        std::fs::write(&target, crate::modules::fastboot::csv(&shown)).map_err(|e| LauncherError::generic(format!("{} could not be written: {e}", target.display())))?;
        context.out.message(Level::Success, &format!("{} cities saved as CSV", shown.len()), &target.display().to_string());
        return Ok(EXIT_OK);
    }
    if context.args.command.as_deref() == Some("countries") {
        let mut by_code: std::collections::BTreeMap<String, (String, usize)> = std::collections::BTreeMap::new();
        for c in &all {
            by_code.entry(text(c, "country_code")).or_insert_with(|| (text(c, "country"), 0)).1 += 1;
        }
        let mut rows: Vec<(String, String, usize)> = by_code.into_iter().map(|(code, (name, n))| (code, name, n)).filter(|(code, name, _)| needle.is_empty() || code.to_lowercase().contains(&needle) || name.to_lowercase().contains(&needle)).collect();
        rows.sort_by(|a, b| a.1.cmp(&b.1));
        println!("{:<6}{:<28}{}", "Code", "Country", "Cities");
        for (code, name, n) in &rows {
            println!("{code:<6}{name:<28}{n}");
        }
        context.out.muted(&format!("{} countries. Choose with ./launcher places CODE, CODE.", rows.len()));
        return Ok(EXIT_OK);
    }
    println!("{:<22}{:<26}{:<6}{:<22}{}", "City", "Country", "Code", "ID", "Since");
    for c in &shown {
        println!("{:<22}{:<26}{:<6}{:<22}{}", text(c, "city"), text(c, "country"), text(c, "country_code"), text(c, "id"), if text(c, "since") == "urban-geo-v2" { "urban-geo-v2" } else { "urban-crfg-v3" });
    }
    context.out.muted(&format!("{} of {} cities. ./launcher cities export [FILE] [FILTER] saves them as CSV.", shown.len(), all.len()));
    Ok(EXIT_OK)
}

fn command_test(context: &Context) -> Result<i32> {
    let out = &context.out;
    let scope = context.args.topic.clone().unwrap_or_else(|| "all".into()).to_lowercase();
    let results = testing::run(&scope, context.reporter.as_ref(), &context.paths);
    out.heading("Test summary");
    let rows: Vec<Vec<String>> = results.iter().map(|r| vec![r.title.clone(), if r.passed { "PASS" } else { "FAIL" }.into(), format!("{:.1} s", r.seconds)]).collect();
    out.table(&["Stage", "Result", "Duration"], &rows, 48);
    let failed: Vec<&testing::StageResult> = results.iter().filter(|r| !r.passed).collect();
    if let Some(first) = failed.first() {
        out.blank();
        out.message(Level::Error, &format!("{} of {} stage(s) failed", failed.len(), results.len()), &first.title);
        for line in first.detail.lines() {
            out.muted(&format!("  {line}"));
        }
        return Ok(EXIT_FAILURE);
    }
    out.message(Level::Success, &format!("All {} test stages passed", results.len()), "");
    Ok(EXIT_OK)
}

fn command_reset(context: &Context) -> Result<i32> {
    let out = &context.out;
    let words: Vec<String> = context.args.topic.iter().chain(context.args.item.iter()).chain(context.args.extra.iter()).cloned().collect();
    let scopes = maintenance::parse(&words).map_err(|why| LauncherError::config(why).remedy("./launcher help reset lists the scopes."))?;
    // Without a terminal to ask at, nothing is deleted unless --yes says so.
    if !context.args.yes && !context.caps.interactive {
        return Err(LauncherError::runtime("A reset deletes data, and there is no terminal to ask at.").remedy(format!("Run ./launcher reset {}--yes to confirm it.", words.iter().map(|w| format!("{w} ")).collect::<String>())));
    }
    if !context.args.yes {
        out.line("This resets:");
        for line in maintenance::describe(&context.paths, &scopes) {
            out.line(&format!("  {line}"));
        }
        if !out.confirm("Reset these?", false) {
            out.message(Level::Info, "Reset cancelled", "");
            return Ok(EXIT_OK);
        }
    }
    maintenance::reset(context.reporter.as_ref(), &context.paths, &scopes).map_err(LauncherError::runtime)?;
    Ok(EXIT_OK)
}

/// Stop the server this launcher would use, and the applications it started.
pub fn command_stop(context: &Context) -> Result<i32> {
    let Some(port) = server::active_port(&context.paths) else {
        context.out.message(Level::Info, "No server is running", "");
        return Ok(EXIT_OK);
    };
    let handle = server::ServerHandle::attached(port);
    if server::shut_down(&handle, &context.paths) {
        context.out.message(Level::Success, "Stopped the DSTNS server", &format!("port {port}"));
        Ok(EXIT_OK)
    } else {
        Err(LauncherError::runtime(format!("The server on port {port} did not stop.")).remedy("See logs/system.log."))
    }
}

/// Start without a terminal: follow the server and report its fate as our own.
fn command_start_headless(context: &Context) -> Result<i32> {
    let session = &context.session;
    session.launch(&context.args.run, context.reporter.clone(), context.args.open, crate::process::Cancel::new())?;
    let Some(handle) = session.handle() else { return Ok(EXIT_OK) };
    if !handle.managed() {
        return Ok(EXIT_OK);
    }
    loop {
        if crate::signals::terminated() {
            return Ok(EXIT_TERMINATED);
        }
        if let Some(code) = handle.exit_code() {
            return Ok(if code == 0 || code == -1 { EXIT_OK } else { EXIT_FAILURE });
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Run a command without an interface: what the launcher does with arguments and no terminal, and what the command
/// bar runs in-process. `interactive` says whether the interface may be opened instead.
pub fn dispatch_scripted(context: &Context) -> Option<Result<i32>> {
    let command = context.args.command.clone();
    if context.args.mode.as_deref() == Some("server") {
        return Some(server::run_foreground(&context.paths));
    }
    if let Some(module) = command.as_deref().and_then(modules::find) {
        return Some((module.run)(context));
    }
    match command.as_deref() {
        Some("help") => {
            print!("{}", help());
            Some(Ok(EXIT_OK))
        }
        Some("version") => {
            println!("{PRODUCT} {}", engine_version());
            context.out.pairs(&version::parts(&context.paths), 16);
            context.out.blank();
            for line in version::licence_lines(context.caps.unicode) {
                println!("{line}");
            }
            Some(Ok(EXIT_OK))
        }
        Some("license") => {
            match std::fs::read_to_string(context.paths.root.join("LICENSE")) {
                Ok(text) => print!("{text}"),
                Err(_) => println!("GNU Affero General Public License v3 or later — https://www.gnu.org/licenses/agpl-3.0.html"),
            }
            Some(Ok(EXIT_OK))
        }
        Some("seeds") => Some(command_seeds(context)),
        Some("ui") => Some(command_ui(context)),
        Some("test") => Some(command_test(context)),
        Some("sumo") => Some(sumo::run_standalone(context.reporter.as_ref(), &context.paths).map(|summary| {
            context.out.pairs(&summary, 20);
            EXIT_OK
        })),
        Some("reset") => Some(command_reset(context)),
        Some("stop") => Some(command_stop(context)),
        Some("logs") if context.args.topic.is_some() || !context.caps.interactive => Some(command_logs(context)),
        Some("config") if context.args.topic.is_some() || !context.caps.interactive => Some(command_config(context)),
        Some("engine") => Some(command_engine(context)),
        Some("places") => Some(command_places(context)),
        Some("countries") | Some("cities") => Some(command_catalogue(context)),
        Some(other) if !COMMANDS.contains(&other) => Some(Err(LauncherError::config(format!("Unknown command: {other}")).remedy("./launcher help lists every command."))),
        _ => None,
    }
}

/// Pages `./launcher ui PAGE` opens the interface on.
pub const UI_PAGES: &[&str] = &["dashboard", "start", "running", "apps", "seeds", "config", "demo", "fastboot", "diagnostics", "logs", "tests", "tools", "about", "setup"];

/// Under Advanced Security, the person at this machine confirms it's them; otherwise nothing happens.
pub fn verify(paths: &Paths, reason: &str) -> Result<()> {
    crate::security::require(paths, reason)
        .map_err(|why| LauncherError::config(format!("Advanced Security: {why}")).remedy("Advanced Security is on for this checkout: the person at this machine has to confirm it's them."))
}

pub fn run(argv: Vec<String>) -> i32 {
    let paths = Paths::default();
    crate::setup::load_env(&paths);
    // launch CODE: become the launcher the code describes and start, carrying on from where it was.
    let mut argv = argv;
    if argv.first().map(String::as_str) == Some("launch") {
        let Some(code) = argv.get(1).cloned() else {
            eprintln!("launch needs a code: ./launcher launch CODE (launch-code prints one).");
            return 2;
        };
        argv = [vec!["--state".to_string(), code, "start".to_string()], argv[2..].to_vec()].concat();
    }
    // --state CODE: become the launcher the code describes, then carry on with whatever else was asked.
    if let Some(at) = argv.iter().position(|a| a == "--state" || a.starts_with("--state=")) {
        let code = match argv[at].split_once('=') {
            Some((_, code)) => code.to_string(),
            None if at + 1 < argv.len() => argv.remove(at + 1),
            None => {
                eprintln!("--state needs a code: ./launcher --state CODE (state get prints one).");
                return 2;
            }
        };
        argv.remove(at);
        if let Err(why) = crate::security::require(&paths, "apply a launcher state code") {
            eprintln!("Advanced Security: {why}");
            return 1;
        }
        match crate::state::set(&paths, &code) {
            Ok(lines) => lines.iter().for_each(|l| eprintln!("{l}")),
            Err(why) => {
                eprintln!("{why}");
                return 1;
            }
        }
    }
    // The console: a line run as a shell would (-c), lines read until exit (shell), or one of its own commands, which
    // print plain text for a system shell to pipe. `help` stays the launcher's.
    match argv.first().map(String::as_str) {
        Some("-c") => return crate::console::run_line(&argv[1..].join(" "), &paths),
        Some("shell") | Some("sh") => return crate::console::repl(&paths),
        Some(first) if first != "help" && (crate::console::is_builtin(first) || argv.iter().any(|a| ["|", "||", "&&", ";"].contains(&a.as_str()))) => {
            // Operators given as words of their own stay operators; every other word is quoted as it was.
            let line = argv.iter().map(|a| if ["|", "||", "&&", ";"].contains(&a.as_str()) { a.clone() } else { shlex::try_quote(a).map(|q| q.into_owned()).unwrap_or_else(|_| a.clone()) }).collect::<Vec<_>>().join(" ");
            return crate::console::run_line(&line, &paths);
        }
        _ => {}
    }
    let debug = argv.iter().any(|a| a == "--debug");
    crate::log::configure(&paths, debug, debug);
    let caps = crate::terminal::detect(argv.iter().any(|a| a == "--no-color"));
    let session = Session::new(paths.clone());
    let outcome = (|| -> Result<i32> {
        let args = parse(&argv)?;
        if args.no_color {
            std::env::set_var("NO_COLOR", "1");
        }
        crate::log::info(&format!("arguments: {} · terminal: {}", if argv.is_empty() { "(none)".into() } else { argv.join(" ") }, caps.summary()));
        let reporter = Arc::new(LineReporter::new(Output::new(&caps), args.verbose));
        let context = Context { args: args.clone(), caps: caps.clone(), out: Output::new(&caps), reporter, session: session.clone(), paths: paths.clone() };
        crate::signals::install(session.clone());
        // `ui PAGE`: the interface, opened on that page.
        let page = args.topic.clone().filter(|t| args.command.as_deref() == Some("ui") && UI_PAGES.contains(&t.as_str()));
        if let Some(page) = page {
            if !caps.interactive {
                return Err(LauncherError::config("./launcher ui PAGE needs a terminal."));
            }
            verify(&paths, "open the DSTNS launcher")?;
            return Ok(crate::interface::run_interactive(context, &page));
        }
        // A command that changes something asks first, under Advanced Security; one that only reads never does.
        let words: Vec<String> = [args.command.clone(), args.topic.clone(), args.item.clone()].into_iter().flatten().collect();
        if !words.is_empty() && !crate::security::reads_only(&words) && !(words.len() == 1 && caps.interactive && ["console", "start", "config", "logs", "setup"].contains(&words[0].as_str())) {
            verify(&paths, &format!("run ./launcher {}", words.join(" ")))?;
        }
        if let Some(result) = dispatch_scripted(&context) {
            return result;
        }
        let command = match args.command.as_deref() {
            None if args.run.explicit() || args.run.apps.is_some() || !caps.interactive => "start",
            None => "console",
            Some(c) => c,
        };
        if command == "start" && !caps.interactive {
            return command_start_headless(&context);
        }
        if !caps.interactive {
            print!("{}", help());
            return Ok(EXIT_OK);
        }
        let initial = match command {
            "start" => "start",
            "config" => "config",
            "logs" => "logs",
            "setup" => "setup",
            _ => "home",
        };
        verify(&paths, "open the DSTNS launcher")?;
        Ok(crate::interface::run_interactive(context, initial))
    })();
    let code = match outcome {
        Ok(code) => code,
        Err(error) if error.is_cancelled() => EXIT_INTERRUPTED,
        Err(error) => {
            crate::log::error(&format!("{} {}", error.message, error.detail));
            let out = Output::new(&caps);
            out.message(Level::Error, &error.message, "");
            for line in error.remedy.lines() {
                out.muted(&format!("  {line}"));
            }
            let lines: Vec<&str> = error.detail.lines().collect();
            for line in &lines[lines.len().saturating_sub(14)..] {
                out.muted(&format!("  {line}"));
            }
            EXIT_FAILURE
        }
    };
    session.cleanup();
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Arguments> {
        parse(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn every_existing_flag_is_accepted() {
        let parsed = args(&["start", "--seed", "42", "--day-type", "weekend", "--speed", "3", "--apps", "a,b", "--no-open", "--save-seed", "x"]).unwrap();
        assert_eq!(parsed.command.as_deref(), Some("start"));
        assert_eq!(parsed.run.seed.as_deref(), Some("42"));
        assert_eq!(parsed.run.day_type.as_deref(), Some("weekend"));
        assert_eq!(parsed.run.apps.as_deref(), Some("a,b"));
        assert!(!parsed.open);
    }

    #[test]
    fn errors_keep_their_messages() {
        assert_eq!(args(&["--seed"]).unwrap_err().message, "Missing value for --seed");
        assert!(args(&["--bogus"]).unwrap_err().message.contains("Unknown option: --bogus"));
        assert!(args(&["--day-type", "holiday"]).unwrap_err().message.contains("weekday or weekend"));
        assert!(args(&["--narrator", "ftp://x"]).unwrap_err().message.contains("not a narration mode"));
    }

    #[test]
    fn module_commands_read_their_own_arguments() {
        let parsed = args(&["apps", "add", "org.x", "--command", "python3 x.py"]).unwrap();
        assert_eq!(parsed.command.as_deref(), Some("apps"));
        assert_eq!(parsed.rest, vec!["add", "org.x", "--command", "python3 x.py"]);
    }

    #[test]
    fn config_set_takes_negative_numbers() {
        let parsed = args(&["config", "set", "performance.render_scale", "1.5"]).unwrap();
        assert_eq!(parsed.extra, vec!["1.5"]);
    }

    #[test]
    fn help_lists_every_command() {
        let text = help();
        for command in ["start", "stop", "setup", "apps", "fabric", "fastboot", "demo", "mcp"] {
            assert!(text.contains(command), "{command}");
        }
    }
}
