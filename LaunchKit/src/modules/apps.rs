// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! `./launcher apps`: the applications this launcher can start.

use super::{port, Command, Module, Options, Page};
use crate::apps::{self as catalogue, App};
use crate::cli::{Context, EXIT_FAILURE, EXIT_OK};
use crate::errors::{LauncherError, Result};
use crate::fabric;
use crate::process::Cancel;
use crate::reporting::Level;
use crate::supervisor::{tail, Phase, Supervisor};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const USAGE: &str = "usage: ./launcher apps [list|add|set|show|remove|run|start|status|logs|doctor|proposals|approve|reject]

  list [--json]             Show them all
  add ID [options]          Add one
  set ID [options]          Change one: only what is given
  show ID [--json]          Show one
  remove ID                 Remove one
  run [ID ...]              Start these and look after them until Ctrl+C, with no simulation.
                            Starts a server if none is running
  start [ID ...]            The same as run
  status                    What the server knows of each
  logs ID [-n N]            An application's output
  doctor [ID]               Find what would stop them from starting
  proposals                 Launch entries proposed through the Fabric API
  approve ID [--yes]        Accept a proposal, after reading exactly what it runs
  reject ID                 Turn a proposal down

Options for add and set
  --command CMD             A command to run. Repeat for several: all but the last must finish, and
                            the last stays running. {url}, {port}, {id} and {root} are filled in
  --name NAME               What to call it
  --cwd DIR                 Where to run it, relative to this checkout
  --env KEY=VALUE           An environment variable
  --ready HOW               fabric (default), process, delay:SECONDS, or a URL
  --timeout SECONDS         Seconds to wait until it is ready
  --restart never|on-failure
  --required, --no-required Stop the simulation from starting if this fails
  --autostart, --no-autostart
                            Start with every simulation unless told otherwise
  --grant CAPABILITY        A permission to give it when it registers
  --web URL                 Its own web interface: the observer offers a button that opens it
  --web-label TEXT          What that button says (default: Open NAME)
  --setting KEY=VALUE       A setting to give it when it registers (read as JSON if it can be)
";

const WITH_VALUE: &[&str] = &["--command", "--name", "--cwd", "--env", "--ready", "--timeout", "--restart", "--grant", "--web", "--web-label", "--setting", "-n"];
const SWITCHES: &[&str] = &["--required", "--no-required", "--autostart", "--no-autostart", "--json", "--yes", "-y", "--help", "-h"];

pub fn module() -> Module {
    Module {
        commands: vec![Command {
            name: "apps",
            usage: "apps [list|add|set|show|remove|run|start|status|logs|doctor|proposals|approve|reject]",
            summary: "The applications this launcher can start alongside a simulation",
            run,
        }],
        pages: vec![Page { key: "apps", label: "Applications", before: "seeds" }],
    }
}

fn pairs(values: Vec<String>, what: &str) -> Result<Vec<(String, String)>> {
    values
        .into_iter()
        .map(|value| value.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).ok_or_else(|| LauncherError::config(format!("\"{value}\" is not {what}.")).remedy("Write it as KEY=VALUE.")))
        .collect()
}

fn json_or_text(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| json!(text))
}

fn apply(mut app: App, options: &Options) -> Result<App> {
    let commands = options.all("--command");
    if !commands.is_empty() {
        app.commands = commands;
    }
    if let Some(v) = options.value("--name") {
        app.name = v;
    }
    if let Some(v) = options.value("--cwd") {
        app.cwd = v;
    }
    if let Some(v) = options.value("--ready") {
        app.ready = v;
    }
    if let Some(v) = options.value("--timeout") {
        app.timeout_s = v.parse().map_err(|_| LauncherError::config("--timeout must be a number of seconds"))?;
    }
    if let Some(v) = options.value("--restart") {
        if !catalogue::RESTARTS.contains(&v.as_str()) {
            return Err(LauncherError::config(format!("--restart must be one of {}", catalogue::RESTARTS.join(", "))));
        }
        app.restart = v;
    }
    if options.has("--required") {
        app.required = true;
    }
    if options.has("--no-required") {
        app.required = false;
    }
    if options.has("--autostart") {
        app.autostart = true;
    }
    if options.has("--no-autostart") {
        app.autostart = false;
    }
    if let Some(v) = options.value("--web") {
        app.web_url = v;
    }
    if let Some(v) = options.value("--web-label") {
        app.web_label = v;
    }
    for (key, value) in pairs(options.all("--env"), "an environment variable")? {
        app.env.insert(key, value);
    }
    let mut grants: Vec<String> = app.grants.iter().cloned().chain(options.all("--grant")).collect();
    grants.sort();
    grants.dedup();
    app.grants = grants;
    for (key, value) in pairs(options.all("--setting"), "a setting")? {
        app.settings.insert(key, json_or_text(&value));
    }
    Ok(app)
}

fn ready_words(app: &App) -> String {
    match app.ready.as_str() {
        "fabric" => "It reports itself active through Fabric".into(),
        "process" => "It stays up for a second".into(),
        r if r.starts_with("delay:") => format!("{} s have passed", &r[6..]),
        r => format!("{r} answers"),
    }
}

pub fn summary(app: &App) -> Vec<(String, String)> {
    let mut rows = vec![("ID".to_string(), app.id.clone()), ("Name".into(), app.title())];
    for (n, command) in app.commands.iter().enumerate() {
        rows.push((if app.commands.len() > 1 { format!("Command {}", n + 1) } else { "Command".into() }, command.clone()));
    }
    rows.extend([
        ("Runs in".into(), app.cwd.clone()),
        ("Ready when".into(), ready_words(app)),
        ("Waits up to".into(), format!("{:.0} s", app.timeout_s)),
        ("If it stops".into(), if app.restart == "on-failure" { "Restart it" } else { "Leave it stopped" }.into()),
        ("Required".into(), if app.required { "Yes: the simulation will not start without it" } else { "No" }.into()),
        ("Starts with runs".into(), if app.autostart { "Yes" } else { "Only when chosen" }.into()),
    ]);
    if !app.env.is_empty() {
        rows.push(("Environment".into(), app.env.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ")));
    }
    if !app.grants.is_empty() {
        rows.push(("Permissions".into(), app.grants.join(", ")));
    }
    if !app.settings.is_empty() {
        rows.push(("Settings".into(), Value::Object(app.settings.clone()).to_string()));
    }
    if !app.web_url.is_empty() {
        rows.push(("Web interface".into(), format!("{} ({})", app.web_url, if app.web_label.is_empty() { format!("Open {}", app.title()) } else { app.web_label.clone() })));
    }
    rows
}

pub fn from_proposal(id: &str, spec: &Value) -> App {
    let mut app = App::new(id);
    app.name = spec.get("name").and_then(|v| v.as_str()).unwrap_or("").into();
    app.commands = spec.get("commands").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect()).unwrap_or_default();
    app.cwd = spec.get("cwd").and_then(|v| v.as_str()).unwrap_or(".").into();
    if let Some(env) = spec.get("env").and_then(|v| v.as_object()) {
        app.env = env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect();
    }
    app.ready = spec.get("ready").and_then(|v| v.as_str()).unwrap_or("fabric").into();
    app.timeout_s = spec.get("timeout_s").and_then(|v| v.as_f64()).unwrap_or(60.0);
    app.restart = spec.get("restart").and_then(|v| v.as_str()).unwrap_or("never").into();
    app
}

fn run(context: &Context) -> Result<i32> {
    let options = Options::parse(&context.args.rest, WITH_VALUE, SWITCHES)?;
    if options.has("--help") || options.has("-h") {
        print!("{USAGE}");
        return Ok(EXIT_OK);
    }
    let out = &context.out;
    let paths = &context.paths;
    let action = options.positional.first().cloned().unwrap_or_else(|| "list".into());
    let id = || options.positional.get(1).cloned().ok_or_else(|| LauncherError::config(format!("./launcher apps {action} needs an ID.")));
    match action.as_str() {
        "list" => {
            let apps = catalogue::load(paths)?;
            if options.has("--json") {
                let all: serde_json::Map<String, Value> = apps.iter().map(|(id, app)| (id.clone(), app.to_json())).collect();
                println!("{}", serde_json::to_string_pretty(&Value::Object(all)).unwrap());
                return Ok(EXIT_OK);
            }
            if apps.is_empty() {
                out.message(Level::Info, "No applications yet", "");
                out.muted("Add one with ./launcher apps add org.example.app --command \"python3 app.py --url {url}\"");
                return Ok(EXIT_OK);
            }
            let rows: Vec<Vec<String>> = apps
                .values()
                .map(|a| vec![a.id.clone(), a.title(), if a.autostart { "with runs" } else { "when chosen" }.into(), if a.required { "yes" } else { "no" }.into(), a.commands.last().cloned().unwrap_or_default()])
                .collect();
            out.table(&["ID", "Name", "Starts", "Required", "Command"], &rows, 60);
            Ok(EXIT_OK)
        }
        "add" | "set" => {
            let id = id()?;
            let app = if action == "add" {
                if catalogue::load(paths)?.contains_key(&id) {
                    return Err(LauncherError::config(format!("{id} already exists.")).remedy(format!("Change it with ./launcher apps set {id}.")));
                }
                apply(App::new(&id), &options)?
            } else {
                apply(catalogue::get(&id, paths)?, &options)?
            };
            let app = catalogue::put(app, paths)?;
            out.message(Level::Success, &format!("{} {}", if action == "add" { "Added" } else { "Changed" }, app.title()), "");
            out.pairs(&summary(&app), 18);
            for problem in catalogue::problems(&app, paths) {
                out.message(Level::Warning, &problem, "");
            }
            Ok(EXIT_OK)
        }
        "show" => {
            let app = catalogue::get(&id()?, paths)?;
            if options.has("--json") {
                println!("{}", serde_json::to_string_pretty(&app.to_json()).unwrap());
            } else {
                out.pairs(&summary(&app), 18);
            }
            Ok(EXIT_OK)
        }
        "remove" => {
            let id = id()?;
            catalogue::remove(&id, paths)?;
            out.message(Level::Success, &format!("Removed {id}"), "");
            Ok(EXIT_OK)
        }
        "doctor" => {
            let apps: Vec<App> = match options.positional.get(1) {
                Some(id) => vec![catalogue::get(id, paths)?],
                None => catalogue::load(paths)?.into_values().collect(),
            };
            let mut worst = EXIT_OK;
            for app in apps {
                let found = catalogue::problems(&app, paths);
                if found.is_empty() {
                    out.message(Level::Success, &app.title(), "nothing in the way");
                } else {
                    worst = EXIT_FAILURE;
                    out.message(Level::Error, &app.title(), &found[0]);
                    for problem in &found[1..] {
                        out.muted(&format!("  {problem}"));
                    }
                }
            }
            Ok(worst)
        }
        "logs" => {
            let app = catalogue::get(&id()?, paths)?;
            let path = paths.logs().join("apps").join(format!("{}.log", app.id));
            let count: usize = options.value("-n").and_then(|n| n.parse().ok()).unwrap_or(40);
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    let lines: Vec<&str> = text.lines().collect();
                    for line in &lines[lines.len().saturating_sub(count)..] {
                        out.line(line);
                    }
                }
                Err(_) => out.message(Level::Info, "No output yet", &path.to_string_lossy()),
            }
            Ok(EXIT_OK)
        }
        "status" => {
            let port = port(context)?;
            let known: std::collections::BTreeMap<String, Value> =
                fabric::apps(port, paths).into_iter().filter_map(|a| a.get("id").and_then(|i| i.as_str()).map(|i| (i.to_string(), a.clone()))).collect();
            let mut ids: Vec<String> = catalogue::load(paths)?.into_keys().chain(known.keys().cloned()).collect();
            ids.sort();
            ids.dedup();
            let rows: Vec<Vec<String>> = ids
                .iter()
                .map(|id| {
                    let app = known.get(id);
                    let health = app.and_then(|_| fabric::health(port, id, paths));
                    let pending = app.and_then(|a| a.pointer("/capabilities/pending")).and_then(|p| p.as_array()).map(|p| p.iter().filter_map(|c| c.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                    vec![
                        id.clone(),
                        app.and_then(|a| a.get("state")).and_then(|s| s.as_str()).unwrap_or("not connected").into(),
                        health.as_ref().and_then(|h| h.get("requests")).map(|v| v.to_string()).unwrap_or_default(),
                        health.as_ref().and_then(|h| h.get("refused")).map(|v| v.to_string()).unwrap_or_default(),
                        pending,
                    ]
                })
                .collect();
            if rows.is_empty() {
                out.message(Level::Info, "No applications are connected", "");
            } else {
                out.table(&["ID", "State", "Requests", "Refused", "Waiting for permission"], &rows, 60);
            }
            Ok(EXIT_OK)
        }
        "run" | "start" => run_alone(context, &options.positional[1..]),
        "proposals" => {
            let items = fabric::proposals(port(context)?, paths);
            if items.is_empty() {
                out.message(Level::Info, "No proposals are waiting", "");
            }
            for item in items {
                out.heading(item.get("id").and_then(|v| v.as_str()).unwrap_or(""));
                out.muted(&format!("Proposed by the {}. Nothing runs until you approve it.", item.get("proposed_by").and_then(|v| v.as_str()).unwrap_or("unknown")));
                for command in item.pointer("/spec/commands").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                    out.line(&format!("  {}", command.as_str().unwrap_or("")));
                }
            }
            Ok(EXIT_OK)
        }
        "approve" => {
            let id = id()?;
            let port = port(context)?;
            let proposal = fabric::proposals(port, paths)
                .into_iter()
                .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                .ok_or_else(|| LauncherError::config(format!("No proposal for {id}.")).remedy("./launcher apps proposals shows those waiting."))?;
            let app = from_proposal(&id, proposal.get("spec").unwrap_or(&Value::Null));
            catalogue::validate(&app)?;
            out.heading(&format!("Proposed by the {}", proposal.get("proposed_by").and_then(|v| v.as_str()).unwrap_or("unknown")));
            out.pairs(&summary(&app), 18);
            out.blank();
            out.message(Level::Warning, "These commands will run on this machine, as you", "");
            let yes = options.has("--yes") || options.has("-y");
            if !yes && !(context.caps.interactive && out.confirm("Approve?", false)) {
                out.message(Level::Info, "Not approved", "");
                return Ok(EXIT_OK);
            }
            catalogue::put(app.clone(), paths)?;
            fabric::withdraw(port, &id, paths);
            out.message(Level::Success, &format!("Approved {}", app.title()), "");
            Ok(EXIT_OK)
        }
        "reject" => {
            let id = id()?;
            let response = fabric::withdraw(port(context)?, &id, paths);
            if !response.ok() {
                return Err(LauncherError::generic(response.error_message()));
            }
            out.message(Level::Success, &format!("Turned down {id}"), "");
            Ok(EXIT_OK)
        }
        other => Err(LauncherError::config(format!("Unknown action {other}.")).remedy("./launcher apps --help lists them.")),
    }
}

/// Applications on their own, with no simulation. The server they talk to is started if none is running, and stopped
/// again at the end if it was started here.
fn run_alone(context: &Context, ids: &[String]) -> Result<i32> {
    let out = &context.out;
    let paths = &context.paths;
    let apps: Vec<App> = if ids.is_empty() {
        catalogue::load(paths)?.into_values().filter(|a| a.autostart).collect()
    } else {
        ids.iter().map(|id| catalogue::get(id, paths)).collect::<Result<_>>()?
    };
    if apps.is_empty() {
        return Err(LauncherError::config("No applications to start.").remedy("Name them, as in ./launcher apps run ID, or set one to start by itself."));
    }
    crate::signals::graceful(true);
    let mut handle = None;
    let port = match crate::server::active_port(paths) {
        Some(port) => port,
        None => {
            let started = crate::server::start(context.reporter.as_ref(), paths, true, None, false)?;
            out.message(Level::Info, "No simulation is running", &format!("the server is at {}, waiting for one", started.url()));
            let port = started.port;
            handle = Some(started);
            port
        }
    };
    let supervisor = Supervisor::new(port, context.reporter.clone(), paths, Cancel::new());
    for app in &apps {
        supervisor.start(app.clone());
    }
    out.message(Level::Info, "Starting", &apps.iter().map(|a| a.title()).collect::<Vec<_>>().join(", "));
    out.muted("Press Ctrl+C to stop them.");
    let mut code = EXIT_OK;
    while !crate::signals::interrupted() {
        std::thread::sleep(Duration::from_millis(500));
        let states = supervisor.states();
        if !states.is_empty() && states.iter().all(|s| matches!(s.phase, Phase::Failed | Phase::Stopped)) {
            for s in states.iter().filter(|s| s.phase == Phase::Failed) {
                let why = if s.detail.is_empty() { tail(&s.log, 3) } else { s.detail.clone() };
                out.message(Level::Error, &format!("{} did not stay up", s.app.title()), &why);
                code = EXIT_FAILURE;
            }
            break;
        }
    }
    out.blank();
    stop(&supervisor);
    if let Some(handle) = handle {
        crate::server::shut_down(&handle, paths);
    }
    crate::signals::graceful(false);
    out.message(Level::Info, "Stopped", "");
    Ok(code)
}

fn stop(supervisor: &Arc<Supervisor>) {
    supervisor.stop_all();
    std::thread::sleep(Duration::from_millis(200));
}
