// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher as a console: command lines as a Unix shell reads them.
//!
//! A line is commands joined by `|` (the output of one is the input of the next), `&&` (the next runs if this one
//! succeeded), `||` (if it failed) and `;` (whatever happened). Quotes keep operators and spaces as they are.
//!
//! Some commands run here, in-process: they read the launcher's own state (`ls`, `cat`, `ps`, `get`, `env`, `uptime`)
//! or filter text (`grep`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut`, `tee`, `echo`). Every other command is one of the
//! launcher's (`start`, `stop`, `apps list`, `fastboot status`...), run as a process of its own with its output
//! captured, so that it pipes like any other.
//!
//! `./launcher -c 'LINE'` runs a line; `./launcher shell` reads lines until `exit`; and the built-in commands work on
//! their own too (`./launcher ps | grep server`), printing plain text a system shell can pipe.

use crate::config;
use crate::paths::Paths;
use regex::RegexBuilder;
use std::io::{BufRead, IsTerminal, Read, Write};
use std::process::{Command, Stdio};

/// Commands that run in the console itself.
pub const BUILTINS: &[(&str, &str, &str)] = &[
    ("ls", "ls [PLACE]", "What is here: pages, seeds, applications, settings, logs"),
    ("cat", "cat logs/SOURCE | config/KEY | FILE", "A log, a setting or a file; with nothing, its input"),
    ("tail", "tail [-n N] [logs/SOURCE]", "The last lines of a log, or of its input"),
    ("head", "head [-n N] [logs/SOURCE]", "The first lines of a log, or of its input"),
    ("ps", "ps [-a]", "The server, the simulation and applications; -a, every DSTNS server and launcher here"),
    ("get", "get KEY", "A setting's value"),
    ("set", "set KEY VALUE", "Change a setting, with its checks and rules"),
    ("unset", "unset KEY", "A setting back to its default"),
    ("json", "json PLACE|FILE|- [PATH] [-k] [-c]", "Any state as JSON: settings, env, seeds, apps, next-world, status, world, endpoints…"),
    ("view", "view PLACE|FILE [PATH]", "The same as json"),
    ("edit", "edit settings|ui|env|apps|FILE", "Edit in your editor; saved only if it still reads"),
    ("env", "env [set NAME=VALUE | unset NAME]", "Variables in use; set and unset keep them for later runs"),
    ("api", "api [METHOD] PATH [BODY|@FILE]", "Any route on the running server, as the operator"),
    ("security", "security [on|off|verify]", "Advanced Security: whether it's on, and how it asks"),
    ("history", "history", "Commands typed so far"),
    ("ask", "ask REQUEST", "A request in plain words, as a line of commands to run, from the launcher's model; nothing is run"),
    ("model", "model [use PROVIDER [NAME] | key KEY | test]", "The model for plain-word requests: Apple's, Ollama's or Groq's"),
    ("daemon", "daemon [show NAME | on NAME | off NAME | queue emergency|notification]", "The daemons inside the server, and what they have said"),
    ("uptime", "uptime", "How long the server has been up, and what it is doing"),
    ("grep", "grep [-i] [-v] [-c] PATTERN", "The lines of its input that match a pattern (a regular expression)"),
    ("wc", "wc [-l]", "Lines, words and characters in its input"),
    ("sort", "sort [-r] [-n]", "Its input, sorted"),
    ("uniq", "uniq [-c]", "Its input, with repeated lines once"),
    ("cut", "cut -d DELIM -f N[,N]", "Fields of each line of its input"),
    ("tee", "tee FILE", "Its input, also written to a file"),
    ("echo", "echo WORDS", "Its words"),
    ("about", "about", "Version, copyright, licence and map-data attribution"),
    ("docs", "docs [TOPIC]", "Open the documentation (launcher, console, mcp, fastboot, api, config…); prints its address"),
    ("true", "true", "Succeeds"),
    ("false", "false", "Fails"),
    ("help", "help", "The commands, built-in and the launcher's"),
];

pub fn is_builtin(name: &str) -> bool {
    BUILTINS.iter().any(|(n, _, _)| *n == name)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Join {
    First,
    Pipe,
    And,
    Or,
    Then,
}

/// A line split into commands and how each joins the one before. None for an unclosed quote.
pub fn split(line: &str) -> Option<Vec<(Join, Vec<String>)>> {
    let mut parts: Vec<(Join, String)> = vec![];
    let mut current = String::new();
    let mut join = Join::First;
    let mut quote: Option<char> = None;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match quote {
            Some(q) => {
                current.push(ch);
                if ch == q {
                    quote = None;
                } else if ch == '\\' && q == '"' && i + 1 < chars.len() {
                    i += 1;
                    current.push(chars[i]);
                }
            }
            None => {
                let next = chars.get(i + 1).copied();
                let found = match (ch, next) {
                    ('&', Some('&')) => Some((Join::And, 2)),
                    ('|', Some('|')) => Some((Join::Or, 2)),
                    ('|', _) => Some((Join::Pipe, 1)),
                    (';', _) => Some((Join::Then, 1)),
                    _ => None,
                };
                if let Some((op, len)) = found {
                    parts.push((join, std::mem::take(&mut current)));
                    join = op;
                    i += len;
                    continue;
                }
                if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                }
                current.push(ch);
            }
        }
        i += 1;
    }
    if quote.is_some() {
        return None;
    }
    parts.push((join, current));
    let mut out = vec![];
    for (join, text) in parts {
        let words = shlex::split(&text)?;
        if words.is_empty() {
            // `a ;` ends the line; an empty command anywhere else is a mistake the run reports.
            if join == Join::Then {
                continue;
            }
            out.push((join, words));
            continue;
        }
        out.push((join, words));
    }
    Some(out)
}

/// Whether a line uses any of the operators, outside quotes.
pub fn chained(line: &str) -> bool {
    split(line).map(|parts| parts.len() > 1).unwrap_or(false)
}

/// What a command produced, and how it ended.
pub struct Ran {
    pub code: i32,
    pub out: Vec<String>,
}

fn ok(out: Vec<String>) -> Ran {
    Ran { code: 0, out }
}

fn fail(message: String, code: i32) -> Ran {
    eprintln!("{message}");
    Ran { code, out: vec![] }
}

fn number_option(words: &[String], flag: &str) -> Option<usize> {
    words.windows(2).find(|w| w[0] == flag).and_then(|w| w[1].parse().ok()).or_else(|| {
        // tail -20, as Unix allows.
        words.iter().find_map(|w| w.strip_prefix('-').and_then(|n| n.parse().ok()))
    })
}

/// The words that are not options or their values.
fn operands(words: &[String], with_values: &[&str]) -> Vec<String> {
    let mut out = vec![];
    let mut skip = false;
    for word in words {
        if skip {
            skip = false;
        } else if with_values.contains(&word.as_str()) {
            skip = true;
        } else if !word.starts_with('-') || word == "-" {
            out.push(word.clone());
        }
    }
    out
}

/// A log or a setting, by its console path.
fn read_place(what: &str, count: usize, from_start: bool, paths: &Paths) -> Result<Vec<String>, String> {
    let what = what.trim_start_matches('/');
    if let Some(key) = what.strip_prefix("config/") {
        let current = config::load(paths).map_err(|e| e.message)?;
        return match config::field(key) {
            Some(field) => Ok(vec![field.display(&field.get(&current))]),
            None => Err(format!("no setting {key}")),
        };
    }
    if let Some(source) = what.strip_prefix("logs/") {
        let lines = if source == "system" {
            crate::logs::system_tail(if from_start { 1_000_000 } else { count }, paths).unwrap_or_default()
        } else {
            let table = crate::logs::journal(source, if from_start { 1_000_000 } else { count }, paths).ok_or_else(|| format!("logs/{source}: no such log, or nothing in it yet"))?;
            std::iter::once(table.columns.join("\t")).chain(table.rows.into_iter().map(|r| r.join("\t"))).collect()
        };
        return Ok(if from_start { lines.into_iter().take(count).collect() } else { lines });
    }
    let text = std::fs::read_to_string(what).map_err(|e| format!("{what}: {e}"))?;
    let lines: Vec<String> = text.lines().map(String::from).collect();
    Ok(if from_start { lines.into_iter().take(count).collect() } else { lines[lines.len().saturating_sub(count)..].to_vec() })
}

fn list(place: &str, paths: &Paths) -> Result<Vec<String>, String> {
    let (page, section) = place.trim_start_matches('/').split_once('/').unwrap_or((place.trim_start_matches('/'), ""));
    Ok(match page {
        "" | "." | "~" | "dashboard" => crate::tui::shell::PLACES.iter().map(|(p, d)| format!("{p:<14}{d}")).chain(["logs/".into(), "config/".into()]).collect(),
        "seeds" => crate::seeds::operate("list", &serde_json::json!({}), paths)
            .map_err(|e| e.message)?
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|s| format!("{:<20}{}", s["id"].as_str().unwrap_or(""), s["seed"].as_str().unwrap_or("")))
            .collect(),
        "apps" => crate::apps::load(paths).map_err(|e| e.message)?.values().map(|a| format!("{:<28}{}", a.id, a.title())).collect(),
        "config" if section.is_empty() => config::categories().into_iter().map(|c| format!("{}/", c.to_lowercase())).collect(),
        "config" => {
            let current = config::load(paths).map_err(|e| e.message)?;
            config::fields().iter().filter(|f| f.category.eq_ignore_ascii_case(section)).map(|f| format!("{:<34}{}", f.key, f.display(&f.get(&current)))).collect()
        }
        "logs" => crate::logs::sources().into_iter().map(|(k, l)| format!("{k:<10}{l}")).collect(),
        other => return Err(format!("ls: {other}: no such place")),
    })
}

fn processes(paths: &Paths) -> Vec<String> {
    let mut lines = vec![format!("{:<14}{:<8}{:<10}{}", "NAME", "PID", "PORT", "STATE")];
    match crate::server::active_port(paths) {
        None => lines.push(format!("{:<14}{:<8}{:<10}{}", "server", "-", "-", "stopped")),
        Some(port) => {
            let status = crate::simulation::status(port, paths);
            let pid = crate::api::process(port, paths).and_then(|p| p["pid"].as_u64()).map(|p| p.to_string()).unwrap_or_else(|| "-".into());
            lines.push(format!("{:<14}{:<8}{:<10}{}", "server", pid, port, status.lifecycle.to_lowercase()));
            if status.active() || status.lifecycle == "COMPLETED" {
                lines.push(format!("{:<14}{:<8}{:<10}{} · {:.0}% · seed {}", "simulation", "-", port, status.clock, status.fraction * 100.0, status.seed));
            }
        }
    }
    lines
}

fn filter(name: &str, words: &[String], input: &[String]) -> Result<Vec<String>, String> {
    let flags = |f: &str| words.iter().any(|w| w.starts_with('-') && !w.starts_with("--") && w[1..].contains(f));
    match name {
        "grep" => {
            let pattern = operands(words, &[]).into_iter().next().ok_or("grep: say what to look for")?;
            let regex = RegexBuilder::new(&pattern).case_insensitive(flags("i")).build().map_err(|e| format!("grep: {e}"))?;
            let kept: Vec<String> = input.iter().filter(|l| regex.is_match(l) != flags("v")).cloned().collect();
            Ok(if flags("c") { vec![kept.len().to_string()] } else { kept })
        }
        "head" => Ok(input.iter().take(number_option(words, "-n").unwrap_or(10)).cloned().collect()),
        "tail" => Ok(input[input.len().saturating_sub(number_option(words, "-n").unwrap_or(10))..].to_vec()),
        "wc" => {
            let lines = input.len();
            let words_count: usize = input.iter().map(|l| l.split_whitespace().count()).sum();
            let chars: usize = input.iter().map(|l| l.chars().count() + 1).sum();
            Ok(vec![if flags("l") { lines.to_string() } else { format!("{lines:>8}{words_count:>8}{chars:>8}") }])
        }
        "sort" => {
            let mut lines = input.to_vec();
            if flags("n") {
                let key = |l: &String| l.split_whitespace().next().and_then(|w| w.parse::<f64>().ok()).unwrap_or(f64::MAX);
                lines.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal));
            } else {
                lines.sort();
            }
            if flags("r") {
                lines.reverse();
            }
            Ok(lines)
        }
        "uniq" => {
            let mut out: Vec<(String, usize)> = vec![];
            for line in input {
                match out.last_mut() {
                    Some((last, n)) if last == line => *n += 1,
                    _ => out.push((line.clone(), 1)),
                }
            }
            Ok(out.into_iter().map(|(l, n)| if flags("c") { format!("{n:>7} {l}") } else { l }).collect())
        }
        "cut" => {
            let delimiter = words.windows(2).find(|w| w[0] == "-d").map(|w| w[1].clone()).unwrap_or_else(|| "\t".into());
            let fields: Vec<usize> = words.windows(2).find(|w| w[0] == "-f").map(|w| w[1].split(',').filter_map(|n| n.parse().ok()).collect()).ok_or("cut: say which fields, as -f 1,3")?;
            Ok(input.iter().map(|l| { let parts: Vec<&str> = l.split(delimiter.as_str()).collect(); fields.iter().filter_map(|f| parts.get(f.saturating_sub(1))).copied().collect::<Vec<_>>().join(&delimiter) }).collect())
        }
        "tee" => {
            let file = operands(words, &[]).into_iter().next().ok_or("tee: say which file")?;
            std::fs::write(&file, input.iter().map(|l| format!("{l}\n")).collect::<String>()).map_err(|e| format!("tee: {file}: {e}"))?;
            Ok(input.to_vec())
        }
        _ => Err(format!("{name}: not a filter")),
    }
}

/// One built-in command. `input` is what was piped to it, if anything was.
fn builtin(words: &[String], input: Option<&[String]>, paths: &Paths) -> Ran {
    let name = words[0].as_str();
    let rest = &words[1..];
    let result: Result<Vec<String>, String> = match name {
        "true" => Ok(vec![]),
        "false" => return Ran { code: 1, out: vec![] },
        "echo" => Ok(vec![rest.join(" ")]),
        "help" => Ok(BUILTINS
            .iter()
            .map(|(_, usage, what)| format!("{usage:<40}{what}"))
            .chain(std::iter::once(String::new()))
            .chain(crate::tui::shell::COMMANDS.iter().filter(|(n, _, _)| !is_builtin(n)).map(|(_, usage, what)| format!("{usage:<40}{what}")))
            .collect()),
        "ls" => list(rest.first().map(String::as_str).unwrap_or(""), paths),
        "about" => Ok(vec![
            format!("{} {}", crate::version::FULL_NAME, crate::version::engine_version()),
            "Copyright © 2026 Varun Karthic".into(),
            format!("Licence     {} (GNU Affero General Public License v3.0 or later)", crate::version::LICENSE_SPDX),
            format!("Map data    {}", crate::version::OSM_ATTRIBUTION),
            format!("Docs        {}", crate::version::DOCUMENTATION),
        ]),
        "docs" => {
            let topic = rest.first().map(String::as_str).unwrap_or("");
            let page = match topic {
                "" => "",
                "launcher" | "cli" | "tui" => "guide/operator-cli/",
                "console" | "shell" | "pipes" => "guide/console/",
                "mcp" | "ai" => "guide/mcp/",
                "fastboot" | "fast-boot" | "dynamic-fastboot" | "demo" | "film" => "guide/fast-boot/",
                "api" => "api/",
                "endpoints" => "api/endpoints/",
                "config" | "configuration" | "settings" => "guide/configuration/",
                "apps" | "fabric" => "api/fabric-api/",
                "testing" | "tests" => "development/testing/",
                "troubleshooting" | "help" => "troubleshooting/",
                other => return fail(format!("docs: no topic {other}. Try launcher, console, mcp, fastboot, api, endpoints, config, apps, testing or troubleshooting."), 1),
            };
            let url = format!("{}{page}", crate::version::DOCUMENTATION.trim_end_matches('/').to_string() + "/");
            let opened = std::io::stdout().is_terminal() && crate::simulation::open_in_browser(&url);
            Ok(vec![if opened { format!("Opened {url}") } else { url }])
        }
        "ps" if rest.iter().any(|w| w == "-a") => Ok(crate::inspect::everyone(paths)),
        "ps" => Ok(processes(paths)),
        "get" => match rest.first() {
            None => Err("get: say which setting, such as api.port".into()),
            Some(key) => read_place(&format!("config/{key}"), 1, false, paths),
        },
        "uptime" => Ok(match crate::server::active_port(paths) {
            None => vec!["server stopped".into()],
            Some(port) => {
                let status = crate::simulation::status(port, paths);
                let process = crate::api::process(port, paths).unwrap_or_default();
                let since = process["uptime_s"].as_f64().map(crate::reporting::duration).unwrap_or_else(|| "?".into());
                let memory = process["peak_rss_bytes"].as_f64().map(|b| format!("{:.0} MiB peak", b / 1048576.0)).unwrap_or_default();
                vec![format!("up {since} · port {port} · {} · {} · {memory}", status.lifecycle.to_lowercase(), status.clock)]
            }
        }),
        "cat" | "tail" | "head" => {
            let place = operands(rest, &["-n"]).into_iter().next();
            match (place, input) {
                (Some(place), _) => read_place(&place, number_option(rest, "-n").unwrap_or(if name == "cat" { 100_000 } else { 10 }), name == "head", paths),
                (None, Some(input)) if name == "cat" => Ok(input.to_vec()),
                (None, Some(input)) => filter(name, rest, input),
                (None, None) => Err(format!("{name}: say what, such as logs/system or config/api.port")),
            }
        }
        "grep" | "wc" | "sort" | "uniq" | "cut" | "tee" => filter(name, rest, input.unwrap_or(&[])),
        other => crate::inspect::run(other, rest, input, paths).unwrap_or_else(|| Err(format!("{other}: command not found"))),
    };
    match result {
        // grep finding nothing has failed, as it does in a shell, so that `grep x && ...` reads as it should.
        Ok(out) if name == "grep" && out.is_empty() => Ran { code: 1, out },
        Ok(out) => ok(out),
        Err(message) => {
            let code = if message.ends_with("not found") { 127 } else { 1 };
            fail(message, code)
        }
    }
}

/// One of the launcher's own commands, as a process of its own. Captured when piped; else it writes to the terminal.
fn launcher(words: &[String], input: Option<&[String]>, capture: bool) -> Ran {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "dstns-launcher".into());
    let mut command = Command::new(exe);
    command.args(words).env("DSTNS_ROOT", crate::paths::root()).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    if capture {
        command.stdout(Stdio::piped()).env("NO_COLOR", "1");
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return fail(format!("{}: {error}", words[0]), 126),
    };
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let text: String = input.iter().map(|l| format!("{l}\n")).collect();
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(130);
    Ran { code, out: out.lines().map(String::from).collect() }
}

/// Run a line, printing what its last command of each pipeline produced. Returns the exit status of the last command.
pub fn run_line(line: &str, paths: &Paths) -> i32 {
    let Some(parts) = split(line) else {
        eprintln!("A quotation mark is not closed.");
        return 2;
    };
    // Under Advanced Security, a line that changes anything asks once, before any of it runs.
    if parts.iter().any(|(_, words)| !crate::security::reads_only(words)) {
        if let Err(why) = crate::security::require(paths, "run a command in the DSTNS console") {
            eprintln!("Advanced Security: {why}");
            return 77;
        }
    }
    let mut status = 0;
    let mut index = 0;
    while index < parts.len() {
        // A pipeline: this command, and every one piped from it.
        let mut end = index + 1;
        while end < parts.len() && parts[end].0 == Join::Pipe {
            end += 1;
        }
        let join = parts[index].0;
        let skip = (join == Join::And && status != 0) || (join == Join::Or && status == 0);
        if !skip {
            let mut input: Option<Vec<String>> = None;
            for (position, (_, words)) in parts[index..end].iter().enumerate() {
                let last = index + position + 1 == end;
                if words.is_empty() {
                    eprintln!("A command is missing around an operator.");
                    return 2;
                }
                let name = words[0].as_str();
                let ran = if is_builtin(name) {
                    builtin(words, input.as_deref(), paths)
                } else if crate::cli::COMMANDS.contains(&name) || crate::modules::find(name).is_some() {
                    launcher(words, input.as_deref(), !last)
                } else {
                    fail(format!("{name}: command not found. help lists them."), 127)
                };
                status = ran.code;
                if last {
                    // JSON is coloured only here, as it reaches a terminal, never on its way through a pipe.
                    let tint = ["json", "view", "api"].contains(&name) && std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
                    let mut stdout = std::io::stdout().lock();
                    for l in &ran.out {
                        let l = if tint { crate::inspect::tint(l) } else { l.clone() };
                        if writeln!(stdout, "{l}").is_err() {
                            // The reader went away, as `| head` does: that is not a failure.
                            return status;
                        }
                    }
                } else {
                    input = Some(ran.out);
                }
            }
        }
        index = end;
    }
    status
}

/// `./launcher shell`: lines read until `exit`, with a prompt where there is a terminal.
pub fn repl(paths: &Paths) -> i32 {
    let interactive = std::io::stdin().is_terminal();
    if interactive {
        if let Err(why) = crate::security::require(paths, "open the DSTNS console") {
            eprintln!("Advanced Security: {why}");
            return 77;
        }
    }
    let mut status = 0;
    let stdin = std::io::stdin();
    loop {
        if interactive {
            let mark = if status == 0 { "\x1b[38;2;77;163;255m❯\x1b[0m" } else { "\x1b[38;2;240;82;82m❯\x1b[0m" };
            print!("\x1b[38;2;139;152;168mdstns\x1b[0m {mark} ");
            let _ = std::io::stdout().flush();
        }
        let mut line = String::new();
        if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if ["exit", "quit", "logout"].contains(&line) {
            break;
        }
        status = run_line(line, paths);
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(parts: &[(Join, Vec<String>)]) -> Vec<(Join, String)> {
        parts.iter().map(|(j, w)| (*j, w.join(" "))).collect()
    }

    #[test]
    fn a_line_splits_on_its_operators_outside_quotes() {
        let parts = split("ps | grep 'a|b' && echo \"x;y\" || stop ; ls").unwrap();
        assert_eq!(
            words(&parts),
            vec![(Join::First, "ps".into()), (Join::Pipe, "grep a|b".into()), (Join::And, "echo x;y".into()), (Join::Or, "stop".into()), (Join::Then, "ls".into())]
        );
        assert!(split("echo 'open").is_none());
        assert!(chained("a | b") && !chained("echo 'a | b'"));
    }

    #[test]
    fn filters_work_on_their_input() {
        let input: Vec<String> = ["b 2", "a 10", "b 2", "c 1"].map(String::from).to_vec();
        let run = |line: &str| filter(line.split(' ').next().unwrap(), &line.split(' ').skip(1).map(String::from).collect::<Vec<_>>(), &input).unwrap();
        assert_eq!(run("grep b"), vec!["b 2", "b 2"]);
        assert_eq!(run("grep -v b"), vec!["a 10", "c 1"]);
        assert_eq!(run("grep -ic B"), vec!["2"]);
        assert_eq!(run("head -n 1"), vec!["b 2"]);
        assert_eq!(run("tail -2"), vec!["b 2", "c 1"]);
        assert_eq!(run("wc -l"), vec!["4"]);
        assert_eq!(run("sort"), vec!["a 10", "b 2", "b 2", "c 1"]);
        assert_eq!(filter("cut", &["-d", " ", "-f", "2"].map(String::from), &input).unwrap(), vec!["2", "10", "2", "1"]);
        let sorted = filter("sort", &[], &input).unwrap();
        assert_eq!(filter("uniq", &["-c".into()], &sorted).unwrap(), vec!["      1 a 10", "      2 b 2", "      1 c 1"]);
    }

    #[test]
    fn operators_decide_what_runs() {
        let paths = Paths::default();
        assert_eq!(run_line("false && echo no", &paths), 1);
        assert_eq!(run_line("false || true", &paths), 0);
        assert_eq!(run_line("false ; true", &paths), 0);
        assert_eq!(run_line("echo a | grep b", &paths), 1, "grep finding nothing fails, as in a shell");
        assert_eq!(run_line("echo a | grep a", &paths), 0);
        assert_eq!(run_line("frobnicate", &paths), 127);
    }
}
