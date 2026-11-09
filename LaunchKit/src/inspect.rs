// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The console's tools for looking inside, and changing, almost everything the launcher keeps.
//!
//! - `json PLACE [PATH]` (or `view`): any of the launcher's state, or the running server's, as indented JSON, with a
//!   path such as `.api.port` or `.items[0].id` to look inside it, `-k` for its keys and `-c` for one line.
//! - `set KEY VALUE` and `unset KEY`: a setting, with the same checks and rules as the Configuration page.
//! - `env set NAME=VALUE`, `env unset NAME`: variables the launcher keeps for its runs, in config/launcher.env.
//! - `edit settings|env|ui|apps|FILE`: in your editor; nothing is saved unless it still reads.
//! - `api METHOD PATH [BODY]`: any route on the running server, as the operator.
//! - `ps -a`: every DSTNS server and launcher on this machine, not only this one's.
//! - `security`: Advanced Security's state; `security on`, `off` and `verify`.

use crate::config;
use crate::paths::Paths;
use serde_json::{json, Value};
use std::io::IsTerminal;
use std::path::PathBuf;

/// Places `json` reads, and what each is.
pub const PLACES: &[(&str, &str)] = &[
    ("settings", "Every setting as it is in effect, defaults included"),
    ("stored", "Only what config/defaults.json holds"),
    ("ui", "The observer's settings, config/ui-config.json"),
    ("env", "Variables in use, and those kept in config/launcher.env"),
    ("seeds", "Saved seeds"),
    ("apps", "The applications catalogue"),
    ("next-world", "Dynamic Fastboot's next world"),
    ("eta", "How long preparing worlds has taken, which estimates come from"),
    ("launcher", "The server this launcher is running"),
    ("status", "The simulation, from the server"),
    ("world", "World generation, from the server"),
    ("system", "The server's build, process and modules"),
    ("features", "What the server has turned on"),
    ("endpoints", "Every route the server serves"),
    ("daemons", "The daemons: which run, and their queues"),
];

fn read_json(path: &std::path::Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn server(route: &str, paths: &Paths) -> Result<Value, String> {
    let port = crate::server::active_port(paths).ok_or("No server is running. start starts one.")?;
    let response = crate::api::get(port, route, 10.0, paths);
    if response.code == 0 {
        return Err("The server did not answer.".into());
    }
    Ok(response.body.get("data").cloned().unwrap_or(response.body))
}

/// A place by name, a JSON file, or what was piped in.
pub fn place(name: &str, input: Option<&[String]>, paths: &Paths) -> Result<Value, String> {
    let settings = || config::load(paths).map_err(|e| e.message);
    match name {
        "-" | "" => {
            let text = input.ok_or("json: say what to read: a place (ls json), a file, or - for what is piped in")?.join("\n");
            serde_json::from_str(&text).map_err(|e| format!("json: its input is not JSON: {e}"))
        }
        // Every setting as it is in effect: what is stored, and the default for anything that is not.
        "settings" | "config" => Ok(effective(&settings()?)),
        "stored" => settings(),
        "ui" => read_json(&paths.ui_config()),
        "env" => Ok(environment(paths)),
        "seeds" => crate::seeds::operate("list", &json!({}), paths).map_err(|e| e.message),
        "apps" => Ok(Value::Array(crate::apps::load(paths).map_err(|e| e.message)?.values().map(|a| a.to_json()).collect())),
        "next-world" => {
            let configured = config::setting(&settings()?, "map.cache_dir");
            read_json(&paths.map_cache(configured.as_str()).join("next-world.json"))
        }
        "eta" => read_json(&paths.logs().join("preparation-times.json")),
        "launcher" => read_json(&paths.active_server()),
        "status" => server("/api/v1/playback/status", paths),
        "world" => server("/api/v1/world/status", paths),
        "system" => server("/api/v1/system/info", paths),
        "features" => server("/api/v1/system/features", paths),
        "endpoints" => server("/api/v1/system/endpoints", paths),
        "daemons" => server("/api/v1/daemon", paths),
        file if std::path::Path::new(file).is_file() => read_json(std::path::Path::new(file)),
        other => Err(format!("json: no place or file {other}. ls json lists the places.")),
    }
}

fn effective(stored: &Value) -> Value {
    let mut out = stored.clone();
    for field in config::fields() {
        let parts: Vec<&str> = field.key.split('.').collect();
        let mut node = &mut out;
        for part in &parts[..parts.len() - 1] {
            if !node.get(*part).map(Value::is_object).unwrap_or(false) {
                node[*part] = json!({});
            }
            node = node.get_mut(*part).unwrap();
        }
        let last = parts[parts.len() - 1];
        if node.get(last).is_none() {
            node[last] = field.default.clone();
        }
    }
    out
}

/// Follow `.a.b[0]` into a value.
pub fn query<'a>(value: &'a Value, path: &str) -> Result<&'a Value, String> {
    let mut node = value;
    let mut rest = path.trim();
    if rest == "." || rest.is_empty() {
        return Ok(node);
    }
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('[') {
            let (index, tail) = after.split_once(']').ok_or_else(|| format!("{path}: a [ is not closed"))?;
            let index: usize = index.trim().parse().map_err(|_| format!("{path}: [{index}] is not a position"))?;
            node = node.get(index).ok_or_else(|| format!("{path}: there is nothing at [{index}]"))?;
            rest = tail;
        } else {
            let after = rest.strip_prefix('.').unwrap_or(rest);
            let end = after.find(['.', '[']).unwrap_or(after.len());
            let key = &after[..end];
            node = node.get(key).ok_or_else(|| format!("{path}: there is no {key}"))?;
            rest = &after[end..];
        }
    }
    Ok(node)
}

const KEY: &str = "\x1b[38;2;77;163;255m";
const STRING: &str = "\x1b[38;2;136;214;170m";
const NUMBER: &str = "\x1b[38;2;242;186;98m";
const LITERAL: &str = "\x1b[38;2;199;146;234m";
const RESET: &str = "\x1b[0m";

/// Indented JSON, coloured when it goes to a terminal.
pub fn render(value: &Value, colour: bool) -> Vec<String> {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    if !colour {
        return text.lines().map(String::from).collect();
    }
    text.lines().map(tint).collect()
}

/// One line of indented JSON, its keys, strings, numbers and literals each in a colour of their own.
pub fn tint(line: &str) -> String {
    let indent = line.len() - line.trim_start().len();
    let body = &line[indent..];
    let (key, value) = match body.strip_prefix('"').and_then(|b| b.find("\": ").map(|i| (i, b))) {
        Some((i, b)) => (Some(&b[..i]), &b[i + 3..]),
        None => (None, body),
    };
    let mut out = " ".repeat(indent);
    if let Some(key) = key {
        out.push_str(&format!("{KEY}\"{key}\"{RESET}: "));
    }
    let bare = value.trim_end_matches(',');
    let comma = &value[bare.len()..];
    let colour = if bare.starts_with('"') {
        STRING
    } else if bare.parse::<f64>().is_ok() {
        NUMBER
    } else if ["true", "false", "null"].contains(&bare) {
        LITERAL
    } else {
        ""
    };
    if colour.is_empty() {
        out.push_str(value);
    } else {
        out.push_str(&format!("{colour}{bare}{RESET}{comma}"));
    }
    out
}

fn json_command(rest: &[String], input: Option<&[String]>, paths: &Paths) -> Result<Vec<String>, String> {
    let words: Vec<&String> = rest.iter().filter(|w| !matches!(w.as_str(), "-k" | "-c")).collect();
    let (name, path) = match words.as_slice() {
        [] => (if input.is_some() { "-" } else { "" }, "."),
        [one] if one.starts_with('.') || one.starts_with('[') => ("-", one.as_str()),
        [one] => (one.as_str(), "."),
        [one, two, ..] => (one.as_str(), two.as_str()),
    };
    if name.is_empty() {
        return Ok(PLACES.iter().map(|(p, d)| format!("{p:<14}{d}")).collect());
    }
    let whole = place(name, input, paths)?;
    let found = query(&whole, path)?;
    if rest.iter().any(|w| w == "-k") {
        return Ok(match found {
            Value::Object(map) => map.keys().cloned().collect(),
            Value::Array(items) => (0..items.len()).map(|i| format!("[{i}]")).collect(),
            _ => vec![],
        });
    }
    if rest.iter().any(|w| w == "-c") {
        return Ok(vec![found.to_string()]);
    }
    // A string on its own is printed as it is, so that it pipes.
    Ok(match found {
        Value::String(text) => text.lines().map(String::from).collect(),
        other => render(other, false),
    })
}

/// Every variable the launcher passes on: those in use, and where each came from.
fn environment(paths: &Paths) -> Value {
    let kept: std::collections::BTreeMap<String, String> = crate::setup::entries(paths).into_iter().collect();
    let mut out = serde_json::Map::new();
    for (key, value) in std::env::vars().filter(|(k, _)| k.starts_with("DSTNS_")) {
        let from = if kept.get(&key) == Some(&value) { "launcher.env" } else { "shell" };
        let shown = shown_value(&key, &value);
        out.insert(key, json!({"value": shown, "from": from}));
    }
    for (key, value) in &kept {
        out.entry(key.clone()).or_insert_with(|| json!({"value": shown_value(key, value), "from": "launcher.env"}));
    }
    Value::Object(out)
}

/// A secret's value is never shown, only that it is set.
fn shown_value(name: &str, value: &str) -> String {
    if crate::log::secret_name(name) { "(set, hidden)".into() } else { value.to_string() }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.chars().next().map(|c| c.is_ascii_uppercase() || c == '_').unwrap_or(false) && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn env_command(rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    match rest.first().map(String::as_str) {
        None => Ok(environment(paths)
            .as_object()
            .map(|m| m.iter().map(|(k, v)| format!("{k}={}{}", v["value"].as_str().unwrap_or(""), if v["from"] == "launcher.env" { "    # kept" } else { "" })).collect())
            .unwrap_or_default()),
        Some("set") => {
            let pairs: Vec<(String, String)> = rest[1..]
                .iter()
                .map(|w| w.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).ok_or_else(|| format!("env set: {w}: write it NAME=VALUE")))
                .collect::<Result<_, _>>()?;
            if pairs.is_empty() {
                return Err("env set: say NAME=VALUE".into());
            }
            let mut entries = crate::setup::entries(paths);
            for (name, value) in &pairs {
                if !valid_name(name) {
                    return Err(format!("env set: {name}: a name is capital letters, digits and _"));
                }
                if value.contains('\n') {
                    return Err(format!("env set: {name}: a value is one line"));
                }
                entries.retain(|(k, _)| k != name);
                entries.push((name.clone(), value.clone()));
                std::env::set_var(name, value);
            }
            crate::setup::save_entries(paths, &entries).map_err(|e| format!("env set: {e}"))?;
            Ok(pairs.iter().map(|(k, v)| format!("{k}={v}    kept for the next start")).collect())
        }
        Some("unset") => {
            let names = &rest[1..];
            if names.is_empty() {
                return Err("env unset: say which".into());
            }
            let mut entries = crate::setup::entries(paths);
            let before = entries.len();
            entries.retain(|(k, _)| !names.contains(k));
            if entries.len() == before {
                return Err(format!("env unset: {} is not kept in config/launcher.env", names.join(", ")));
            }
            crate::setup::save_entries(paths, &entries).map_err(|e| format!("env unset: {e}"))?;
            for name in names {
                std::env::remove_var(name);
            }
            Ok(names.iter().map(|n| format!("{n} is no longer kept")).collect())
        }
        Some(other) => Err(format!("env: {other}? env, env set NAME=VALUE or env unset NAME")),
    }
}

/// set KEY VALUE, set KEY=VALUE, unset KEY: one setting, checked, with whatever must change with it.
fn set_command(name: &str, rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    let (key, text) = match rest {
        [one] if one.contains('=') => {
            let (k, v) = one.split_once('=').unwrap();
            (k.to_string(), Some(v.to_string()))
        }
        [key, value @ ..] if !value.is_empty() => (key.clone(), Some(value.join(" "))),
        [key] => (key.clone(), None),
        _ => return Err(format!("{name}: say which setting{}", if name == "set" { ", and its value" } else { "" })),
    };
    let field = config::field(&key).ok_or_else(|| format!("{name}: no setting {key}. ls config lists them."))?;
    let value = match (name, text) {
        ("unset", _) => field.default.clone(),
        (_, Some(text)) => field.parse(&text).map_err(|p| format!("{}: {p}", field.label))?,
        (_, None) => return Err(format!("set: {key}: say its value, such as set {key} {}", field.display(&field.default))),
    };
    let mut current = config::load(paths).map_err(|e| e.message)?;
    let problem = config::check_field(field, &value, &current);
    if !problem.is_empty() {
        return Err(format!("{}: {problem}", field.label));
    }
    let also = field.set(&mut current, value.clone());
    config::save(&current, paths).map_err(|e| e.message)?;
    let mut out = vec![format!("{key} = {}", field.display(&value))];
    for other in also.into_iter().filter_map(config::field) {
        out.push(format!("{} = {}    as it must be", other.key, other.display(&other.get(&current))));
    }
    Ok(out)
}

/// What `edit` opens, and how what was written is checked.
fn editable(what: &str, paths: &Paths) -> Result<PathBuf, String> {
    Ok(match what {
        "settings" | "config" => paths.config(),
        "ui" => paths.ui_config(),
        "env" => paths.launcher_env(),
        "apps" => crate::apps::catalogue_path(paths),
        "" => return Err("edit: say what: settings, ui, env, apps, or a file".into()),
        file => PathBuf::from(file),
    })
}

fn editor() -> String {
    std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).ok().filter(|e| !e.trim().is_empty()).unwrap_or_else(|| {
        if Command::new("sh").args(["-c", "command -v nano"]).stdout(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) { "nano".into() } else { "vi".into() }
    })
}

use std::process::{Command, Stdio};

/// A copy is edited, and only written back if it still reads: JSON that parses, settings that pass their checks.
pub fn edit(what: &str, paths: &Paths) -> Result<Vec<String>, String> {
    if !std::io::stdin().is_terminal() {
        return Err("edit needs a terminal: run it in the interface, ./launcher shell, or ./launcher edit".into());
    }
    let target = editable(what, paths)?;
    let original = std::fs::read_to_string(&target).unwrap_or_default();
    let draft = std::env::temp_dir().join(format!("dstns-edit-{}-{}", std::process::id(), target.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    std::fs::write(&draft, &original).map_err(|e| format!("edit: {e}"))?;
    let editor = editor();
    let status = crate::interface::with_terminal(|| Command::new("sh").args(["-c", &format!("{editor} \"$1\""), "edit"]).arg(&draft).status());
    match status {
        Ok(s) if s.success() => {}
        Ok(_) => return Err(format!("edit: {editor} did not finish; nothing was changed (your draft is {})", draft.display())),
        Err(e) => return Err(format!("edit: {editor}: {e}")),
    }
    let written = std::fs::read_to_string(&draft).map_err(|e| format!("edit: {e}"))?;
    if written == original {
        let _ = std::fs::remove_file(&draft);
        return Ok(vec![format!("{}: unchanged", target.display())]);
    }
    let kept = |why: String| format!("{why}. Nothing was saved; your draft is {}", draft.display());
    if target.extension().map(|e| e == "json").unwrap_or(false) {
        let value: Value = serde_json::from_str(&written).map_err(|e| kept(format!("It is not JSON: {e}")))?;
        if target == paths.config() {
            // The same checks, rules and Advanced Security as every other way of changing the settings.
            config::save(&value, paths).map_err(|e| kept(e.message))?;
            let _ = std::fs::remove_file(&draft);
            return Ok(vec![format!("{}: saved", target.display())]);
        }
    } else if target == paths.launcher_env() {
        if let Some(bad) = written.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).find(|l| l.split_once('=').map(|(k, _)| !valid_name(k.trim())).unwrap_or(true)) {
            return Err(kept(format!("This line is not NAME=VALUE: {bad}")));
        }
    }
    std::fs::write(&target, &written).map_err(|e| kept(format!("edit: {e}")))?;
    let _ = std::fs::remove_file(&draft);
    if target == crate::apps::catalogue_path(paths) {
        if let Err(problem) = crate::apps::load(paths) {
            std::fs::write(&target, &original).ok();
            return Err(format!("The applications catalogue would not load: {}. It is as it was.", problem.message));
        }
    }
    Ok(vec![format!("{}: saved", target.display())])
}

fn api_command(rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    let (method, route) = match rest {
        [path] if path.starts_with('/') => ("GET".to_string(), path.clone()),
        [method, path, ..] => (method.to_uppercase(), path.clone()),
        _ => return Err("api: api [METHOD] PATH [BODY], such as api GET /api/v1/system/info".into()),
    };
    if !["GET", "POST", "PUT", "DELETE"].contains(&method.as_str()) {
        return Err(format!("api: {method}: GET, POST, PUT or DELETE"));
    }
    if !route.starts_with("/api/") && route != "/health" {
        return Err(format!("api: {route}: a route starts /api/"));
    }
    let body = match rest.get(2).map(String::as_str) {
        None => None,
        Some(file) if file.starts_with('@') => Some(read_json(std::path::Path::new(&file[1..]))?),
        Some(text) => Some(serde_json::from_str(text).map_err(|e| format!("api: the body is not JSON: {e}"))?),
    };
    let port = crate::server::active_port(paths).ok_or("No server is running. start starts one.")?;
    let body = body.or_else(|| (method != "GET").then(|| json!({})));
    let response = crate::api::call(port, &route, &method, body.as_ref(), 60.0, paths);
    if response.code == 0 {
        return Err("The server did not answer.".into());
    }
    let mut out = render(&response.body, false);
    if !(200..300).contains(&response.code) {
        eprintln!("HTTP {}", response.code);
        out.insert(0, format!("HTTP {}", response.code));
    }
    Ok(out)
}

/// Every DSTNS server and launcher on this machine, this launcher's marked.
pub fn everyone(paths: &Paths) -> Vec<String> {
    let ours = crate::server::active_port(paths);
    let me = std::process::id().to_string();
    let table = Command::new("ps").args(["-axo", "pid=,etime=,command="]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let mut lines = vec![format!("{:<10}{:<8}{:<12}{:<8}{}", "NAME", "PID", "UP", "PORT", "WHERE")];
    for row in table.lines() {
        let mut parts = row.split_whitespace();
        let (Some(pid), Some(up)) = (parts.next(), parts.next()) else { continue };
        if pid == me {
            continue;
        }
        let command: Vec<&str> = parts.collect();
        let Some(program) = command.first() else { continue };
        let option = |flag: &str| command.windows(2).find(|w| w[0] == flag).map(|w| w[1].to_string()).or_else(|| command.iter().find_map(|w| w.strip_prefix(&format!("{flag}=")).map(String::from)));
        let name = if program.ends_with("dstns_server") && !command.contains(&"--fetch-osm") {
            "server"
        } else if program.ends_with("dstns_server") {
            "download"
        } else if program.ends_with("dstns-launcher") {
            "launcher"
        } else {
            continue;
        };
        let port = option("--port").unwrap_or_else(|| "-".into());
        let mine = ours.map(|p| p.to_string()) == Some(port.clone());
        let place = option("--logs").or_else(|| option("--output")).unwrap_or_else(|| command[1..].join(" "));
        lines.push(format!("{:<10}{:<8}{:<12}{:<8}{}{}", name, pid, up, port, crate::tui::widgets::clip(&place, 60, true), if mine { "    (this launcher's)" } else { "" }));
    }
    lines
}

fn security_command(rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    match rest.first().map(String::as_str) {
        None | Some("status") => Ok(vec![
            format!("Advanced Security  {}", if crate::security::enabled(paths) { "on" } else { "off" }),
            format!("Asks with          {}", crate::security::method()),
            format!("This session       {}", if crate::security::verified() { "verified" } else { "not verified" }),
        ]),
        Some("on") | Some("off") => set_command("set", &[crate::security::KEY.into(), rest[0].clone()], paths),
        Some("verify") => crate::security::authenticate(paths, "verify Advanced Security").map(|_| vec!["Verified.".into()]),
        Some(other) => Err(format!("security: {other}? security, security on, security off or security verify")),
    }
}

fn ask_command(rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    let request = rest.join(" ");
    if request.trim().is_empty() {
        return Err("ask: say what you want, such as ask show me the api log's errors".into());
    }
    match crate::assistant::respond(paths, &request)? {
        (crate::assistant::Reply::Command(suggestion), by) => {
            eprintln!("Suggested by {by}. Nothing has been run.");
            for warning in &suggestion.warnings {
                eprintln!("Note: {warning}");
            }
            Ok(vec![suggestion.line])
        }
        (crate::assistant::Reply::Answer(lines), by) => {
            eprintln!("Answered by {by}.");
            Ok(lines)
        }
    }
}

/// The knowledge graph: where things are, and how they connect. Read from the checkout; `update` builds it again.
fn graph_command(rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    let sub = rest.first().map(String::as_str).unwrap_or("stats");
    let text = rest.get(1..).unwrap_or(&[]).join(" ");
    if sub == "update" {
        let status = std::process::Command::new("python3")
            .arg(paths.root.join("hooks/graph.py"))
            .arg(paths.root.join(crate::graph::FILE))
            .current_dir(&paths.root)
            .status()
            .map_err(|e| format!("graph update: python3: {e}"))?;
        return if status.success() { Ok(vec![format!("Built {}. The next launcher reads it.", crate::graph::FILE)]) } else { Err("graph update: the graph was not built. It needs graphify: pip install graphifyy".into()) };
    }
    let g = crate::graph::load(paths)?;
    let need = |what: &str| if text.trim().is_empty() { Err(format!("graph {sub}: say {what}")) } else { Ok(()) };
    let relation = |group: &str, direction: &str, name: &str| -> Result<Vec<String>, String> {
        need("a name")?;
        let node = g.subject(&text, Some((group, direction))).ok_or_else(|| format!("Nothing in the graph is called {text}."))?;
        let items = g.around(node, group, direction);
        let mut out = vec![format!("{name} {} ({}): {}", g.label(node), g.where_is(node), items.len())];
        out.extend(items.iter().map(|i| format!("  {}", g.describe(*i))));
        Ok(out)
    };
    match sub {
        "stats" => Ok(vec![format!("{} nodes, {} edges, built from {} at {}", g.count(), g.edge_count(), g.repo, &g.commit[..g.commit.len().min(10)]), format!("From {}. The same graph is on the documentation's Graph page.", crate::graph::FILE)]),
        "search" | "ask" | "find" => {
            need("what to look for")?;
            Ok(crate::graph::answer(g, &text, 25))
        }
        "show" => {
            need("a name")?;
            g.subject(&text, None).map(|n| g.show(n)).ok_or_else(|| format!("Nothing in the graph is called {text}."))
        }
        "callers" => relation("calls", "in", "Callers of"),
        "callees" => relation("calls", "out", "Called by"),
        "deps" => relation("imports", "out", "Dependencies of"),
        "users" => relation("imports", "in", "Users of"),
        "members" => relation("contains", "out", "Inside"),
        "path" => {
            let (a, b) = (rest.get(1).cloned().unwrap_or_default(), rest.get(2..).unwrap_or(&[]).join(" "));
            let (Some(from), Some(to)) = (g.subject(&a, None), g.subject(&b, None)) else { return Err("graph path FROM TO: one of them is not in the graph".into()) };
            g.path(from, to).map(|steps| steps.into_iter().map(|s| format!("  {s}")).collect()).ok_or_else(|| "They are not connected.".into())
        }
        // Anything else is a question.
        _ => Ok(crate::graph::answer(g, &rest.join(" "), 25)),
    }
}

fn model_command(rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    match rest.first().map(String::as_str) {
        None | Some("status") => {
            let settings = config::load(paths).map_err(|e| e.message)?;
            let chosen = config::setting(&settings, "model.provider").as_str().unwrap_or("auto").to_string();
            let key = if std::env::var_os(crate::assistant::GROQ_KEY).is_some() { "kept" } else { "not kept" };
            Ok(vec![
                format!("Chosen        {chosen}"),
                format!("In use        {}", crate::assistant::resolve(paths).map(|m| m.label()).unwrap_or_else(|why| format!("none: {why}"))),
                format!("Apple's model {}", if crate::assistant::apple_available() { "available" } else { "not available here" }),
                format!("Groq key      {key}"),
            ])
        }
        Some("use") => {
            let provider = rest.get(1).ok_or("model use: auto, apple, ollama, groq or off")?;
            let mut out = set_command("set", &["model.provider".into(), provider.clone()], paths)?;
            if let Some(name) = rest.get(2) {
                out.extend(set_command("set", &["model.name".into(), name.clone()], paths)?);
            }
            Ok(out)
        }
        Some("key") => {
            let key = rest.get(1).ok_or("model key: give the Groq API key")?;
            env_command(&["set".into(), format!("{}={key}", crate::assistant::GROQ_KEY)], paths)?;
            Ok(vec![format!("The Groq key is kept in config/launcher.env as {}, on this machine only.", crate::assistant::GROQ_KEY)])
        }
        Some("test") => {
            let model = crate::assistant::resolve(paths)?;
            let answer = crate::assistant::ask(&model, "Answer in one short sentence.", "Say that you are ready.")?;
            Ok(vec![format!("{}: {answer}", model.label())])
        }
        Some(other) => Err(format!("model: {other}? model, model use PROVIDER [NAME], model key KEY or model test")),
    }
}

fn daemon_command(rest: &[String], paths: &Paths) -> Result<Vec<String>, String> {
    let port = crate::server::active_port(paths).ok_or("No server is running. start starts one.")?;
    let call = |method: &str, route: &str, body: Option<Value>| -> Result<Value, String> {
        let response = crate::api::call(port, route, method, body.as_ref(), 15.0, paths);
        if response.code == 0 {
            return Err("The server did not answer.".into());
        }
        if !(200..300).contains(&response.code) {
            return Err(response.body["error"]["message"].as_str().unwrap_or("refused").to_string());
        }
        Ok(response.body.get("data").cloned().unwrap_or(response.body))
    };
    match rest.first().map(String::as_str) {
        None | Some("status") | Some("list") => {
            let overview = call("GET", "/api/v1/daemon", None)?;
            if overview["enabled"] != json!(true) {
                return Ok(vec!["The daemons are off (daemon.enabled).".into()]);
            }
            let mut lines = vec![format!("{:<8}{:<10}{}", "NAME", "STATE", "WATCHES")];
            for d in overview["daemons"].as_array().cloned().unwrap_or_default() {
                let state = if d["running"] == json!(true) { "running" } else if d["enabled"] == json!(true) { "starting" } else { "off" };
                lines.push(format!("{:<8}{:<10}{}", d["name"].as_str().unwrap_or(""), state, d["description"].as_str().unwrap_or("")));
            }
            for (name, q) in overview["queues"].as_object().cloned().unwrap_or_default() {
                lines.push(format!("{name}: {} held, latest {}, {} subscribed", q["length"], q["latest_sequence"], q["subscribers"].as_array().map(|a| a.len()).unwrap_or(0)));
            }
            Ok(lines)
        }
        Some("show") => {
            let name = rest.get(1).ok_or("daemon show: rcs, memory, disk, stall or cache")?;
            Ok(render(&call("GET", &format!("/api/v1/daemon/{name}"), None)?, false))
        }
        Some(turn @ ("on" | "off")) => {
            let name = rest.get(1).ok_or("daemon on|off: rcs, memory, disk, stall or cache")?;
            call("PUT", &format!("/api/v1/daemon/{name}"), Some(json!({"enabled": turn == "on"})))?;
            Ok(vec![format!("{name} is {turn}, until the server stops; daemon.{name} keeps it for the next start.")])
        }
        Some("queue") => {
            let which = match rest.get(1).map(String::as_str).unwrap_or("notification") {
                "emergency" | "emergencies" | "alerts" => "emergency",
                _ => "notification",
            };
            let read = call("GET", &format!("/api/v1/daemon/{which}-queue"), None)?;
            let items = read["items"].as_array().cloned().unwrap_or_default();
            if items.is_empty() {
                return Ok(vec![format!("Nothing on daemon{}Queue.", if which == "emergency" { "Emergency" } else { "Notification" })]);
            }
            Ok(items.iter().map(|m| format!("{:>5}  {:<9} {:<7} {} — {}", m["sequence"], m["level"].as_str().unwrap_or(""), m["daemon"].as_str().unwrap_or(""), m["title"].as_str().unwrap_or(""), m["text"].as_str().unwrap_or(""))).collect())
        }
        Some(other) => Err(format!("daemon: {other}? daemon, daemon show NAME, daemon on|off NAME, or daemon queue emergency|notification")),
    }
}

/// The console's tools, by name. None for a name that is not one of them.
pub fn run(name: &str, rest: &[String], input: Option<&[String]>, paths: &Paths) -> Option<Result<Vec<String>, String>> {
    Some(match name {
        "json" | "view" => json_command(rest, input, paths),
        "env" => env_command(rest, paths),
        "set" | "unset" => set_command(name, rest, paths),
        "edit" => edit(rest.first().map(String::as_str).unwrap_or(""), paths),
        "api" => api_command(rest, paths),
        "security" => security_command(rest, paths),
        "ask" => ask_command(rest, paths),
        "model" => model_command(rest, paths),
        "daemon" | "daemons" => daemon_command(rest, paths),
        "graph" => graph_command(rest, paths),
        "history" => Ok(std::fs::read_to_string(paths.logs().join("command-history")).unwrap_or_default().lines().enumerate().map(|(i, l)| format!("{:>5}  {l}", i + 1)).collect()),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_reaches_inside() {
        let value = json!({"api": {"port": 8090}, "items": [{"id": "a"}, {"id": "b"}]});
        assert_eq!(query(&value, ".api.port").unwrap(), &json!(8090));
        assert_eq!(query(&value, ".items[1].id").unwrap(), &json!("b"));
        assert_eq!(query(&value, "items[0]").unwrap(), &json!({"id": "a"}));
        assert_eq!(query(&value, ".").unwrap(), &value);
        assert!(query(&value, ".api.host").unwrap_err().contains("no host"));
        assert!(query(&value, ".items[5]").unwrap_err().contains("nothing at [5]"));
        assert!(query(&value, ".items[x]").is_err());
    }

    #[test]
    fn colour_marks_what_each_part_is() {
        let lines = render(&json!({"name": "x", "n": 2, "on": true, "list": [null]}), true);
        assert!(lines.iter().any(|l| l.contains(&format!("{KEY}\"name\"{RESET}: {STRING}\"x\"{RESET},"))));
        assert!(lines.iter().any(|l| l.contains(&format!("{NUMBER}2{RESET}"))));
        assert!(lines.iter().any(|l| l.contains(&format!("{LITERAL}true{RESET}"))));
        assert!(render(&json!({"a": 1}), false).iter().all(|l| !l.contains('\x1b')));
    }

    #[test]
    fn variables_are_kept_and_forgotten() {
        let dir = std::env::temp_dir().join(format!("dstns-env-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("config")).unwrap();
        let paths = Paths::new(&dir);
        env_command(&["set".into(), "DSTNS_TEST_KEPT=1".into()], &paths).unwrap();
        assert!(std::fs::read_to_string(dir.join("config/launcher.env")).unwrap().contains("DSTNS_TEST_KEPT=1"));
        assert_eq!(environment(&paths)["DSTNS_TEST_KEPT"]["from"], json!("launcher.env"));
        assert!(env_command(&["set".into(), "lower=1".into()], &paths).is_err(), "names are checked");
        assert!(env_command(&["set".into(), "DSTNS_X".into()], &paths).is_err(), "and must have a value");
        env_command(&["unset".into(), "DSTNS_TEST_KEPT".into()], &paths).unwrap();
        assert!(std::env::var("DSTNS_TEST_KEPT").is_err());
        assert!(env_command(&["unset".into(), "DSTNS_TEST_KEPT".into()], &paths).is_err(), "nothing left to forget");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn settings_show_their_defaults() {
        let shown = effective(&json!({"api": {"port": 9000}}));
        assert_eq!(shown["api"]["port"], json!(9000), "what is stored wins");
        assert_eq!(shown["mcp"]["enabled"], json!(false), "and the rest are their defaults");
        assert_eq!(shown["security"]["advanced"], json!(false));
    }

    #[test]
    fn json_reads_what_is_piped_in() {
        let input = vec!["{\"a\": {\"b\": [1, 2]}}".to_string()];
        let paths = Paths::new(std::env::temp_dir());
        assert_eq!(json_command(&[".a.b[1]".into()], Some(&input), &paths).unwrap(), vec!["2"]);
        assert_eq!(json_command(&["-".into(), ".a".into(), "-k".into()], Some(&input), &paths).unwrap(), vec!["b"]);
        assert_eq!(json_command(&["-c".into()], Some(&input), &paths).unwrap(), vec![r#"{"a":{"b":[1,2]}}"#]);
    }
}
