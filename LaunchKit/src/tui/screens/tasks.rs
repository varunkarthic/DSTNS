// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Tests, Tools, and Demo and Fast Boot: long operations, with live step status and output.
//!
//! Demo Mode and the downloads run as the commands do, in a process of their own, so that what happens here is what
//! happens at the command line; Enter again stops them, as Ctrl+C would.

use crate::environment::State;
use crate::reporting::Reporter;
use crate::tui::theme::{bold, fg, ERR, MUTED, OK, TEXT, TEXT2};
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
}

fn menu_item(key: &str, label: &str, hint: &str) -> MenuItem {
    MenuItem { key: key.into(), label: label.into(), hint: hint.into(), disabled: false }
}

impl TaskScreen {
    fn new(kind: Kind, items: Vec<MenuItem>) -> Self {
        let title = items.first().map(|i| i.label.to_uppercase()).unwrap_or_default();
        Self { kind, menu: Menu::new(items), title, steps: vec![], output: vec![], result: None, busy: None, events: None, done: None, child: None, started: Instant::now() }
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
                menu_item("sumo", "Check SUMO toolchain", "Export a synthetic grid, convert it and run SUMO on it."),
                menu_item("observer", "Rebuild the observer", "Build the observer bundle again from its sources."),
                menu_item("reset", "Reset runtime data", "Delete logs, the journal, checkpoints and temporary files, and forget the setup. Maps, saved seeds and configuration are kept."),
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

    fn begin(&mut self, key: &str, ui: &Ui) {
        let label = self.menu.items.iter().find(|i| i.key == key).map(|i| i.label.clone()).unwrap_or_default();
        self.title = label.to_uppercase();
        self.steps.clear();
        self.output.clear();
        self.result = None;
        self.busy = Some(label);
        self.started = Instant::now();
        let (events, receiver) = reporter();
        let (finished, done) = channel();
        let paths = ui.paths.clone();
        let key = key.to_string();
        if self.kind == Kind::Presentation {
            let arguments: Vec<&str> = match key.as_str() {
                "demo" => vec!["demo"],
                "download" => vec!["fastboot", "download"],
                "status" => vec!["fastboot", "status"],
                _ => vec!["fastboot", "clear", "--yes"],
            };
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
                    (_, "observer") => {
                        let plan = crate::buildplan::plan(&paths, false, true);
                        let steps: Vec<&crate::buildplan::Step> = plan.steps.iter().filter(|s| s.observer).collect();
                        match crate::buildplan::execute(&steps, reporter, &paths, None) {
                            Ok(()) => (true, "The observer bundle was rebuilt.".into()),
                            Err(error) => (false, crate::buildplan::observer_remedy(&error)),
                        }
                    }
                    _ => {
                        crate::maintenance::reset(reporter, &paths);
                        (true, "Runtime data cleared, and the setup forgotten. Maps, saved seeds and configuration were kept.".into())
                    }
                };
                let _ = finished.send(outcome);
            });
        }
        self.events = Some(receiver);
        self.done = Some(done);
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
        vec![key("Enter", if self.kind == Kind::Presentation { "Run or stop" } else { "Run" }, "Run", true), key("Esc", "Back", "Back", true)]
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
        let (side, content) = widgets::columns(area, 30, ui.small(), self.menu.items.len() as u16 + 1);
        let block = card(&self.title(), true);
        let inner = block.inner(side);
        frame.render_widget(block, side);
        self.menu.render(frame, Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner }, true, ui.unicode);
        let block = card("", false);
        let inner = block.inner(content);
        frame.render_widget(block, content);
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        let mut lines = vec![Line::from(Span::styled(self.title.clone(), bold(TEXT))), widgets::rule("", inner.width, ui.unicode)];
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
        lines.push(widgets::rule("Output", inner.width, ui.unicode));
        let used = lines.len() as u16;
        frame.render_widget(Paragraph::new(lines), inner);
        let space = inner.height.saturating_sub(used) as usize;
        let output: Vec<Line> = self.output.iter().rev().take(space).rev().map(|l| Line::from(Span::styled(widgets::clip(l, inner.width as usize, ui.unicode), fg(TEXT2)))).collect();
        frame.render_widget(Paragraph::new(output), Rect { y: inner.y + used, height: inner.height.saturating_sub(used), ..inner });
        let _ = MUTED;
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
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
                if choice == "reset" {
                    let listing = crate::maintenance::describe(&ui.paths).join("\n");
                    return Action::Dialog(Dialog::confirm("reset", "Reset runtime data?", &format!("These will be deleted:\n{listing}"), "Reset", "Cancel"));
                }
                if choice == "clear" {
                    return Action::Dialog(Dialog::confirm("clear", "Delete downloaded cities?", "Fast Boot downloads them again when asked.", "Delete", "Cancel"));
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
        if choice == "yes" && (id == "reset" || id == "clear") {
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
