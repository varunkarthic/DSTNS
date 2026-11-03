// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The command bar: commands typed as in a shell, at the foot of the terminal interface.
//!
//! : or / opens it. As you type, it suggests commands, with what each does, and shows the rest of the first suggestion
//! dimmed; Tab takes it, the arrows walk the suggestions or the history, and Enter runs it. Each command's output
//! comes back in a block of its own, marked with how it ended.
//!
//! Moving about is as in a shell: `ls` lists what is here, `cd` goes somewhere, `pwd` says where. `cat`, `tail` and
//! `head` read logs and settings, `ps` shows what is running and `kill` stops it. Everything the launcher's command
//! line does works here too, typed the same way: `apps list`, `fastboot status`, `test unit`.

use super::screens;
use super::theme::{self, bold, fg, CYAN, ERR, MUTED, NAVY, OK, TEAL, TEXT, TEXT2, WARN};
use super::widgets::{self, clip, key, Key};
use super::{Action, Dialog, Ui};
use crate::config;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph};
use ratatui::Frame;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Instant;

/// (name, usage, what it does). The first word of a command line.
pub const COMMANDS: &[(&str, &str, &str)] = &[
    ("ls", "ls [PLACE]", "List what is here: pages, seeds, applications, settings or logs"),
    ("cd", "cd PLACE", "Go to a page: config, apps, seeds, logs, diagnostics, tests, tools, about, running, start, demo; .. or / for the dashboard"),
    ("pwd", "pwd", "Where you are"),
    ("cat", "cat logs/SOURCE | config/KEY", "Show a log or a setting"),
    ("tail", "tail [-n N] logs/SOURCE", "The end of a log"),
    ("head", "head [-n N] logs/SOURCE", "The start of what a log holds now"),
    ("ps", "ps", "What is running: the server, the simulation and applications"),
    ("kill", "kill APP | server", "Stop an application, or the server"),
    ("start", "start [--seed N] [--day-type D] [--speed X] [--osm-file F] [--apps IDS]", "Start a simulation"),
    ("stop", "stop", "Stop the server and the applications this launcher started"),
    ("pause", "pause", "Pause the simulation"),
    ("resume", "resume", "Resume the simulation"),
    ("restart", "restart", "Back to 00:00:00 in the same world"),
    ("open", "open", "Open the observer in the browser"),
    ("get", "get KEY", "Read a setting"),
    ("set", "set KEY VALUE", "Change a setting"),
    ("config", "config [get KEY | set KEY VALUE]", "Settings: the page, or one at a time"),
    ("setup", "setup", "Run the first-launch setup again"),
    ("seeds", "seeds save|list|inspect|delete [ID]", "Saved seeds"),
    ("apps", "apps list|add|set|show|remove|run|status|logs|doctor|proposals|approve|reject", "Applications"),
    ("fabric", "fabric status|capabilities|grant|settings|audit", "The Fabric API, as the operator"),
    ("fastboot", "fastboot download|status|clear", "Every city in advance, for Fast Boot"),
    ("demo", "demo [--no-music] [--no-fullscreen]", "Demo Mode: the film on a loop"),
    ("mcp", "mcp tools|client-config", "The MCP Handler, for AI clients"),
    ("logs", "logs [system|api|event|playback]", "A log, as a table"),
    ("test", "test [all|unit|api|replay|benchmark|sumo|ui|launcher]", "Run test stages"),
    ("sumo", "sumo", "Check the SUMO toolchain"),
    ("ui", "ui open|build|install", "The observer: open it, build it, or install its dependencies"),
    ("reset", "reset", "Delete runtime data, and forget the setup"),
    ("version", "version", "Version and licence"),
    ("history", "history", "Commands typed so far"),
    ("clear", "clear", "Clear the output"),
    ("help", "help [COMMAND]", "What each command does"),
    ("man", "man COMMAND", "How to use a command"),
    ("exit", "exit", "Leave the launcher"),
];

/// Places `cd` goes, and what `ls` shows at the dashboard.
pub const PLACES: &[(&str, &str)] = &[
    ("start", "Start simulation"),
    ("running", "Running simulation"),
    ("apps", "Applications"),
    ("seeds", "Saved seeds"),
    ("config", "Configuration"),
    ("demo", "Demo and Fast Boot"),
    ("diagnostics", "Diagnostics"),
    ("logs", "Logs"),
    ("tests", "Tests"),
    ("tools", "Tools"),
    ("about", "About"),
    ("setup", "First-launch setup"),
];

struct Output {
    command: String,
    lines: Vec<(String, u32)>,
    status: Option<i32>,
    started: Instant,
}

struct Running {
    child: Child,
    lines: Receiver<String>,
}

pub struct Shell {
    pub enabled: bool,
    pub open: bool,
    input: String,
    cursor: usize,
    history: Vec<String>,
    history_index: Option<usize>,
    suggestion: usize,
    suggesting: bool,
    blocks: Vec<Output>,
    running: Option<Running>,
    show_output: bool,
    scroll_back: usize,
}

fn exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "dstns-launcher".into())
}

impl Shell {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            open: false,
            input: String::new(),
            cursor: 0,
            history: vec![],
            history_index: None,
            suggestion: 0,
            suggesting: false,
            blocks: vec![],
            running: None,
            show_output: false,
            scroll_back: 0,
        }
    }

    pub fn show(&mut self) {
        self.open = true;
        self.suggesting = true;
        self.show_output = !self.blocks.is_empty();
    }

    pub fn has_output(&self) -> bool {
        self.show_output && !self.blocks.is_empty()
    }

    pub fn dismiss(&mut self) {
        self.show_output = false;
    }

    pub fn height(&self) -> u16 {
        if self.open {
            3
        } else {
            0
        }
    }

    pub fn output_height(&self, body: u16) -> u16 {
        if self.has_output() {
            (body / 2).clamp(6, 16).min(body.saturating_sub(4))
        } else {
            0
        }
    }

    pub fn keys(&self) -> Vec<Key> {
        vec![
            key("Enter", "Run", "Run", true),
            key("Tab", "Complete", "Complete", true),
            key("↑↓", "Suggestions or history", "History", false),
            key("Ctrl+C", "Stop a command", "Stop", false),
            key("Esc", "Close", "Close", true),
        ]
    }

    /// Ctrl+C: stops a command that is running, rather than the launcher.
    pub fn interrupt(&mut self) -> bool {
        if let Some(running) = &self.running {
            unsafe {
                libc::killpg(running.child.id() as i32, libc::SIGINT);
            }
            return true;
        }
        false
    }

    fn say(&mut self, command: &str, lines: Vec<(String, u32)>, status: i32) {
        self.blocks.push(Output { command: command.into(), lines, status: Some(status), started: Instant::now() });
        self.show_output = true;
        self.scroll_back = 0;
        if self.blocks.len() > 50 {
            self.blocks.remove(0);
        }
    }

    /// Suggestions for what is typed so far: (text to put in place of the current word, label, description).
    pub fn suggestions(&self, ui: &Ui) -> Vec<(String, String, String)> {
        let before: String = self.input.chars().take(self.cursor).collect();
        let words: Vec<&str> = before.split_whitespace().collect();
        let fresh_word = before.ends_with(' ') || before.is_empty();
        let current = if fresh_word { "" } else { words.last().copied().unwrap_or("") };
        if words.len() <= 1 && !fresh_word || words.is_empty() {
            return COMMANDS.iter().filter(|(n, _, _)| n.starts_with(current)).map(|(n, u, d)| (n.to_string(), u.to_string(), d.to_string())).collect();
        }
        let command = words[0];
        let choices: Vec<(String, String)> = match command {
            "cd" | "ls" => PLACES.iter().map(|(p, d)| (p.to_string(), d.to_string())).chain([("..".to_string(), "The dashboard".to_string())]).collect(),
            "cat" | "tail" | "head" => crate::logs::sources()
                .into_iter()
                .map(|(k, l)| (format!("logs/{k}"), l.to_string()))
                .chain(config::fields().iter().map(|f| (format!("config/{}", f.key), f.label.to_string())))
                .collect(),
            "get" | "set" => config::fields().iter().map(|f| (f.key.to_string(), format!("{} · {}", f.label, f.category))).collect(),
            "logs" => crate::logs::sources().into_iter().map(|(k, l)| (k.to_string(), l.to_string())).collect(),
            "test" => crate::testing::SCOPES.iter().map(|s| (s.to_string(), String::new())).collect(),
            "kill" => {
                let mut out = vec![("server".to_string(), "The DSTNS server".to_string())];
                if let Some(supervisor) = ui.session.supervisor() {
                    out.extend(supervisor.states().into_iter().filter(|s| s.phase.active()).map(|s| (s.app.id.clone(), s.app.title())));
                }
                out
            }
            "apps" if words.len() == 1 || (words.len() == 2 && !fresh_word) => ["list", "add", "set", "show", "remove", "run", "status", "logs", "doctor", "proposals", "approve", "reject"].map(|a| (a.to_string(), String::new())).to_vec(),
            "apps" => crate::apps::load(&ui.paths).map(|apps| apps.into_values().map(|a| (a.id.clone(), a.title())).collect()).unwrap_or_default(),
            "seeds" if words.len() == 1 || (words.len() == 2 && !fresh_word) => ["list", "inspect", "delete", "save"].map(|a| (a.to_string(), String::new())).to_vec(),
            "seeds" => crate::seeds::operate("list", &serde_json::json!({}), &ui.paths)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(|s| s["id"].as_str().map(|id| (id.to_string(), s["seed"].as_str().unwrap_or("").to_string())))
                .collect(),
            "fabric" => ["status", "capabilities", "grant", "settings", "audit"].map(|a| (a.to_string(), String::new())).to_vec(),
            "fastboot" => ["download", "status", "clear"].map(|a| (a.to_string(), String::new())).to_vec(),
            "mcp" => ["tools", "client-config"].map(|a| (a.to_string(), String::new())).to_vec(),
            "ui" => ["open", "build", "install"].map(|a| (a.to_string(), String::new())).to_vec(),
            "help" | "man" => COMMANDS.iter().map(|(n, _, d)| (n.to_string(), d.to_string())).collect(),
            "start" => ["--seed", "--day-type", "--speed", "--osm-file", "--apps", "--no-apps", "--saved-seed", "--save-seed", "--duration"].map(|a| (a.to_string(), String::new())).to_vec(),
            _ => vec![],
        };
        choices.into_iter().filter(|(c, _)| c.starts_with(current)).map(|(c, d)| (c.clone(), c, d)).collect()
    }

    fn accept(&mut self, ui: &Ui) {
        let suggestions = self.suggestions(ui);
        let Some((text, _, _)) = suggestions.get(self.suggestion.min(suggestions.len().saturating_sub(1))) else { return };
        let before: String = self.input.chars().take(self.cursor).collect();
        let after: String = self.input.chars().skip(self.cursor).collect();
        let start = if before.ends_with(' ') { before.len() } else { before.rfind(' ').map(|i| i + 1).unwrap_or(0) };
        let replaced = format!("{}{text} ", &before[..start]);
        self.cursor = replaced.chars().count();
        self.input = format!("{replaced}{}", after.trim_start());
        self.suggestion = 0;
    }

    pub fn key(&mut self, event: KeyEvent, ui: &mut Ui, path: String) -> Action {
        let suggestions = self.suggestions(ui);
        match event.code {
            KeyCode::Esc => {
                if self.suggesting && !suggestions.is_empty() && !self.input.is_empty() {
                    self.suggesting = false;
                } else {
                    self.open = false;
                }
            }
            KeyCode::Enter => {
                let line = self.input.trim().to_string();
                self.input.clear();
                self.cursor = 0;
                self.history_index = None;
                self.suggestion = 0;
                if line.is_empty() {
                    return Action::None;
                }
                if self.history.last() != Some(&line) {
                    self.history.push(line.clone());
                }
                return self.run(&line, ui, &path);
            }
            KeyCode::Tab => {
                self.suggesting = true;
                self.accept(ui);
            }
            KeyCode::Up => {
                if self.suggesting && !self.input.is_empty() && !suggestions.is_empty() {
                    self.suggestion = self.suggestion.saturating_sub(1);
                } else if !self.history.is_empty() {
                    let index = self.history_index.map(|i| i.saturating_sub(1)).unwrap_or(self.history.len() - 1);
                    self.history_index = Some(index);
                    self.input = self.history[index].clone();
                    self.cursor = self.input.chars().count();
                }
            }
            KeyCode::Down => {
                if self.suggesting && !self.input.is_empty() && !suggestions.is_empty() {
                    self.suggestion = (self.suggestion + 1).min(suggestions.len() - 1);
                } else if let Some(index) = self.history_index {
                    if index + 1 < self.history.len() {
                        self.history_index = Some(index + 1);
                        self.input = self.history[index + 1].clone();
                    } else {
                        self.history_index = None;
                        self.input.clear();
                    }
                    self.cursor = self.input.chars().count();
                }
            }
            KeyCode::PageUp => self.scroll_back += 5,
            KeyCode::PageDown => self.scroll_back = self.scroll_back.saturating_sub(5),
            KeyCode::Char('l') if event.modifiers.contains(KeyModifiers::CONTROL) => self.blocks.clear(),
            _ => {
                let mut editor = widgets::Editor::Text { value: self.input.clone(), cursor: self.cursor, placeholder: String::new(), numeric: false, disabled: false, multiline: false };
                if editor.handle(&event) {
                    self.suggesting = true;
                    self.suggestion = 0;
                }
                if let widgets::Editor::Text { value, cursor, .. } = editor {
                    self.input = value;
                    self.cursor = cursor;
                }
            }
        }
        Action::None
    }

    /// A confirmation the command bar asked for. None if the dialog was not its own.
    pub fn dialog(&mut self, id: &str, choice: &str, _ui: &mut Ui) -> Option<Action> {
        if id != "shell-reset" {
            return None;
        }
        if choice == "yes" {
            self.spawn("reset", vec!["reset".into(), "--yes".into()]);
        } else {
            self.say("reset", vec![("Nothing was deleted.".into(), TEXT2)], 0);
        }
        Some(Action::None)
    }

    fn spawn(&mut self, shown: &str, arguments: Vec<String>) {
        if self.running.is_some() {
            self.say(shown, vec![("Another command is still running. Ctrl+C stops it.".into(), WARN)], 1);
            return;
        }
        let mut command = Command::new(exe());
        command.args(&arguments).env("NO_COLOR", "1").env("DSTNS_ROOT", crate::paths::root()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        match command.spawn() {
            Err(error) => self.say(shown, vec![(format!("It could not be started: {error}"), ERR)], 127),
            Ok(mut child) => {
                let (sender, receiver) = channel();
                for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)]
                    .into_iter()
                    .flatten()
                {
                    let sender = sender.clone();
                    std::thread::spawn(move || {
                        for line in BufReader::new(stream).lines().map_while(|l| l.ok()) {
                            if sender.send(line).is_err() {
                                break;
                            }
                        }
                    });
                }
                self.blocks.push(Output { command: shown.into(), lines: vec![], status: None, started: Instant::now() });
                self.show_output = true;
                self.scroll_back = 0;
                self.running = Some(Running { child, lines: receiver });
            }
        }
    }

    pub fn tick(&mut self, _ui: &mut Ui) -> Action {
        let Some(running) = &mut self.running else { return Action::None };
        let block = self.blocks.last_mut().unwrap();
        while let Ok(line) = running.lines.try_recv() {
            let tone = if line.contains("[ERROR]") {
                ERR
            } else if line.contains("[WARN]") {
                WARN
            } else if line.contains("[OK]") {
                OK
            } else {
                TEXT
            };
            block.lines.push((line, tone));
        }
        if let Ok(Some(status)) = running.child.try_wait() {
            // The rest of what it wrote, before saying it has ended.
            std::thread::sleep(std::time::Duration::from_millis(30));
            while let Ok(line) = running.lines.try_recv() {
                block.lines.push((line, TEXT));
            }
            block.status = Some(status.code().unwrap_or(130));
            self.running = None;
        }
        Action::None
    }

    fn run(&mut self, line: &str, ui: &mut Ui, path: &str) -> Action {
        let Some(words) = shlex::split(line) else {
            self.say(line, vec![("It could not be read: a quotation mark is not closed.".into(), ERR)], 2);
            return Action::None;
        };
        let Some(command) = words.first().cloned() else { return Action::None };
        let rest: Vec<String> = words[1..].to_vec();
        let option_n = |rest: &[String]| rest.windows(2).find(|w| w[0] == "-n").and_then(|w| w[1].parse::<usize>().ok());
        let target = |rest: &[String]| rest.iter().filter(|w| !w.starts_with('-') && w.parse::<usize>().is_err()).last().cloned();
        match command.as_str() {
            "help" | "man" => {
                let lines: Vec<(String, u32)> = match rest.first() {
                    Some(name) => match COMMANDS.iter().find(|(n, _, _)| n == name) {
                        Some((_, usage, description)) => vec![(usage.to_string(), CYAN), (description.to_string(), TEXT)],
                        None => vec![(format!("No command {name}. Type help to see them."), WARN)],
                    },
                    None => COMMANDS.iter().map(|(_, u, d)| (format!("{u:<42} {d}"), TEXT)).collect(),
                };
                self.say(line, lines, 0);
            }
            "clear" => self.blocks.clear(),
            "history" => {
                let lines = self.history.iter().enumerate().map(|(i, h)| (format!("{:>4}  {h}", i + 1), TEXT)).collect();
                self.say(line, lines, 0);
            }
            "exit" | "quit" | "logout" => return Action::Quit,
            "pwd" => self.say(line, vec![(path.to_string(), TEXT)], 0),
            "cd" => {
                let place = rest.first().map(String::as_str).unwrap_or("/").trim_start_matches('/').trim_end_matches('/');
                if place.is_empty() || place == ".." || place == "~" || place == "dashboard" {
                    self.open = false;
                    return Action::Home;
                }
                let (page, section) = place.split_once('/').unwrap_or((place, ""));
                match screens::open(page, section, ui) {
                    Some(screen) => {
                        self.open = false;
                        return Action::Many(vec![Action::Home, Action::Push(screen)]);
                    }
                    None => self.say(line, vec![(format!("cd: no such place: {place}. ls at / lists them."), ERR)], 1),
                }
            }
            "ls" => {
                let place = rest.first().cloned().unwrap_or_else(|| path.to_string());
                let lines = self.list(place.trim_start_matches('/'), ui);
                self.say(line, lines, 0);
            }
            "cat" | "tail" | "head" => {
                let Some(what) = target(&rest) else {
                    self.say(line, vec![(format!("{command}: say what, such as logs/system or config/api.port"), ERR)], 2);
                    return Action::None;
                };
                let what = what.trim_start_matches('/');
                if let Some(key) = what.strip_prefix("config/") {
                    match (config::field(key), config::load(&ui.paths)) {
                        (Some(field), Ok(current)) => self.say(line, vec![(field.display(&field.get(&current)), TEXT)], 0),
                        _ => self.say(line, vec![(format!("{command}: no setting {key}"), ERR)], 1),
                    }
                } else if let Some(source) = what.strip_prefix("logs/") {
                    let count = option_n(&rest).unwrap_or(if command == "cat" { 500 } else { 20 });
                    let lines = if source == "system" {
                        crate::logs::system_tail(if command == "head" { 100000 } else { count }, &ui.paths).unwrap_or_default()
                    } else {
                        crate::logs::journal(source, if command == "head" { 100000 } else { count }, &ui.paths)
                            .map(|t| std::iter::once(t.columns.join("  ")).chain(t.rows.into_iter().map(|r| r.join("  "))).collect())
                            .unwrap_or_default()
                    };
                    let lines: Vec<String> = if command == "head" { lines.into_iter().take(count).collect() } else { lines };
                    if lines.is_empty() {
                        self.say(line, vec![("Nothing yet: it's written when the server first starts.".into(), TEXT2)], 0);
                    } else {
                        let toned = lines.into_iter().map(|l| (l.clone(), if l.contains("[ERROR]") { ERR } else if l.contains("[WARN") { WARN } else { TEXT })).collect();
                        self.say(line, toned, 0);
                    }
                } else {
                    self.say(line, vec![(format!("{command}: {what}: try logs/system, logs/api, logs/event, logs/playback or config/KEY"), ERR)], 1);
                }
            }
            "ps" => {
                let lines = self.processes(ui);
                self.say(line, lines, 0);
            }
            "kill" => {
                let Some(what) = rest.first().cloned() else {
                    self.say(line, vec![("kill: say which: an application's ID, or server".into(), ERR)], 2);
                    return Action::None;
                };
                if what == "server" {
                    self.spawn(line, vec!["stop".into()]);
                } else if let Some(supervisor) = ui.session.supervisor().filter(|s| s.get(&what).map(|a| a.phase.active()).unwrap_or(false)) {
                    std::thread::spawn(move || supervisor.stop(&what));
                    self.say(line, vec![("Stopping it.".into(), TEXT)], 0);
                } else {
                    self.say(line, vec![(format!("kill: {what} is not running here. ps shows what is."), ERR)], 1);
                }
            }
            "start" => {
                let mut argv = vec!["start".to_string()];
                argv.extend(rest);
                match crate::cli::parse(&argv) {
                    Ok(args) => {
                        self.open = false;
                        ui.args.open = args.open;
                        return Action::Many(vec![Action::Home, Action::Push(Box::new(screens::running::RunningScreen::new(Some(args.run))))]);
                    }
                    Err(error) => self.say(line, vec![(error.message, ERR), (error.remedy, TEXT2)], 2),
                }
            }
            "pause" | "resume" | "play" | "restart" => {
                let action = match command.as_str() {
                    "resume" | "play" => "play",
                    other => other,
                }
                .to_string();
                match ui.session.any_port() {
                    None => self.say(line, vec![("No simulation is running.".into(), WARN)], 1),
                    Some(port) => match crate::simulation::control(port, &action, &ui.paths) {
                        Ok(_) => self.say(line, vec![(format!("{}.", match action.as_str() { "play" => "Resumed", "pause" => "Paused", _ => "Back to 00:00:00" }), OK)], 0),
                        Err(error) => self.say(line, vec![(error.message, ERR)], 1),
                    },
                }
            }
            "open" => match ui.session.any_port() {
                None => self.say(line, vec![("No server is running. start starts one.".into(), WARN)], 1),
                Some(port) => {
                    let url = format!("http://127.0.0.1:{port}/");
                    let opened = crate::simulation::open_in_browser(&url);
                    self.say(line, vec![(format!("{} {url}", if opened { "Opened" } else { "Open this in your browser:" }), TEXT)], 0);
                }
            },
            "get" => {
                let mut argv = vec!["config".to_string(), "get".to_string()];
                argv.extend(rest);
                self.spawn(line, argv);
            }
            "set" => {
                let mut argv = vec!["config".to_string(), "set".to_string()];
                // set KEY=VALUE reads as set KEY VALUE.
                for word in rest {
                    match word.split_once('=') {
                        Some((k, v)) if config::field(k).is_some() => {
                            argv.push(k.into());
                            argv.push(v.into());
                        }
                        _ => argv.push(word),
                    }
                }
                self.spawn(line, argv);
            }
            "config" if rest.is_empty() => {
                self.open = false;
                return Action::Many(vec![Action::Home, Action::Push(Box::new(screens::configuration::ConfigurationScreen::new(None)))]);
            }
            "setup" => {
                self.open = false;
                return Action::Push(Box::new(screens::setup::SetupScreen::new(ui)));
            }
            "reset" => {
                return Action::Dialog(Dialog::confirm(
                    "shell-reset",
                    "Reset runtime data?",
                    "This deletes runtime logs, the journal, checkpoints and temporary files, and forgets the launcher's setup. Maps, saved seeds and configuration are kept.",
                    "Reset",
                    "Cancel",
                ));
            }
            other if crate::cli::COMMANDS.contains(&other) || crate::modules::find(other).is_some() => {
                if ["console", "start"].contains(&other) {
                    return Action::None;
                }
                self.spawn(line, words);
            }
            other => self.say(line, vec![(format!("{other}: command not found. help lists them, and Tab completes."), ERR)], 127),
        }
        Action::None
    }

    fn list(&self, place: &str, ui: &Ui) -> Vec<(String, u32)> {
        let (page, section) = place.split_once('/').unwrap_or((place, ""));
        match page {
            "" | "." | "~" | "dashboard" => PLACES.iter().map(|(p, d)| (format!("{p:<14} {d}"), TEXT)).collect(),
            "seeds" => match crate::seeds::operate("list", &serde_json::json!({}), &ui.paths) {
                Ok(list) => {
                    let items: Vec<(String, u32)> = list.as_array().cloned().unwrap_or_default().iter().map(|s| (format!("{:<20} {}", s["id"].as_str().unwrap_or(""), s["seed"].as_str().unwrap_or("")), TEXT)).collect();
                    if items.is_empty() {
                        vec![("No saved seeds yet.".into(), TEXT2)]
                    } else {
                        items
                    }
                }
                Err(error) => vec![(error.message, ERR)],
            },
            "apps" => match crate::apps::load(&ui.paths) {
                Ok(apps) if apps.is_empty() => vec![("No applications yet. apps add adds one.".into(), TEXT2)],
                Ok(apps) => apps.values().map(|a| (format!("{:<28} {}", a.id, a.title()), TEXT)).collect(),
                Err(error) => vec![(error.message, ERR)],
            },
            "config" => match config::load(&ui.paths) {
                Err(error) => vec![(error.message, ERR)],
                Ok(_) if section.is_empty() => {
                    let mut out: Vec<(String, u32)> = config::categories().into_iter().map(|c| (format!("{c}/"), CYAN)).collect();
                    out.push(("ls config/CATEGORY lists its settings.".into(), TEXT2));
                    out
                }
                Ok(current) => config::fields()
                    .iter()
                    .filter(|f| f.category.eq_ignore_ascii_case(section))
                    .map(|f| (format!("{:<32} {}", f.key, f.display(&f.get(&current))), TEXT))
                    .collect(),
            },
            "logs" => crate::logs::sources().into_iter().map(|(k, l)| (format!("{k:<10} {l}"), TEXT)).collect(),
            other => vec![(format!("ls: {other}: nothing to list here"), WARN)],
        }
    }

    fn processes(&self, ui: &Ui) -> Vec<(String, u32)> {
        let mut lines = vec![];
        match ui.session.any_port() {
            None => lines.push(("server        not running".to_string(), TEXT2)),
            Some(port) => {
                let status = crate::simulation::status(port, &ui.paths);
                let ours = ui.session.handle().filter(|h| h.port == port).and_then(|h| h.pid());
                lines.push((format!("server        port {port} · {} · {}", status.lifecycle.to_lowercase(), ours.map(|p| format!("pid {p}, started here")).unwrap_or_else(|| "already running".into())), OK));
                if status.active() || status.lifecycle == "COMPLETED" {
                    lines.push((format!("simulation    {} · {:.0}% of the day · seed {}", status.clock, status.fraction * 100.0, status.seed), TEXT));
                }
            }
        }
        if let Some(supervisor) = ui.session.supervisor() {
            for s in supervisor.states() {
                lines.push((format!("{:<13} {} {}", s.app.id, s.phase.word(), s.detail), if s.phase == crate::supervisor::Phase::Failed { ERR } else { TEXT }));
            }
        }
        if let Some(running) = &self.running {
            lines.push((format!("command       pid {} · running", running.child.id()), CYAN));
        }
        lines
    }

    pub fn draw(&mut self, frame: &mut Frame, area: Rect, body: Rect, ui: &Ui, path: &str) {
        let suggestions = self.suggestions(ui);
        self.suggestion = self.suggestion.min(suggestions.len().saturating_sub(1));
        let prompt = format!("dstns {path} {} ", if ui.unicode { "❯" } else { ">" });
        let before: String = self.input.chars().take(self.cursor).collect();
        let under: String = self.input.chars().nth(self.cursor).map(String::from).unwrap_or_else(|| " ".into());
        let after: String = self.input.chars().skip(self.cursor + 1).collect();
        // The rest of the first suggestion, dimmed, as a hint.
        let ghost = if self.cursor == self.input.chars().count() && self.suggesting {
            let current = if before.ends_with(' ') || before.is_empty() { "" } else { before.split_whitespace().last().unwrap_or("") };
            suggestions.get(self.suggestion).map(|(text, _, _)| text.strip_prefix(current).unwrap_or("").to_string()).filter(|_| !before.is_empty()).unwrap_or_default()
        } else {
            String::new()
        };
        let cursor_style = ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED);
        let line = Line::from(vec![
            Span::styled(prompt, bold(CYAN)),
            Span::styled(before, fg(TEXT)),
            Span::styled(under, cursor_style),
            Span::styled(after, fg(TEXT)),
            Span::styled(ghost, fg(MUTED)),
        ]);
        let boxed = Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area };
        frame.render_widget(
            Paragraph::new(line).block(Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(TEAL)).title(Span::styled(" Command ", fg(CYAN)))).style(theme::base()),
            boxed,
        );
        // The suggestions, just above it.
        if self.suggesting && !suggestions.is_empty() && !self.input.is_empty() {
            let count = suggestions.len().min(6) as u16;
            let start = self.suggestion.saturating_sub(5);
            let height = count + 2;
            let rect = Rect { x: boxed.x, y: area.y.saturating_sub(height).max(body.y), width: boxed.width.min(96), height: height.min(area.y.saturating_sub(body.y)) };
            if rect.height >= 3 {
                frame.render_widget(Clear, rect);
                let w = rect.width.saturating_sub(4) as usize;
                let lines: Vec<Line> = suggestions
                    .iter()
                    .enumerate()
                    .skip(start)
                    .take(count as usize)
                    .map(|(i, (_, label, description))| {
                        let chosen = i == self.suggestion;
                        let label = clip(label, 34, ui.unicode);
                        let text = format!("{}{label:<36}{}", if chosen { "> " } else { "  " }, clip(description, w.saturating_sub(38), ui.unicode));
                        Line::from(Span::styled(format!("{text:<w$}"), if chosen { theme::selected(true) } else { fg(TEXT2) }))
                    })
                    .collect();
                frame.render_widget(Paragraph::new(lines).block(Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(NAVY))).style(theme::base()), rect);
            }
        }
    }

    pub fn draw_output(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let rect = Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area };
        let block = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(NAVY)).title(Span::styled(" Output ", fg(TEXT2)));
        let inner = block.inner(rect);
        let w = inner.width as usize;
        let mut lines: Vec<Line> = vec![];
        for output in &self.blocks {
            let status = match output.status {
                None => Span::styled(if ui.motion { ["◐", "◓", "◑", "◒"][(output.started.elapsed().as_millis() / 200) as usize % 4] } else { "~" }.to_string(), fg(CYAN)),
                Some(0) => Span::styled(if ui.unicode { "✓" } else { "+" }.to_string(), fg(OK)),
                Some(code) => Span::styled(format!("{} {code}", if ui.unicode { "✗" } else { "x" }), fg(ERR)),
            };
            lines.push(Line::from(vec![Span::styled(format!("{} ", if ui.unicode { "❯" } else { ">" }), bold(CYAN)), Span::styled(clip(&output.command, w.saturating_sub(8), ui.unicode), bold(TEXT)), Span::raw("  "), status]));
            for (text, tone) in &output.lines {
                for piece in widgets::wrap(text, w.max(10)) {
                    lines.push(Line::from(Span::styled(format!("  {piece}"), fg(*tone))));
                }
            }
            lines.push(Line::default());
        }
        let visible = inner.height as usize;
        let end = lines.len().saturating_sub(self.scroll_back.min(lines.len().saturating_sub(visible)));
        let start = end.saturating_sub(visible);
        frame.render_widget(Clear, rect);
        frame.render_widget(Paragraph::new(lines[start..end].to_vec()).block(block).style(theme::base()), rect);
        let hint = if self.running.is_some() { " Ctrl+C stops it " } else { " Esc hides this " };
        let hint_width = hint.len() as u16;
        if rect.width > hint_width + 4 {
            frame.render_widget(Paragraph::new(Span::styled(hint, fg(MUTED))), Rect { x: rect.x + rect.width - hint_width - 2, y: rect.y + rect.height - 1, width: hint_width, height: 1 });
        }
    }
}
