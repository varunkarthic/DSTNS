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

const VALUE_OPTIONS: &[&str] = &["--seed", "--saved-seed", "--save-seed", "--day-type", "--osm-file", "--max-nodes", "--duration", "--speed", "--description", "--apps"];
pub const COMMANDS: &[&str] = &["start", "stop", "console", "seeds", "ui", "logs", "config", "test", "sumo", "reset", "setup", "help", "version", "license"];

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
  config [get KEY|set KEY VALUE]
                         Edit config/defaults.json; or read or change one setting
  test [all|unit|api|replay|benchmark|sumo|ui|launcher]
                         Run test stages
  sumo                   Check the SUMO toolchain on a synthetic grid
{modules}
  reset [--yes]          Delete runtime logs, checkpoints and temporary files, and forget the setup
  help, version, license

Run options (start, seeds save)
  --seed N               Decimal or 0x hexadecimal, up to 128 bits
  --saved-seed ID        Run a saved configuration
  --save-seed ID         Save this configuration under ID
  --description TEXT     Note stored with --save-seed
  --day-type weekday|weekend
  --duration SECONDS     60 to 3600: wall-clock length of the day at 1x
  --speed X              0.01 to 10
  --max-nodes N          2 to 50000
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
        Some("get") => {
            let key = context.args.item.clone().ok_or_else(|| LauncherError::config("Usage: ./launcher config get KEY"))?;
            let field = config::field(&key).ok_or_else(|| LauncherError::config(format!("No setting {key}.")).remedy("./launcher config lists them."))?;
            println!("{}", shown(&field.get(&config::load(paths)?)));
            Ok(EXIT_OK)
        }
        Some("set") => {
            let key = context.args.item.clone().ok_or_else(|| LauncherError::config("Usage: ./launcher config set KEY VALUE"))?;
            let text = context.args.extra.join(" ");
            let field = config::field(&key).ok_or_else(|| LauncherError::config(format!("No setting {key}.")).remedy("./launcher config lists them."))?;
            let mut current = config::load(paths)?;
            let value = field.parse(&text).map_err(|problem| LauncherError::config(format!("{}: {problem}", field.label)))?;
            let problem = config::check_field(field, &value, &current);
            if !problem.is_empty() {
                return Err(LauncherError::config(format!("{}: {problem}", field.label)));
            }
            let also = field.set(&mut current, value.clone());
            config::save(&current, paths)?;
            out.message(Level::Success, &format!("{} is now {}", field.label, field.display(&value)), &key);
            for other in also {
                if let Some(other) = config::field(other) {
                    out.message(Level::Info, &format!("{} is now {}, as it must be", other.label, other.display(&other.get(&current))), other.key);
                }
            }
            Ok(EXIT_OK)
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
    if !context.args.yes && context.caps.interactive {
        out.line("This deletes runtime logs, the SQLite journal, checkpoints, temporary");
        out.line("scenarios and SUMO runs, and forgets the launcher's setup. Maps, saved");
        out.line("seeds and configuration are kept.");
        if !out.confirm("Reset runtime state?", false) {
            out.message(Level::Info, "Reset cancelled", "");
            return Ok(EXIT_OK);
        }
    }
    maintenance::reset(context.reporter.as_ref(), &context.paths);
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
        Some(other) if !COMMANDS.contains(&other) => Some(Err(LauncherError::config(format!("Unknown command: {other}")).remedy("./launcher help lists every command."))),
        _ => None,
    }
}

/// Pages `./launcher ui PAGE` opens the interface on.
pub const UI_PAGES: &[&str] = &["dashboard", "start", "running", "apps", "seeds", "config", "demo", "fastboot", "diagnostics", "logs", "tests", "tools", "about", "setup"];

pub fn run(argv: Vec<String>) -> i32 {
    let paths = Paths::default();
    crate::setup::load_env(&paths);
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
            return Ok(crate::interface::run_interactive(context, &page));
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
