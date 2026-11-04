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
use super::theme::{self, bold, fg, ACCENT, ERR, GLOW, MUTED, NAVY, OK, TEXT, TEXT2, WARN};
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
    ("ps", "ps [-a]", "What is running: the server, the simulation and applications; -a, every DSTNS server and launcher here"),
    ("kill", "kill APP | server", "Stop an application, or the server"),
    ("start", "start [--seed N] [--day-type D] [--speed X] [--osm-file F] [--apps IDS]", "Start a simulation"),
    ("stop", "stop", "Stop the server and the applications this launcher started"),
    ("pause", "pause", "Pause the simulation"),
    ("resume", "resume", "Resume the simulation"),
    ("restart", "restart", "Back to 00:00:00 in the same world"),
    ("open", "open", "Open the observer in the browser"),
    ("get", "get KEY", "Read a setting"),
    ("set", "set KEY VALUE", "Change a setting"),
    ("unset", "unset KEY", "A setting back to its default"),
    ("json", "json PLACE|FILE [PATH] [-k] [-c]", "Any state as JSON: settings, env, seeds, apps, next-world, status, world, endpoints…"),
    ("view", "view PLACE|FILE [PATH]", "The same as json"),
    ("edit", "edit settings|ui|env|apps|FILE", "Edit in your editor; saved only if it still reads"),
    ("api", "api [METHOD] PATH [BODY|@FILE]", "Any route on the running server, as the operator"),
    ("security", "security [on|off|verify]", "Advanced Security: whether it's on, and how it asks"),
    ("ask", "ask REQUEST  (or just type it)", "A request in plain words, as commands to run, from the launcher's model; nothing runs until Enter"),
    ("model", "model [use PROVIDER [NAME] | key KEY | test]", "The model for plain-word requests: Apple's, Ollama's or Groq's"),
    ("daemon", "daemon [show NAME | on NAME | off NAME | queue emergency|notification]", "The daemons inside the server, and what they have said"),
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
    ("ui", "ui PAGE | open|build|install", "Open the interface on a page (ui demo runs Demo Mode), or the observer: open, build, install"),
    ("about", "about", "Version, copyright, licence and map-data attribution"),
    ("docs", "docs [TOPIC]", "Open the documentation: launcher, console, mcp, fastboot, api, config…"),
    ("grep", "… | grep [-i] [-v] [-c] PATTERN", "Lines that match, from what is piped in"),
    ("wc", "… | wc [-l]", "Count lines, words and characters"),
    ("sort", "… | sort [-r] [-n]", "Sort what is piped in"),
    ("uniq", "… | uniq [-c]", "Repeated lines once"),
    ("cut", "… | cut -d DELIM -f N", "Fields of each line"),
    ("tee", "… | tee FILE", "Also write it to a file"),
    ("echo", "echo WORDS", "Print its words"),
    ("env", "env [set NAME=VALUE | unset NAME]", "Variables in use; set and unset keep them for later runs"),
    ("uptime", "uptime", "The server's uptime, state and memory"),
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

/// The live readings at the right of the prompt, refreshed off the interface's thread; and what the daemons have said.
#[derive(Default)]
struct Stats {
    line: String,
    cpu: Option<(f64, std::time::Instant)>,
    /// The last sequence read from each daemon queue, from when this launcher first heard it.
    heard: Option<(u64, u64)>,
    said: Vec<serde_json::Value>,
}

pub struct Shell {
    pub enabled: bool,
    stats: std::sync::Arc<std::sync::Mutex<Stats>>,
    stats_at: Option<Instant>,
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
    /// A request in plain words, with the model: which output block is its, and the answer when it comes.
    asking: Option<(usize, Receiver<Result<(crate::assistant::Suggestion, String), String>>)>,
}

/// Where the command history is kept between sessions: with the logs, on this machine only.
fn history_file() -> std::path::PathBuf {
    crate::paths::Paths::default().logs().join("command-history")
}

fn load_history() -> Vec<String> {
    if cfg!(test) {
        return vec![];
    }
    std::fs::read_to_string(history_file()).map(|t| t.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect()).unwrap_or_default()
}

fn exe() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "dstns-launcher".into())
}

impl Shell {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            stats: Default::default(),
            stats_at: None,
            open: false,
            input: String::new(),
            cursor: 0,
            history: load_history(),
            history_index: None,
            suggestion: 0,
            suggesting: false,
            blocks: vec![],
            running: None,
            show_output: false,
            asking: None,
            scroll_back: 0,
        }
    }

    pub fn show(&mut self) {
        self.open = true;
        self.suggesting = true;
        self.show_output = !self.blocks.is_empty();
    }

    /// Whether the last command failed: the prompt says so, as a shell's often does.
    fn last_failed(&self) -> bool {
        self.blocks.last().and_then(|b| b.status).map(|s| s != 0).unwrap_or(false)
    }

    pub fn has_output(&self) -> bool {
        self.show_output && !self.blocks.is_empty()
    }

    pub fn dismiss(&mut self) {
        self.show_output = false;
    }

    /// Always there while it is on: a rule, and the prompt.
    pub fn height(&self) -> u16 {
        if self.enabled {
            2
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
            "ui" => crate::cli::UI_PAGES.iter().map(|p| (p.to_string(), "page".to_string())).chain(["open", "build", "install"].map(|a| (a.to_string(), "observer".to_string()))).collect(),
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
                    if self.history.len() > 500 {
                        self.history.remove(0);
                    }
                    if !cfg!(test) {
                        let _ = std::fs::write(history_file(), self.history.join("\n") + "\n");
                    }
                }
                return self.run(&line, ui, &path);
            }
            KeyCode::Tab => {
                self.suggesting = true;
                self.accept(ui);
            }
            KeyCode::Up => {
                // Walking the history stays in the history until something is typed: a recalled command has its own
                // suggestions, which must not take the arrows over.
                if self.history_index.is_none() && self.suggesting && !self.input.is_empty() && !suggestions.is_empty() {
                    self.suggestion = self.suggestion.saturating_sub(1);
                } else if !self.history.is_empty() {
                    let index = self.history_index.map(|i| i.saturating_sub(1)).unwrap_or(self.history.len() - 1);
                    self.history_index = Some(index);
                    self.input = self.history[index].clone();
                    self.cursor = self.input.chars().count();
                    self.suggesting = false;
                }
            }
            KeyCode::Down => {
                if self.history_index.is_none() && self.suggesting && !self.input.is_empty() && !suggestions.is_empty() {
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
                    self.history_index = None;
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

    /// The server's readings for the prompt, every two seconds, from a thread of their own.
    fn refresh_stats(&mut self, ui: &Ui) {
        if !self.enabled || self.stats_at.map(|t| t.elapsed().as_secs_f64() < 2.0).unwrap_or(false) {
            return;
        }
        self.stats_at = Some(Instant::now());
        let (session, paths, stats, unicode) = (ui.session.clone(), ui.paths.clone(), self.stats.clone(), ui.unicode);
        std::thread::spawn(move || {
            let Some(port) = session.any_port() else {
                stats.lock().unwrap().line = format!("{} server stopped", if unicode { "○" } else { "-" });
                return;
            };
            let status = crate::simulation::status(port, &paths);
            let process = crate::api::process(port, &paths).unwrap_or_default();
            let mut held = stats.lock().unwrap();
            // Processor use since the last reading, from the time the server has used.
            let cpu = process["cpu_s"].as_f64().map(|now| {
                let share = held.cpu.map(|(then, at)| (now - then) / at.elapsed().as_secs_f64().max(0.1) * 100.0);
                held.cpu = Some((now, std::time::Instant::now()));
                share
            });
            let mut parts = vec![format!("{} :{port} {}", if unicode { "●" } else { "*" }, status.lifecycle.to_lowercase())];
            if status.active() || status.lifecycle == "COMPLETED" {
                parts.push(status.clock.clone());
            }
            if let Some(Some(share)) = cpu {
                parts.push(format!("cpu {share:.0}%"));
            }
            if let Some(bytes) = process["peak_rss_bytes"].as_f64() {
                parts.push(format!("mem {:.0}M", bytes / 1048576.0));
            }
            held.line = parts.join(if unicode { " · " } else { " | " });
            drop(held);
            crate::daemons::report_and_listen(port, &paths, &session, &stats_said(&stats));
        });
    }

    pub fn tick(&mut self, ui: &mut Ui) -> Action {
        self.refresh_stats(ui);
        // What the daemons said: a warning or worse as a toast; everything into the launcher's log, by the listener.
        let said: Vec<serde_json::Value> = self.stats.lock().map(|mut s| std::mem::take(&mut s.said)).unwrap_or_default();
        if let Some(message) = said.iter().filter(|m| m["level"] != "info").last() {
            let tone = if message["level"] == "warning" { WARN } else { ERR };
            return Action::Toast(format!("{}: {}", message["title"].as_str().unwrap_or(""), message["text"].as_str().unwrap_or("")), tone);
        }
        // The model has answered: its suggestion goes on the prompt, to be run with Enter, or not.
        if let Some((index, answer)) = &self.asking {
            if let Ok(outcome) = answer.try_recv() {
                let index = *index;
                self.asking = None;
                if let Some(block) = self.blocks.get_mut(index) {
                    match outcome {
                        Ok((suggestion, model)) => {
                            block.lines = vec![(format!("Suggested by {model}. Nothing has been run."), TEXT2), (suggestion.line.clone(), ACCENT)];
                            block.lines.extend(suggestion.warnings.iter().map(|w| (format!("Note: {w}"), WARN)));
                            block.lines.push(("Enter runs it, as it is or as you change it. Esc leaves it.".into(), MUTED));
                            block.status = Some(0);
                            crate::log::info(&format!("command bar: suggested {}", suggestion.line));
                            self.input = suggestion.line;
                            self.cursor = self.input.chars().count();
                            self.open = true;
                            self.suggesting = false;
                        }
                        Err(problem) => {
                            block.lines = vec![(problem, ERR)];
                            block.status = Some(1);
                        }
                    }
                }
            }
        }
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

    /// A request in plain words: the model is asked on a thread of its own, and its answer comes back to tick().
    fn ask(&mut self, request: &str, ui: &Ui) {
        if self.asking.is_some() {
            self.say(request, vec![("The model is still answering the last request.".into(), WARN)], 1);
            return;
        }
        let (tx, rx) = channel();
        let paths = ui.paths.clone();
        let wanted = request.to_string();
        std::thread::spawn(move || {
            let _ = tx.send(crate::assistant::suggest(&paths, &wanted).map(|(s, m)| (s, m.label())));
        });
        self.blocks.push(Output { command: format!("ask {request}"), lines: vec![("Asking the model…".into(), TEXT2)], status: None, started: Instant::now() });
        self.show_output = true;
        self.asking = Some((self.blocks.len() - 1, rx));
    }

    fn run(&mut self, line: &str, ui: &mut Ui, path: &str) -> Action {
        crate::log::info(&format!("command bar: {line}"));
        // In plain words: `ask …`, `? …`, or a line whose first word is not a command.
        let request = line.strip_prefix("ask ").or_else(|| line.strip_prefix('?')).map(str::trim).map(String::from).or_else(|| crate::assistant::is_request(line).then(|| line.to_string()));
        if let Some(request) = request.filter(|r| !r.is_empty()) {
            self.ask(&request, ui);
            return Action::None;
        }
        // Commands joined by | && || or ; run in the launcher's console, as a process of its own, so that a long
        // pipeline never holds up the interface and its output streams in.
        if crate::console::chained(line) {
            self.spawn(line, vec!["-c".into(), line.into()]);
            return Action::None;
        }
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
                        Some((_, usage, description)) => vec![(usage.to_string(), ACCENT), (description.to_string(), TEXT)],
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
            "ps" if rest.iter().any(|w| w == "-a") => self.spawn(line, vec!["-c".into(), line.into()]),
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
            // These need the terminal, or the system's prompt, and this process is the one that was verified.
            "edit" | "security" if command == "edit" || rest.first().map(|w| w != "status").unwrap_or(false) => {
                let outcome = crate::inspect::run(&command, &rest, None, &ui.paths).unwrap_or_else(|| Err("not found".into()));
                match outcome {
                    Ok(lines) => self.say(line, lines.into_iter().map(|l| (l, OK)).collect(), 0),
                    Err(problem) => self.say(line, vec![(problem, ERR)], 1),
                }
            }
            other if crate::console::is_builtin(other) && !["ls", "cat", "tail", "head", "ps", "get", "help"].contains(&other) => self.spawn(line, vec!["-c".into(), line.into()]),
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
                    let mut out: Vec<(String, u32)> = config::categories().into_iter().map(|c| (format!("{c}/"), ACCENT)).collect();
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
            lines.push((format!("command       pid {} · running", running.child.id()), ACCENT));
        }
        lines
    }

    pub fn draw(&mut self, frame: &mut Frame, area: Rect, body: Rect, ui: &Ui, path: &str) {
        let suggestions = self.suggestions(ui);
        self.suggestion = self.suggestion.min(suggestions.len().saturating_sub(1));
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
        let stats = self.stats.lock().map(|s| s.line.clone()).unwrap_or_default();
        let secure = crate::security::verified();
        let mut spans = vec![Span::styled(if secure { "dstns·secure" } else { "dstns" }, fg(if secure { OK } else { TEXT2 })), Span::styled(format!(" {} ", if path == "/" { "~".to_string() } else { format!("~{path}") }), fg(ACCENT)), Span::styled(if ui.unicode { "❯ " } else { "> " }, bold(if self.last_failed() { ERR } else { ACCENT }))];
        if self.open {
            let tones = tones(&self.input);
            let at = self.cursor;
            spans.extend(coloured(&self.input, &tones, 0, at));
            spans.push(Span::styled(under, fg(tones.get(at).copied().unwrap_or(TEXT)).patch(cursor_style)));
            spans.extend(coloured(&self.input, &tones, at + 1, usize::MAX));
            spans.push(Span::styled(ghost, fg(MUTED)));
            let _ = (before, after);
        } else {
            let used: usize = spans.iter().map(|s| widgets::width(&s.content)).sum();
            // Room is left for the readings at the right.
            let keep = if stats.is_empty() { 0 } else { widgets::width(&stats) + 4 };
            spans.push(Span::styled(clip("type a command, or : to begin · help · cmd | grep x && …", (area.width as usize).saturating_sub(used + 3 + keep), ui.unicode), fg(MUTED)));
        }
        let rule = widgets::rule("", area.width, ui.unicode);
        let rect = Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area };
        // The live readings at the right, where there is room for them beside what is typed.
        let used: usize = spans.iter().map(|s| widgets::width(&s.content)).sum();
        let room = (rect.width as usize).saturating_sub(used + 2);
        if !stats.is_empty() && widgets::width(&stats) + 2 <= room {
            spans.push(Span::raw(" ".repeat(room - widgets::width(&stats))));
            spans.push(Span::styled(stats, fg(TEXT2)));
        }
        frame.render_widget(Paragraph::new(vec![rule, Line::from(spans)]).style(theme::base()), rect);
        let boxed = rect;
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
                frame.render_widget(Paragraph::new(lines).block(Block::default().borders(Borders::ALL).border_type(BorderType::Plain).border_style(fg(NAVY))).style(theme::base()), rect);
            }
        }
    }

    pub fn draw_output(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let rect = Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area };
        let block = Block::default().borders(Borders::TOP).border_type(BorderType::Plain).border_style(fg(NAVY)).title(Span::styled(" OUTPUT ", bold(TEXT2)));
        let inner = block.inner(rect);
        let w = inner.width as usize;
        let mut lines: Vec<Line> = vec![];
        for output in &self.blocks {
            let status = match output.status {
                None => Span::styled(if ui.motion { ["◐", "◓", "◑", "◒"][(output.started.elapsed().as_millis() / 200) as usize % 4] } else { "~" }.to_string(), fg(ACCENT)),
                Some(0) => Span::styled(if ui.unicode { "✓" } else { "+" }.to_string(), fg(OK)),
                Some(code) => Span::styled(format!("{} {code}", if ui.unicode { "✗" } else { "x" }), fg(ERR)),
            };
            lines.push(Line::from(vec![Span::styled(format!("{} ", if ui.unicode { "❯" } else { ">" }), bold(ACCENT)), Span::styled(clip(&output.command, w.saturating_sub(8), ui.unicode), bold(TEXT)), Span::raw("  "), status]));
            let json = ["json", "view", "api"].contains(&output.command.split_whitespace().next().unwrap_or(""));
            for (text, tone) in &output.lines {
                // A line keeps its indent when it wraps, so that indented JSON and tables still line up.
                let lead = text.len() - text.trim_start().len();
                let indent = " ".repeat(lead.min(w / 2));
                for piece in widgets::wrap(text.trim_start(), w.saturating_sub(indent.len()).max(10)) {
                    let piece = format!("  {indent}{piece}");
                    lines.push(if json && *tone == TEXT { Line::from(json_spans(&piece)) } else { Line::from(Span::styled(piece, fg(*tone))) });
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

/// A colour for each character of a command line as it is typed: commands, operators, quoted text and options.
pub fn tones(line: &str) -> Vec<u32> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = vec![TEXT; chars.len()];
    let mut quote: Option<char> = None;
    let mut first = true;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            out[i] = OK;
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                out[i] = OK;
                first = false;
            }
            '|' | '&' | ';' => {
                out[i] = WARN;
                first = true;
            }
            ' ' => {}
            _ => {
                // A word: the first of each command, an option, or anything else.
                let start = i;
                while i < chars.len() && !matches!(chars[i], ' ' | '|' | '&' | ';' | '\'' | '"') {
                    i += 1;
                }
                let tone = if first { ACCENT } else if chars[start] == '-' { TEXT2 } else { TEXT };
                out[start..i].iter_mut().for_each(|t| *t = tone);
                first = false;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// The characters from `from` to `to`, as spans of one colour each.
fn coloured(line: &str, tones: &[u32], from: usize, to: usize) -> Vec<Span<'static>> {
    let mut spans: Vec<Span<'static>> = vec![];
    let mut run = String::new();
    let mut tone = None;
    for (i, c) in line.chars().enumerate().skip(from).take(to.saturating_sub(from)) {
        if tone != Some(tones[i]) && !run.is_empty() {
            spans.push(Span::styled(std::mem::take(&mut run), fg(tone.unwrap_or(TEXT))));
        }
        tone = Some(tones[i]);
        run.push(c);
    }
    if !run.is_empty() {
        spans.push(Span::styled(run, fg(tone.unwrap_or(TEXT))));
    }
    spans
}

/// A line of indented JSON in the theme's colours: keys in the accent, strings, numbers and literals each their own.
fn json_spans(line: &str) -> Vec<Span<'static>> {
    let indent = line.len() - line.trim_start().len();
    let body = &line[indent..];
    let mut spans = vec![Span::raw(line[..indent].to_string())];
    let value = match body.strip_prefix('"').and_then(|b| b.find("\": ").map(|i| (i, b))) {
        Some((i, b)) => {
            spans.push(Span::styled(format!("\"{}\"", &b[..i]), fg(ACCENT)));
            spans.push(Span::styled(": ".to_string(), fg(MUTED)));
            &b[i + 3..]
        }
        None => body,
    };
    let bare = value.trim_end_matches(',');
    let tone = if bare.starts_with('"') {
        OK
    } else if bare.parse::<f64>().is_ok() {
        WARN
    } else if ["true", "false", "null"].contains(&bare) {
        GLOW
    } else {
        MUTED
    };
    spans.push(Span::styled(bare.to_string(), fg(tone)));
    spans.push(Span::styled(value[bare.len()..].to_string(), fg(MUTED)));
    spans
}

#[cfg(test)]
mod tone_tests {
    use super::*;

    #[test]
    fn a_line_is_coloured_by_what_each_part_is() {
        let line = "logs api | grep -i '500 x' && stop";
        let t = tones(line);
        let at = |word: &str| t[line.find(word).unwrap()];
        assert_eq!(at("logs"), ACCENT, "a command");
        assert_eq!(at("api"), TEXT);
        assert_eq!(at("|"), WARN, "an operator");
        assert_eq!(at("grep"), ACCENT, "the next command");
        assert_eq!(at("-i"), TEXT2, "an option");
        assert_eq!(at("'500"), OK, "quoted text, spaces and all");
        assert_eq!(t[line.find("x'").unwrap()], OK);
        assert_eq!(at("stop"), ACCENT);
    }
}

/// What the poller hands the daemons' listener: a place for their cursors and what they said.
fn stats_said(stats: &std::sync::Arc<std::sync::Mutex<Stats>>) -> crate::daemons::Inbox {
    let stats = stats.clone();
    crate::daemons::Inbox::new(
        {
            let stats = stats.clone();
            move || stats.lock().ok().and_then(|s| s.heard)
        },
        move |heard, said| {
            if let Ok(mut s) = stats.lock() {
                s.heard = Some(heard);
                s.said.extend(said);
            }
        },
    )
}
