// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Applications: see them, run them, change them, and decide on what the Fabric API proposes.

use crate::apps::{self as catalogue, App};
use crate::environment::State;
use crate::supervisor::Phase;
use crate::tui::theme::{bold, fg, ACCENT, ERR, TEXT, TEXT2};
use crate::tui::widgets::{self, card, form_row, item, key, row, row_state, status_lines, Editor, Form, Key, Menu, MenuEvent, MenuItem, Row};
use crate::tui::{Action, Dialog, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

fn phase_state(phase: Phase) -> State {
    match phase {
        Phase::Waiting => State::Pending,
        Phase::Preparing | Phase::Starting => State::Running,
        Phase::Ready => State::Pass,
        Phase::Failed => State::Fail,
        Phase::Stopped => State::Skipped,
    }
}

type Poll = (Option<u16>, BTreeMap<String, Value>, Vec<Value>);

pub struct AppsScreen {
    menu: Menu,
    port: Option<u16>,
    connected: BTreeMap<String, Value>,
    waiting: Vec<Value>,
    polls: Option<Receiver<Poll>>,
    last_poll: Option<Instant>,
    error: String,
}

impl AppsScreen {
    pub fn new() -> Self {
        Self { menu: Menu::default(), port: None, connected: BTreeMap::new(), waiting: vec![], polls: None, last_poll: None, error: String::new() }
    }

    fn rebuild(&mut self, ui: &Ui) {
        let entries = match catalogue::load(&ui.paths) {
            Ok(entries) => entries,
            Err(error) => {
                self.error = error.message;
                return;
            }
        };
        self.error.clear();
        let supervisor = ui.session.supervisor();
        let mut items: Vec<MenuItem> = entries
            .values()
            .map(|app| {
                let running = supervisor.as_ref().and_then(|s| s.get(&app.id)).map(|s| s.phase == Phase::Ready).unwrap_or(false);
                item(&format!("app:{}", app.id), &format!("{}{}", if running { if ui.unicode { "● " } else { "* " } } else { "  " }, app.title()))
            })
            .collect();
        for proposal in &self.waiting {
            let id = proposal["id"].as_str().unwrap_or("");
            items.push(item(&format!("proposal:{id}"), &format!("? {id}")));
        }
        items.push(item("add", "+ Add an application"));
        if items.iter().map(|i| (&i.key, &i.label)).ne(self.menu.items.iter().map(|i| (&i.key, &i.label))) {
            self.menu.set_items(items);
        }
    }

    fn describe(&self, key: &str, ui: &Ui) -> (String, Vec<Row>, String) {
        if key == "add" {
            return ("Add an application".into(), vec![], "A command or two that start your program. Once added, it can start alongside any simulation, and the simulation waits until it is ready.".into());
        }
        let (kind, id) = key.split_once(':').unwrap_or(("", key));
        if kind == "proposal" {
            let Some(proposal) = self.waiting.iter().find(|p| p["id"].as_str() == Some(id)) else { return (id.into(), vec![], String::new()) };
            let mut rows = vec![row("Proposed by", proposal["proposed_by"].as_str().unwrap_or("unknown"))];
            for (n, command) in proposal.pointer("/spec/commands").and_then(|c| c.as_array()).cloned().unwrap_or_default().iter().enumerate() {
                rows.push(row(&format!("Command {}", n + 1), command.as_str().unwrap_or("")));
            }
            return (id.into(), rows, "Nothing has run. Enter reads it through with you before anything can.".into());
        }
        let Some(app) = catalogue::load(&ui.paths).ok().and_then(|mut c| c.remove(id)) else { return (id.into(), vec![], String::new()) };
        let mut rows = vec![];
        let running = ui.session.supervisor().and_then(|s| s.get(id));
        match &running {
            Some(s) => {
                let mut r = row_state("Launcher", s.phase.word(), phase_state(s.phase));
                r.detail = s.detail.clone();
                rows.push(r);
            }
            None => rows.push(row_state("Launcher", "Not started", State::Skipped)),
        }
        match self.connected.get(id) {
            Some(connected) => {
                let state = connected["state"].as_str().unwrap_or("");
                let mut word = state.to_string();
                if let Some(first) = word.get_mut(0..1) {
                    first.make_ascii_uppercase();
                }
                rows.push(row_state("Fabric", word, if state == "active" { State::Pass } else { State::Pending }));
                let pending: Vec<&str> = connected.pointer("/capabilities/pending").and_then(|p| p.as_array()).map(|p| p.iter().filter_map(|c| c.as_str()).collect()).unwrap_or_default();
                if !pending.is_empty() {
                    rows.push(row_state("Needs permission", pending.join(", "), State::Warning));
                }
            }
            None => rows.push(row_state("Fabric", if self.port.is_some() { "Not connected" } else { "No server running" }, State::Skipped)),
        }
        for (n, command) in app.commands.iter().enumerate() {
            rows.push(row(&if app.commands.len() > 1 { format!("Command {}", n + 1) } else { "Command".into() }, command.clone()));
        }
        rows.extend([
            row("Runs in", app.cwd.clone()),
            row("Ready when", if app.ready == "fabric" { "It says so".to_string() } else { app.ready.clone() }),
            row("Starts", if app.autostart { "With every run" } else { "When chosen" }),
            row("Required", if app.required { "Yes" } else { "No" }),
        ]);
        if !app.web_url.is_empty() {
            rows.push(row("Web interface", app.web_url.clone()));
        }
        for problem in catalogue::problems(&app, &ui.paths) {
            rows.push(row_state("Problem", problem, State::Fail));
        }
        let mut hint = if running.as_ref().map(|s| s.phase.active()).unwrap_or(false) { "Enter stops it.".to_string() } else { "Enter starts it now, if a server is running.".to_string() };
        if let Some(s) = running.filter(|s| s.phase == Phase::Failed) {
            hint = format!("{}\n{hint}", crate::supervisor::tail(&s.log, 3));
        }
        (app.title(), rows, hint)
    }

    fn selected_app(&self) -> Option<String> {
        self.menu.current_key().and_then(|k| k.strip_prefix("app:").map(String::from))
    }
}

impl Screen for AppsScreen {
    fn title(&self) -> String {
        "Applications".into()
    }
    fn path(&self) -> String {
        "/apps".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Enter", "Run or stop", "Run", true), key("a", "Add", "Add", true), key("e", "Change", "Change", false), key("d", "Remove", "Remove", false), key("Esc", "Back", "Back", true)]
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        if self.menu.items.is_empty() {
            self.rebuild(ui);
        }
        let (side, content) = widgets::columns(area, 30, ui.small(), self.menu.items.len() as u16 + 1);
        let block = card("Applications", true);
        let inner = block.inner(side);
        frame.render_widget(block, side);
        self.menu.render(frame, Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner }, true, ui.unicode);
        let block = card("Details", false);
        let inner = block.inner(content);
        frame.render_widget(block, content);
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        let mut lines = vec![];
        if !self.error.is_empty() {
            lines.push(Line::from(Span::styled(self.error.clone(), fg(ERR))));
        }
        if let Some(current) = self.menu.current_key() {
            let (title, rows, hint) = self.describe(&current, ui);
            lines.push(Line::from(Span::styled(title, bold(TEXT))));
            lines.push(Line::default());
            lines.extend(status_lines(&rows, 18, inner.width, ui.unicode));
            lines.push(Line::default());
            lines.extend(widgets::wrap(&hint, inner.width as usize).into_iter().map(|l| Line::from(Span::styled(l, fg(TEXT2)))));
        }
        frame.render_widget(Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }), inner);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        match event.code {
            KeyCode::Char('a') => return Action::Push(Box::new(AppEditScreen::new(None))),
            KeyCode::Char('e') => {
                if let Some(app) = self.selected_app().and_then(|id| catalogue::get(&id, &ui.paths).ok()) {
                    return Action::Push(Box::new(AppEditScreen::new(Some(app))));
                }
            }
            KeyCode::Char('d') => {
                if let Some(id) = self.selected_app() {
                    return Action::Dialog(Dialog::confirm("remove", "Remove application", &format!("Remove {id} from this launcher?"), "Remove", "Cancel"));
                }
            }
            _ => {}
        }
        let MenuEvent::Selected(choice) = self.menu.handle(&event) else { return Action::None };
        if choice == "add" {
            return Action::Push(Box::new(AppEditScreen::new(None)));
        }
        let (kind, id) = choice.split_once(':').unwrap_or(("", ""));
        if kind == "proposal" {
            let Some(proposal) = self.waiting.iter().find(|p| p["id"].as_str() == Some(id)) else { return Action::None };
            let mut lines = vec![
                Line::from(Span::styled(format!("Proposed by the {}. These will run on this machine, as you:", proposal["proposed_by"].as_str().unwrap_or("unknown")), fg(TEXT))),
                Line::default(),
            ];
            for command in proposal.pointer("/spec/commands").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
                lines.push(Line::from(Span::styled(format!("  {}", command.as_str().unwrap_or("")), fg(ACCENT))));
            }
            return Action::Dialog(Dialog::new(&format!("proposal:{id}"), "Launch proposal", Text::from(lines), &[("later", "Decide later"), ("reject", "Turn it down"), ("approve", "Approve")], Some("later")));
        }
        let supervisor = ui.session.supervisor();
        if let Some(s) = supervisor.as_ref().and_then(|s| s.get(id)).filter(|s| s.phase.active()) {
            let supervisor = supervisor.unwrap();
            let id = id.to_string();
            std::thread::spawn(move || supervisor.stop(&id));
            return Action::Toast(format!("Stopping {}", s.app.title()), ACCENT);
        }
        let Some(port) = self.port else { return Action::Toast("No server is running. Start a simulation first, and choose this application.".into(), crate::tui::theme::WARN) };
        match catalogue::get(id, &ui.paths) {
            Ok(app) => {
                let (events, _receiver) = crate::tui::reporter();
                ui.session.supervise(port, events, crate::process::Cancel::new()).start(app);
                Action::Toast("Starting".into(), ACCENT)
            }
            Err(error) => Action::Toast(error.message, ERR),
        }
    }
    fn dialog(&mut self, id: &str, choice: &str, ui: &mut Ui) -> Action {
        if id == "remove" && choice == "yes" {
            if let Some(app) = self.selected_app() {
                if let Some(supervisor) = ui.session.supervisor() {
                    supervisor.stop(&app);
                }
                let _ = catalogue::remove(&app, &ui.paths);
                self.rebuild(ui);
            }
        }
        if let Some(app_id) = id.strip_prefix("proposal:") {
            let Some(port) = self.port else { return Action::None };
            if choice == "approve" {
                if let Some(proposal) = self.waiting.iter().find(|p| p["id"].as_str() == Some(app_id)) {
                    if let Err(error) = catalogue::put(crate::modules::apps::from_proposal(app_id, &proposal["spec"]), &ui.paths) {
                        return Action::Toast(error.message, ERR);
                    }
                }
            }
            if choice == "approve" || choice == "reject" {
                crate::fabric::withdraw(port, app_id, &ui.paths);
                self.last_poll = None;
            }
        }
        Action::None
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        if let Some(polls) = &self.polls {
            if let Ok((port, connected, waiting)) = polls.try_recv() {
                self.port = port;
                self.connected = connected;
                self.waiting = waiting;
                self.polls = None;
                self.rebuild(ui);
            }
        }
        if self.polls.is_none() && self.last_poll.map(|t| t.elapsed() >= Duration::from_millis(1500)).unwrap_or(true) {
            let (sender, receiver) = channel();
            let session = ui.session.clone();
            let paths = ui.paths.clone();
            std::thread::spawn(move || {
                let port = session.any_port();
                let connected = port.map(|p| crate::fabric::apps(p, &paths).into_iter().filter_map(|a| a["id"].as_str().map(|i| (i.to_string(), a.clone()))).collect()).unwrap_or_default();
                let waiting = port.map(|p| crate::fabric::proposals(p, &paths)).unwrap_or_default();
                let _ = sender.send((port, connected, waiting));
            });
            self.polls = Some(receiver);
            self.last_poll = Some(Instant::now());
        }
        Action::None
    }
    fn resume(&mut self, ui: &mut Ui) {
        self.rebuild(ui);
    }
}

pub struct AppEditScreen {
    existing: Option<App>,
    form: Form,
    error: String,
}

impl AppEditScreen {
    pub fn new(app: Option<App>) -> Self {
        let base = app.clone().unwrap_or_else(|| App::new(""));
        let mut id = form_row("id", "ID", Editor::text(&base.id, "org.example.planner"));
        if app.is_some() {
            if let Editor::Text { disabled, .. } = &mut id.editor {
                *disabled = true;
            }
        }
        let mut commands = form_row("commands", "Commands", Editor::lines(&base.commands.join("\n")));
        commands.hint = "One per line. All but the last must finish; the last stays running. {url}, {port}, {id} and {root} are filled in.".into();
        let mut ready = form_row("ready", "Ready when", Editor::text(&base.ready, ""));
        ready.hint = "fabric: it says so. process: it stays up. delay:5: after five seconds. Or a URL that answers.".into();
        let mut timeout = form_row("timeout", "Wait up to", Editor::number(&crate::config::fmt_g(base.timeout_s)));
        timeout.unit = "s".into();
        let rows = vec![
            id,
            form_row("name", "Name", Editor::text(&base.name, "Route planner")),
            commands,
            form_row("cwd", "Runs in", Editor::text(&base.cwd, "")),
            ready,
            timeout,
            form_row("restart", "If it stops", Editor::select(vec![("Leave it stopped".into(), "never".into()), ("Restart it".into(), "on-failure".into())], &base.restart)),
            form_row("autostart", "Start with runs", Editor::Toggle(base.autostart)),
            form_row("required", "Required", Editor::Toggle(base.required)),
            form_row("web", "Web interface", Editor::text(&base.web_url, "http://127.0.0.1:5173/ (optional)")),
        ];
        let focus = if app.is_some() { 1 } else { 0 };
        Self { existing: app, form: Form { rows, focus, scroll: 0 }, error: String::new() }
    }

    fn save(&mut self, ui: &Ui) -> Action {
        self.form.clear_problems();
        self.error.clear();
        let previous = self.existing.clone().unwrap_or_else(|| App::new(""));
        let Ok(timeout) = self.form.value("timeout").trim().parse::<f64>() else {
            self.form.set_problem("timeout", "Enter a number of seconds.");
            return Action::None;
        };
        let mut app = previous.clone();
        app.id = self.form.value("id").trim().to_string();
        app.name = self.form.value("name").trim().to_string();
        app.commands = self.form.value("commands").lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
        app.cwd = Some(self.form.value("cwd").trim().to_string()).filter(|c| !c.is_empty()).unwrap_or_else(|| ".".into());
        app.ready = Some(self.form.value("ready").trim().to_string()).filter(|c| !c.is_empty()).unwrap_or_else(|| "fabric".into());
        app.timeout_s = timeout;
        app.restart = self.form.value("restart");
        app.autostart = self.form.get("autostart").map(|r| r.editor.toggled()).unwrap_or(false);
        app.required = self.form.get("required").map(|r| r.editor.toggled()).unwrap_or(false);
        app.web_url = self.form.value("web").trim().to_string();
        let exists = self.existing.is_none() && catalogue::load(&ui.paths).map(|c| c.contains_key(&app.id)).unwrap_or(false);
        let outcome = if exists { Err(crate::errors::LauncherError::config(format!("{} already exists.", app.id))) } else { catalogue::put(app, &ui.paths) };
        match outcome {
            Ok(_) => Action::Pop,
            Err(error) => {
                let message = error.message;
                let target = if message.contains("command") {
                    Some("commands")
                } else if message.contains("ready") {
                    Some("ready")
                } else if message.contains("timeout") {
                    Some("timeout")
                } else if message.contains("web") {
                    Some("web")
                } else if message.contains("ID") || message.contains("exists") {
                    Some("id")
                } else {
                    None
                };
                match target {
                    Some(key) => self.form.set_problem(key, &message),
                    None => self.error = message,
                }
                Action::None
            }
        }
    }
}

impl Screen for AppEditScreen {
    fn title(&self) -> String {
        self.existing.as_ref().map(|a| format!("Change {}", a.title())).unwrap_or_else(|| "Add an application".into())
    }
    fn path(&self) -> String {
        "/apps".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Tab", "Next field", "Next", true), key("Ctrl+S", "Save", "Save", true), key("Esc", "Cancel", "Back", true)]
    }
    fn typing(&self) -> bool {
        self.form.focused().map(|r| matches!(r.editor, Editor::Text { .. })).unwrap_or(false)
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let outer = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
        let block = card(&self.title(), true);
        let inner = block.inner(outer);
        frame.render_widget(block, outer);
        let footer = 2;
        self.form.render(frame, Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), height: inner.height.saturating_sub(footer), ..inner }, true, ui.unicode, 24);
        let mut lines = vec![];
        if !self.error.is_empty() {
            lines.push(Line::from(Span::styled(self.error.clone(), fg(ERR))));
        }
        lines.push(Line::from(Span::styled("Ctrl+S saves; Esc cancels.", fg(TEXT2))));
        frame.render_widget(Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }), Rect { y: inner.y + inner.height.saturating_sub(footer), height: footer, x: inner.x + 1, width: inner.width.saturating_sub(2) });
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        if event.modifiers.contains(KeyModifiers::CONTROL) && event.code == KeyCode::Char('s') {
            return self.save(ui);
        }
        let multiline = matches!(self.form.focused().map(|r| &r.editor), Some(Editor::Text { multiline: true, .. }));
        match event.code {
            KeyCode::Tab => {
                self.form.move_focus(1);
            }
            KeyCode::BackTab => {
                self.form.move_focus(-1);
            }
            KeyCode::Down if !multiline => {
                self.form.move_focus(1);
            }
            KeyCode::Up if !multiline => {
                self.form.move_focus(-1);
            }
            KeyCode::Enter if !multiline && matches!(self.form.focused().map(|r| &r.editor), Some(Editor::Text { .. })) => {
                if !self.form.move_focus(1) {
                    return self.save(ui);
                }
            }
            _ => {
                self.form.handle(&event);
            }
        }
        Action::None
    }
}
