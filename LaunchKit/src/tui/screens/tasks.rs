// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Tests, Tools, and Demo and Fast Boot: long operations, with live step status and output.
//!
//! Demo Mode and the downloads run as the commands do, in a process of their own, so that what happens here is what
//! happens at the command line; Enter again stops them, as Ctrl+C would.

use crate::environment::State;
use crate::reporting::Reporter;
use crate::tui::theme::{fg, ERR, MUTED, OK, TEXT2};
use crate::tui::widgets::heading;
use crate::tui::widgets::{self, activity, card, key, row_state, status_lines, Key, Menu, MenuEvent, MenuItem, Row};
use crate::tui::{reporter, Action, Dialog, Event_, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Tests,
    Tools,
    Presentation,
}

pub struct TaskScreen {
    kind: Kind,
    menu: Menu,
    title: String,
    steps: Vec<Row>,
    output: Vec<String>,
    result: Option<(bool, String)>,
    busy: Option<String>,
    events: Option<Receiver<Event_>>,
    done: Option<Receiver<(bool, String)>>,
    child: Option<Arc<Mutex<Child>>>,
    started: Instant,
    /// How far the output is scrolled back from its end, in lines as drawn.
    back: usize,
    /// Where the last export was written.
    exported: Option<String>,
}

fn menu_item(key: &str, label: &str, hint: &str) -> MenuItem {
    MenuItem { key: key.into(), label: label.into(), hint: hint.into(), disabled: false }
}

impl TaskScreen {
    fn new(kind: Kind, items: Vec<MenuItem>) -> Self {
        let title = items.iter().find(|i| !i.is_heading()).map(|i| i.label.to_uppercase()).unwrap_or_default();
        Self { kind, menu: Menu::new(items), title, steps: vec![], output: vec![], result: None, busy: None, events: None, done: None, child: None, started: Instant::now(), back: 0, exported: None }
    }
    pub fn tests() -> Self {
        Self::new(
            Kind::Tests,
            vec![
                menu_item("unit", "Native suites", "CTest: unit, property, replay, performance and HTTP suites."),
                menu_item("api", "HTTP contract", "The API smoke test against a private server."),
                menu_item("replay", "Reproducibility", "dstns_replay_verify: one seed run twice must match exactly."),
                menu_item("launcher", "Launcher", "The launcher's own tests."),
                menu_item("ui", "Observer", "The observer's Vitest suites."),
                menu_item("benchmark", "Benchmark", "Routing and snapshot timings on this machine."),
                menu_item("sumo", "SUMO", "The SUMO integration smoke test (needs SUMO)."),
                menu_item("all", "Everything", "Configure, build, then every stage above and the production bundle."),
            ],
        )
    }
    pub fn tools() -> Self {
        Self::new(
            Kind::Tools,
            vec![
                heading("Build and check"),
                menu_item("build", "Build what changed", "The server, the export tool and the observer, each only if its sources changed since it was last built."),
                menu_item("sumo", "Check SUMO toolchain", "Export a synthetic grid, convert it and run SUMO on it. Needs sumo.enabled."),
                menu_item("observer", "Rebuild the observer", "Build the observer bundle again from its sources."),
                heading("Server and services"),
                menu_item("uptime", "Server status", "Whether a server is running, on which port, its state, the moment of the day and its peak memory."),
                menu_item("daemons", "Daemons", "The watchers inside the server: Resource Control, memory, disk, a stalled run and the cache handler, and their state."),
                menu_item("stop", "Stop the server", "Stop the running server, and the applications this launcher started."),
                heading("Places"),
                menu_item("cities", "Supported cities", "Every city a world can be in, with its country, code and ID: filter by typing, and save what is shown as CSV."),
                menu_item("countries", "Choose countries", "Where worlds are, from a list of countries with their codes: Space chooses, - leaves one out, Ctrl+A and Ctrl+D choose all or none, Ctrl+S saves."),
                heading("Engines and AI"),
                menu_item("engines", "Engines and policy", "Each engine's channel, version and kind, which is selected, and how an alpha or beta engine's runs are acknowledged (config/engines.json)."),
                menu_item("model", "Model providers", "Which model answers requests in plain words, and which providers this machine can use."),
                menu_item("mcp-config", "MCP client configuration", "What to add to an MCP client (Claude, an editor) to let it use DSTNS through the MCP Handler."),
                menu_item("mcp-tools", "MCP tools on offer", "The tools an AI client is offered now, and what each may do."),
                menu_item("graph", "Code knowledge graph", "The size of the graph of DSTNS's code, and where it was built from."),
                heading("Launcher state"),
                menu_item("launch-code", "Copy a launch code", "This launcher as one code on the clipboard, with the running world if there is one, and what it carries. ./launcher launch CODE elsewhere starts the same."),
                menu_item("config-docs", "Write config schemas and help", "Rewrite config/schema/ and each config file's _help from the settings table. Values are left as they are."),
                heading("Maintenance"),
                menu_item("reset", "Reset runtime data", "Delete logs, the journal, checkpoints, temporary files and development and test builds (often gigabytes), and forget the setup. Maps, saved seeds, configuration and the built launcher and server are kept."),
                menu_item("cache", "Clear the map cache", "Delete downloaded cities and Dynamic Fastboot's next world; each is downloaded again when needed. Refused while a server runs."),
            ],
        )
    }
    pub fn presentation() -> Self {
        Self::new(
            Kind::Presentation,
            vec![
                menu_item("demo", "Demo Mode", "The start-up film on a loop with every feature, full screen and with music. Enter again ends it."),
                menu_item("download", "Download every city", "For Fast Boot: every city's map, compressed. It takes a long while, and carries on from where it stopped. Enter again stops it."),
                menu_item("status", "Fast Boot status", "How many cities are here, and how much room they take."),
                menu_item("clear", "Delete downloaded cities", "Everything Fast Boot downloaded. The map cache is kept."),
            ],
        )
    }

    /// This page, with a task already begun, as `./launcher ui demo` opens it.
    pub fn begun(mut self, key: &str, ui: &Ui) -> Self {
        self.menu.select(key);
        self.begin(key, ui);
        self
    }

    fn begin(&mut self, key: &str, ui: &Ui) {
        let label = self.menu.items.iter().find(|i| i.key == key).map(|i| i.label.clone()).unwrap_or_default();
        self.title = label.to_uppercase();
        self.steps.clear();
        self.output.clear();
        self.back = 0;
        self.exported = None;
        self.result = None;
        self.busy = Some(label);
        self.started = Instant::now();
        let (events, receiver) = reporter();
        let (finished, done) = channel();
        let paths = ui.paths.clone();
        let key = key.to_string();
        // Tasks that are the launcher's own commands run as a child of it, their output shown as it comes.
        let command: Option<Vec<&str>> = match (self.kind, key.as_str()) {
            (Kind::Presentation, "demo") => Some(vec!["demo"]),
            (Kind::Presentation, "download") => Some(vec!["fastboot", "download"]),
            (Kind::Presentation, "status") => Some(vec!["fastboot", "status"]),
            (Kind::Presentation, _) => Some(vec!["fastboot", "clear", "--yes"]),
            (Kind::Tools, "uptime") => Some(vec!["uptime"]),
            (Kind::Tools, "daemons") => Some(vec!["daemon"]),
            (Kind::Tools, "stop") => Some(vec!["stop"]),
            (Kind::Tools, "model") => Some(vec!["model"]),
            (Kind::Tools, "mcp-config") => Some(vec!["mcp", "client-config"]),
            (Kind::Tools, "mcp-tools") => Some(vec!["mcp", "tools"]),
            (Kind::Tools, "graph") => Some(vec!["graph"]),
            (Kind::Tools, "config-docs") => Some(vec!["config", "docs"]),
            (Kind::Tools, "cache") => Some(vec!["reset", "cache", "--yes"]),
            _ => None,
        };
        if let Some(arguments) = command {
            let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            let spawned = Command::new(exe).args(&arguments).env("NO_COLOR", "1").env("DSTNS_ROOT", &paths.root).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn();
            match spawned {
                Err(error) => {
                    let _ = finished.send((false, format!("It could not be started: {error}")));
                }
                Ok(mut child) => {
                    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
                        let events = events.clone();
                        std::thread::spawn(move || {
                            for line in BufReader::new(stream).lines().map_while(|l| l.ok()) {
                                events.step_output("", &line);
                            }
                        });
                    }
                    let child = Arc::new(Mutex::new(child));
                    self.child = Some(child.clone());
                    std::thread::spawn(move || loop {
                        if let Ok(Some(status)) = child.lock().unwrap().try_wait() {
                            let ok = status.success();
                            let _ = finished.send((ok, if ok { "Done.".into() } else { format!("It stopped with status {}; the output says why.", status.code().unwrap_or(130)) }));
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    });
                }
            }
        } else {
            let kind = self.kind;
            std::thread::spawn(move || {
                let reporter: &dyn Reporter = events.as_ref();
                let outcome = match (kind, key.as_str()) {
                    (Kind::Tests, scope) => {
                        let results = crate::testing::run(scope, reporter, &paths);
                        let failed: Vec<_> = results.iter().filter(|r| !r.passed).collect();
                        match failed.first() {
                            Some(first) => (false, format!("{} of {} stage(s) failed: {}.", failed.len(), results.len(), first.title)),
                            None => (true, format!("All {} stage(s) passed.", results.len())),
                        }
                    }
                    (_, "sumo") => match crate::sumo::run_standalone(reporter, &paths) {
                        Ok(summary) => (true, summary.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join(" · ")),
                        Err(error) => (false, format!("{}{}", error.message, if error.remedy.is_empty() { String::new() } else { format!("\n{}", error.remedy) })),
                    },
                    (_, "build") => match crate::buildplan::ensure_built(reporter, &paths, false, None) {
                        Ok(_) => (true, "Everything is built and current.".into()),
                        Err(error) => (false, format!("{}{}", error.message, if error.remedy.is_empty() { String::new() } else { format!("\n{}", error.remedy) })),
                    },
                    (_, "engines") => (true, crate::config::engines_summary(&paths).join("\n")),
                    (_, "launch-code") => {
                        // With the world when there is one; otherwise the settings alone.
                        let lines = crate::state::launch_code_lines(&paths, true, None, true).or_else(|_| crate::state::launch_code_lines(&paths, false, None, true));
                        match lines {
                            Ok(lines) => (true, lines.join("\n")),
                            Err(why) => (false, why),
                        }
                    }
                    (_, "observer") => {
                        let plan = crate::buildplan::plan(&paths, false, true);
                        let steps: Vec<&crate::buildplan::Step> = plan.steps.iter().filter(|s| s.observer).collect();
                        match crate::buildplan::execute(&steps, reporter, &paths, None) {
                            Ok(()) => (true, "The observer bundle was rebuilt.".into()),
                            Err(error) => (false, crate::buildplan::observer_remedy(&error)),
                        }
                    }
                    _ => {
                        match crate::maintenance::reset(reporter, &paths, &[crate::maintenance::Scope::Runtime, crate::maintenance::Scope::Builds, crate::maintenance::Scope::Setup]) {
                            Ok(()) => (true, "Runtime data and build leftovers cleared, and the setup forgotten. Maps, saved seeds and configuration were kept.".into()),
                            Err(why) => (false, why),
                        }
                    }
                };
                let _ = finished.send(outcome);
            });
        }
        self.events = Some(receiver);
        self.done = Some(done);
    }

    #[cfg(test)]
    pub fn with_output(mut self, lines: &[&str]) -> Self {
        self.output = lines.iter().map(|l| l.to_string()).collect();
        self.result = Some((true, "Done.".into()));
        self
    }

    /// What the last task said and printed, as a text file: in Downloads where there is one, else output/.
    fn export(&mut self, ui: &Ui) -> Action {
        if self.output.is_empty() && self.result.is_none() {
            return Action::Toast("Run something first; there is nothing to export yet.".into(), crate::tui::theme::WARN);
        }
        let stamp = chrono_stamp();
        let name = format!("dstns-{}-{}.txt", self.title.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-").trim_matches('-'), stamp);
        let folder = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Downloads")).filter(|d| d.is_dir()).unwrap_or_else(|| ui.paths.root.join("output"));
        let _ = std::fs::create_dir_all(&folder);
        let path = folder.join(name);
        let mut text = format!("{}\n{}\n\n", self.title, "=".repeat(self.title.chars().count()));
        if let Some((ok, result)) = &self.result {
            text += &format!("{}\n{result}\n\n", if *ok { "Done" } else { "Failed" });
        }
        for line in &self.output {
            text += line;
            text += "\n";
        }
        match std::fs::write(&path, text) {
            Ok(()) => {
                self.exported = Some(path.display().to_string());
                Action::Toast(format!("Exported to {}", path.display()), OK)
            }
            Err(e) => Action::Toast(format!("{} could not be written: {e}", path.display()), ERR),
        }
    }

    fn stop(&mut self) {
        if let Some(child) = &self.child {
            let pid = child.lock().unwrap().id() as i32;
            // As Ctrl+C would: Demo Mode shuts its server down, and a download keeps what it has. Asked again in a
            // way it can't ignore, should it have been started with Ctrl+C ignored.
            unsafe {
                libc::killpg(pid, libc::SIGINT);
            }
            let child = child.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if matches!(child.lock().unwrap().try_wait(), Ok(None)) {
                    unsafe {
                        libc::killpg(pid, libc::SIGTERM);
                    }
                }
            });
        }
    }
}

impl Screen for TaskScreen {
    fn title(&self) -> String {
        match self.kind {
            Kind::Tests => "Tests",
            Kind::Tools => "Tools",
            Kind::Presentation => "Demo and Fast Boot",
        }
        .into()
    }
    fn path(&self) -> String {
        match self.kind {
            Kind::Tests => "/tests",
            Kind::Tools => "/tools",
            Kind::Presentation => "/demo",
        }
        .into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![
            key("Enter", if self.kind == Kind::Presentation { "Run or stop" } else { "Run" }, "Run", true),
            key("PgUp/PgDn", "Scroll output", "Scroll", false),
            key("Ctrl+S", "Export output", "Export", true),
            key("Esc", "Back", "Back", true),
        ]
    }
    fn state(&self) -> Option<(State, String)> {
        match (&self.busy, &self.result) {
            (Some(_), _) => Some((State::Running, "working".into())),
            (None, Some((true, _))) => Some((State::Pass, "done".into())),
            (None, Some((false, _))) => Some((State::Fail, "failed".into())),
            _ => None,
        }
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let (side, content) = widgets::columns(area, widgets::list_width(&self.menu, area, ui.layout == crate::terminal::Layout::Medium), ui.small(), self.menu.items.len() as u16 + 1);
        let block = card(&self.title(), true);
        let inner = block.inner(side);
        frame.render_widget(block, side);
        self.menu.render(frame, inner, true, ui.unicode);
        let block = card(&self.title, false);
        let inner = block.inner(content);
        frame.render_widget(block, content);
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        let mut lines = vec![Line::default()];
        if let Some(label) = &self.busy {
            lines.push(activity(label, true, ui.motion, self.started));
        }
        lines.extend(status_lines(&self.steps, 40, inner.width, ui.unicode));
        match &self.result {
            Some((ok, text)) => lines.extend(widgets::wrap(text, inner.width as usize).into_iter().map(|l| Line::from(Span::styled(l, fg(if *ok { OK } else { ERR })))).collect::<Vec<_>>()),
            None if self.busy.is_none() => {
                let hint = self.menu.current().map(|i| i.hint.clone()).unwrap_or_default();
                lines.extend(widgets::wrap(&hint, inner.width as usize).into_iter().map(|l| Line::from(Span::styled(l, fg(TEXT2)))));
            }
            None => {}
        }
        // The output wrapped, never cut off at the edge; the newest at the bottom, PgUp and PgDn to read back.
        let width = inner.width.max(1) as usize;
        let wrapped: Vec<String> = self.output.iter().flat_map(|l| { let w = widgets::wrap(l, width); if w.is_empty() { vec![String::new()] } else { w } }).collect();
        let heading = if let Some(path) = &self.exported {
            format!("Output · exported to {path}")
        } else if !wrapped.is_empty() || self.result.is_some() {
            "Output · Ctrl+S exports it".to_string()
        } else {
            "Output".to_string()
        };
        lines.push(widgets::rule(&heading, inner.width, ui.unicode));
        let used = (lines.iter().map(|l| (l.width().max(1)).div_ceil(width)).sum::<usize>() as u16).min(inner.height);
        frame.render_widget(Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }), inner);
        let space = inner.height.saturating_sub(used) as usize;
        self.back = self.back.min(wrapped.len().saturating_sub(space));
        let end = wrapped.len() - self.back;
        let start = end.saturating_sub(space);
        let output: Vec<Line> = wrapped[start..end].iter().map(|l| Line::from(Span::styled(l.clone(), fg(TEXT2)))).collect();
        frame.render_widget(Paragraph::new(output), Rect { y: inner.y + used, height: inner.height.saturating_sub(used), ..inner });
        if self.back > 0 {
            let note = format!(" {} more below · PgDn ", self.back);
            let w = note.chars().count() as u16;
            frame.render_widget(Paragraph::new(Line::from(Span::styled(note, fg(MUTED)))), Rect { x: inner.x + inner.width.saturating_sub(w), y: inner.y + inner.height.saturating_sub(1), width: w.min(inner.width), height: 1 });
        }
        let _ = MUTED;
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        match event.code {
            KeyCode::PageUp => {
                self.back += 10;
                return Action::None;
            }
            KeyCode::PageDown => {
                self.back = self.back.saturating_sub(10);
                return Action::None;
            }
            KeyCode::Char('s') if event.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => return self.export(ui),
            _ => {}
        }
        let moved = matches!(event.code, KeyCode::Up | KeyCode::Down | KeyCode::Char('j') | KeyCode::Char('k'));
        match self.menu.handle(&event) {
            MenuEvent::Selected(choice) => {
                if self.busy.is_some() {
                    if self.child.is_some() {
                        self.stop();
                        return Action::None;
                    }
                    return Action::Toast("Wait for the current operation to finish.".into(), crate::tui::theme::WARN);
                }
                if choice == "cities" {
                    return Action::Push(Box::new(super::places::PlacesScreen::cities()));
                }
                if choice == "countries" {
                    return Action::Push(Box::new(super::places::PlacesScreen::countries()));
                }
                if choice == "reset" {
                    let listing = crate::maintenance::describe(&ui.paths, &[crate::maintenance::Scope::Runtime, crate::maintenance::Scope::Builds, crate::maintenance::Scope::Setup]).join("\n");
                    return Action::Dialog(Dialog::confirm("reset", "Reset runtime data?", &format!("These will be deleted:\n{listing}"), "Reset", "Cancel"));
                }
                if choice == "clear" {
                    return Action::Dialog(Dialog::confirm("clear", "Delete downloaded cities?", "Fast Boot downloads them again when asked.", "Delete", "Cancel"));
                }
                if choice == "cache" {
                    return Action::Dialog(Dialog::confirm("cache", "Clear the map cache?", "Downloaded cities and Dynamic Fastboot's next world are deleted. Each is downloaded again when a world needs it.", "Clear", "Cancel"));
                }
                if choice == "stop" {
                    return Action::Dialog(Dialog::confirm("stop", "Stop the server?", "The running simulation stops, and so do the applications this launcher started.", "Stop", "Cancel"));
                }
                self.begin(&choice, ui);
            }
            _ if moved && self.busy.is_none() => {
                self.title = self.menu.current().map(|i| i.label.to_uppercase()).unwrap_or_default();
                self.result = None;
            }
            _ => {}
        }
        Action::None
    }
    fn dialog(&mut self, id: &str, choice: &str, ui: &mut Ui) -> Action {
        if choice == "yes" && ["reset", "clear", "cache", "stop"].contains(&id) {
            self.begin(id, ui);
        }
        Action::None
    }
    fn tick(&mut self, _ui: &mut Ui) -> Action {
        if let Some(events) = &self.events {
            while let Ok(event) = events.try_recv() {
                match event {
                    Event_::Step(state, title, summary) => {
                        let state = match state.as_str() {
                            "running" => State::Running,
                            "pass" => State::Pass,
                            _ => State::Fail,
                        };
                        match self.steps.iter_mut().find(|r| r.name == title) {
                            Some(existing) => {
                                existing.state = Some(state);
                                existing.value = if state == State::Running { String::new() } else { summary };
                            }
                            None => self.steps.push(row_state(&title, if state == State::Running { String::new() } else { summary }, state)),
                        }
                        if state == State::Running {
                            self.busy = Some(title);
                        }
                    }
                    Event_::Output(line) => {
                        self.output.push(line);
                        if self.output.len() > 3000 {
                            self.output.remove(0);
                        }
                    }
                    Event_::Message(_, text, detail) => self.output.push(if detail.is_empty() { text } else { format!("{text} · {detail}") }),
                    _ => {}
                }
            }
        }
        if let Some(done) = &self.done {
            if let Ok(outcome) = done.try_recv() {
                self.result = Some(outcome);
                self.busy = None;
                self.done = None;
                self.child = None;
            }
        }
        Action::None
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        // Leaving stops what this page started.
        if self.child.is_some() {
            self.stop();
        }
        Action::Pop
    }
}

/// The local time as YYYYMMDD-HHMMSS, for file names.
fn chrono_stamp() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t = now as libc::time_t;
    unsafe { libc::localtime_r(&t, &mut tm) };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}
