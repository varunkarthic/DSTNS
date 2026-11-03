// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Dashboard: the launcher's home.

use crate::environment::State;
use crate::simulation::{self, Status};
use crate::tui::theme::{bold, fg, CYAN, ERR, OK, TEXT, TEXT2, WARN};
use crate::tui::widgets::{self, card, item, key, row, row_state, status_lines, Key, Menu, MenuEvent, MenuItem, Row};
use crate::tui::{Action, Screen, Ui};
use crate::version::{engine_version, DOCUMENTATION, FULL_NAME, LICENSE_SPDX, OSM_ATTRIBUTION};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

const ITEMS: &[(&str, &str)] = &[
    ("start", "Start simulation"),
    ("seeds", "Saved seeds"),
    ("config", "Configuration"),
    ("diagnostics", "Diagnostics"),
    ("logs", "Logs"),
    ("tests", "Tests"),
    ("tools", "Tools"),
    ("docs", "Documentation"),
    ("about", "About"),
    ("exit", "Exit"),
];

/// The dashboard's own entries, with what each module adds in its place.
pub fn menu_items() -> Vec<MenuItem> {
    let mut items: Vec<MenuItem> = ITEMS.iter().map(|(k, l)| item(k, l)).collect();
    for page in crate::modules::pages() {
        let position = items.iter().position(|i| i.key == page.before).unwrap_or(1);
        items.insert(position, item(page.key, page.label));
    }
    items
}

pub struct DashboardScreen {
    menu: Menu,
    port: Option<u16>,
    status: Option<Status>,
    polls: Option<Receiver<(Option<u16>, Option<Status>)>>,
    last_poll: Option<Instant>,
    scroll: u16,
}

impl DashboardScreen {
    pub fn new() -> Self {
        Self { menu: Menu::new(menu_items()), port: None, status: None, polls: None, last_poll: None, scroll: 0 }
    }

    fn poll(&mut self, ui: &Ui) {
        if self.polls.is_some() {
            return;
        }
        let (sender, receiver) = channel();
        let session = ui.session.clone();
        let paths = ui.paths.clone();
        std::thread::spawn(move || {
            let port = session.any_port();
            let status = port.map(|p| simulation::status(p, &paths));
            let _ = sender.send((port, status));
        });
        self.polls = Some(receiver);
        self.last_poll = Some(Instant::now());
    }

    fn live(&self) -> bool {
        self.status.as_ref().map(|s| s.reachable && ["RUNNING", "PAUSED", "SEEKING", "READY", "COMPLETED", "PREPARING"].contains(&s.lifecycle.as_str())).unwrap_or(false)
    }

    fn refresh_menu(&mut self) {
        let mut items = menu_items();
        if self.live() {
            items.insert(0, item("running", "Running simulation"));
        }
        if items.iter().map(|i| &i.key).ne(self.menu.items.iter().map(|i| &i.key)) {
            self.menu.set_items(items);
        }
    }

    fn describe(&self, key: &str, ui: &Ui) -> (String, Vec<Row>, Text<'static>) {
        let mut rows = vec![];
        let hint = |text: &str| Text::from(widgets::wrap(text, 80).into_iter().map(|l| Line::from(Span::styled(l, fg(TEXT2)))).collect::<Vec<_>>());
        if let Some(page) = crate::modules::pages().into_iter().find(|p| p.key == key) {
            return describe_page(page.key, page.label, ui);
        }
        let check_row = |key: &str, name: &str| -> Option<Row> {
            ui.checks.as_ref()?.iter().find(|c| c.key == key).map(|c| row_state(name, c.outcome.value.clone(), c.outcome.state))
        };
        match key {
            "start" | "running" => {
                for (k, n) in [("configuration", "Configuration"), ("core", "Simulation core"), ("observer", "Observer"), ("cache", "Map cache"), ("sumo", "SUMO")] {
                    if let Some(r) = check_row(k, n) {
                        rows.push(r);
                    }
                }
                match &self.status {
                    Some(s) if s.reachable => {
                        rows.insert(0, row_state("Server", format!("port {} · {}", self.port.unwrap_or(0), s.lifecycle.to_lowercase()), State::Pass));
                        if s.active() || s.lifecycle == "COMPLETED" {
                            rows.insert(1, row("Simulation time", format!("{} ({:.0}%)", s.clock, s.fraction * 100.0)));
                            if !s.seed.is_empty() {
                                rows.insert(2, row("Seed", s.seed.clone()));
                            }
                        }
                    }
                    _ => rows.insert(0, row_state("Server", "not running", State::Skipped)),
                }
                rows.push(row("Workspace", ui.paths.relative(&ui.paths.logs())));
                if key == "running" {
                    ("Running simulation".into(), rows, hint("\nEnter shows the running simulation."))
                } else {
                    ("Start simulation".into(), rows, hint("\nEnter chooses a seed and starts a simulation. The observer opens in your browser."))
                }
            }
            "seeds" => match crate::seeds::operate("list", &serde_json::json!({}), &ui.paths) {
                Err(error) => ("Saved seeds".into(), vec![row_state("Store", error.message, State::Fail)], Text::default()),
                Ok(saved) => {
                    let saved = saved.as_array().cloned().unwrap_or_default();
                    for record in saved.iter().take(6) {
                        rows.push(row(record["id"].as_str().unwrap_or(""), record["seed"].as_str().unwrap_or("")));
                    }
                    let text = if saved.is_empty() { "\nNo saved seeds yet. Save one when starting a simulation.".to_string() } else { format!("\n{} saved. Enter lists them, to start, inspect or delete.", saved.len()) };
                    ("Saved seeds".into(), rows, hint(&text))
                }
            },
            "config" => {
                match crate::config::load(&ui.paths) {
                    Ok(current) => {
                        for field in crate::config::fields().iter().filter(|f| ["Run", "Server", "Startup", "Performance"].contains(&f.category)).take(12) {
                            rows.push(row(field.label, format!("{} {}", field.display(&field.get(&current)), field.unit).trim().to_string()));
                        }
                    }
                    Err(error) => rows.push(row_state("defaults.json", error.message, State::Fail)),
                }
                ("Configuration".into(), rows, hint("\nEnter edits config/defaults.json: every feature, from Fabric to music, has a setting."))
            }
            "diagnostics" => {
                for check in ui.checks.iter().flatten().filter(|c| matches!(c.outcome.state, State::Fail | State::Warning)) {
                    rows.push(row_state(check.name, check.outcome.value.clone(), check.outcome.state));
                }
                if rows.is_empty() {
                    rows.push(row_state("Environment", "all checks passed", State::Pass));
                }
                ("Diagnostics".into(), rows, hint("\nEnter re-runs every check, optionally with the test suites, and shows terminal and server details."))
            }
            "logs" => ("Logs".into(), rows, hint("\nThe server's system log, and its journal of API requests, operator events and lifecycle changes.")),
            "tests" => ("Tests".into(), rows, hint("\nRun the native, HTTP, reproducibility, SUMO, launcher and observer test stages.")),
            "tools" => ("Tools".into(), rows, hint("\nCheck the SUMO toolchain, rebuild the observer, or reset runtime data.")),
            "docs" => ("Documentation".into(), vec![row("Online", DOCUMENTATION)], hint("\nEnter opens the documentation in your browser.")),
            "about" => {
                let copyright = if ui.unicode { "© 2026 Varun Karthic" } else { "(C) 2026 Varun Karthic" };
                let osm = if ui.unicode { OSM_ATTRIBUTION } else { "(C) OpenStreetMap contributors" };
                rows.extend([row("Version", engine_version()), row("Copyright", copyright), row("Licence", LICENSE_SPDX), row("Map data", osm)]);
                ("About".into(), rows, hint(&format!("\n{FULL_NAME}.")))
            }
            _ => ("Exit".into(), rows, hint("\nLeave the launcher. A simulation this launcher started is stopped first, after confirmation.")),
        }
    }

    fn cards(&self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let parts = Layout::horizontal([Constraint::Ratio(1, 4); 4]).spacing(1).split(Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area });
        let online = self.status.as_ref().map(|s| s.reachable).unwrap_or(false);
        let mut write = |index: usize, title: &str, first: String, second: String, tone: u32| {
            let lines = vec![Line::from(Span::styled(widgets::clip(&first, parts[index].width.saturating_sub(4) as usize, ui.unicode), bold(tone))), Line::from(Span::styled(widgets::clip(&second, parts[index].width.saturating_sub(4) as usize, ui.unicode), fg(TEXT2)))];
            frame.render_widget(Paragraph::new(lines).block(card(title, false).padding(ratatui::widgets::Padding::horizontal(1))), parts[index]);
        };
        write(0, "Engine", engine_version().into(), if online { format!("Serving on port {}", self.port.unwrap_or(0)) } else { "Not running".into() }, if online { OK } else { TEXT });
        match &self.status {
            Some(s) if online && (s.active() || s.lifecycle == "COMPLETED") => {
                let mut state = s.lifecycle.to_lowercase();
                if let Some(first) = state.get_mut(0..1) {
                    first.make_ascii_uppercase();
                }
                write(1, "Simulation", s.clock.clone(), format!("{state}, {:.0}% of the day", s.fraction * 100.0), CYAN)
            }
            _ => write(1, "Simulation", "None".into(), if online { "Ready to start".into() } else { "Start one from here".into() }, TEXT),
        }
        let known = crate::apps::load(&ui.paths).map(|a| a.len()).unwrap_or(0);
        let running = ui.session.supervisor().map(|s| s.states().iter().filter(|a| a.phase == crate::supervisor::Phase::Ready).count()).unwrap_or(0);
        if running > 0 {
            write(2, "Applications", format!("{running} running"), format!("{known} set up"), TEXT);
        } else {
            write(2, "Applications", format!("{known} set up"), if known == 0 { "Enter Applications to add".into() } else { "None running".into() }, TEXT);
        }
        let checks = ui.checks.clone().unwrap_or_default();
        let failing: Vec<_> = checks.iter().filter(|c| c.outcome.state == State::Fail).collect();
        let warning = checks.iter().filter(|c| c.outcome.state == State::Warning).count();
        if let Some(first) = failing.first() {
            write(3, "This machine", "Not ready".into(), first.name.into(), ERR);
        } else if warning > 0 {
            write(3, "This machine", "Ready".into(), format!("{warning} to look at"), WARN);
        } else {
            write(3, "This machine", "Ready".into(), format!("{} checks passed", checks.len()), OK);
        }
    }
}

/// What a module's page says on the dashboard.
fn describe_page(key: &str, label: &str, ui: &Ui) -> (String, Vec<Row>, Text<'static>) {
    let hint = |text: &str| Text::from(widgets::wrap(text, 80).into_iter().map(|l| Line::from(Span::styled(l, fg(TEXT2)))).collect::<Vec<_>>());
    match key {
        "apps" => match crate::apps::load(&ui.paths) {
            Err(error) => (label.into(), vec![row_state("Catalogue", error.message, State::Fail)], Text::default()),
            Ok(entries) => {
                let rows = entries.values().take(6).map(|a| row(&a.title(), if a.autostart { "with every run" } else { "when chosen" })).collect();
                let text = if entries.is_empty() { "\nNone yet. Enter adds one: a command or two that start your program alongside the simulation." } else { "\nEnter shows them, to add, run or change one." };
                (label.into(), rows, hint(text))
            }
        },
        "presentation" => {
            let current = crate::config::load(&ui.paths).unwrap_or_default();
            let (count, _) = crate::modules::fastboot::here(&ui.paths);
            let on = |k: &str| if crate::config::flag(&current, k) { "on" } else { "off" };
            (
                label.into(),
                vec![row("Fast Boot", on("startup.fast_boot")), row("Cities downloaded", count.to_string()), row("Demo music", on("demo.music")), row("MCP Handler", on("mcp.enabled"))],
                hint("\nEnter shows them: play Demo Mode, or download every city for Fast Boot."),
            )
        }
        _ => (label.into(), vec![], Text::default()),
    }
}

impl Screen for DashboardScreen {
    fn title(&self) -> String {
        "Dashboard".into()
    }
    fn path(&self) -> String {
        "/".into()
    }
    fn keys(&self, ui: &Ui) -> Vec<Key> {
        vec![key(if ui.unicode { "↑↓" } else { "Up/Down" }, "Navigate", "Move", true), key("Enter", "Select", "Select", true), key("q", "Quit", "Quit", false)]
    }
    fn state(&self) -> Option<(State, String)> {
        Some(if self.status.as_ref().map(|s| s.reachable && s.lifecycle == "RUNNING").unwrap_or(false) {
            (State::Running, "running".into())
        } else {
            (State::Pass, "ready".into())
        })
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let mut body = area;
        if !ui.medium_or_small() && area.height > 14 {
            let parts = Layout::vertical([Constraint::Length(5), Constraint::Min(1)]).split(area);
            self.cards(frame, parts[0], ui);
            body = parts[1];
        }
        let sidebar_width = if ui.layout == crate::terminal::Layout::Medium { 24 } else { 30 };
        let (side, content) = widgets::columns(body, sidebar_width, ui.small(), self.menu.items.len() as u16 + 1);
        if ui.small() {
            self.menu.render(frame, side, true, ui.unicode);
        } else {
            let block = card("Menu", true);
            let inner = block.inner(side);
            frame.render_widget(block, side);
            self.menu.render(frame, Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner }, true, ui.unicode);
        }
        let Some(current) = self.menu.current_key() else { return };
        let (title, rows, hint) = self.describe(&current, ui);
        let block = card("", false);
        let inner = if ui.small() { content } else { block.inner(content) };
        if !ui.small() {
            frame.render_widget(block, content);
        }
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        let mut lines = vec![Line::from(Span::styled(title.to_uppercase(), bold(TEXT))), Line::default()];
        lines.extend(status_lines(&rows, 18, inner.width, ui.unicode));
        lines.extend(hint.lines);
        frame.render_widget(Paragraph::new(lines).scroll((self.scroll, 0)), inner);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        if event.code == KeyCode::Char('q') {
            return Action::Quit;
        }
        match self.menu.handle(&event) {
            MenuEvent::Selected(key) => self.open(&key, ui),
            MenuEvent::Moved => {
                self.scroll = 0;
                Action::None
            }
            MenuEvent::None => Action::None,
        }
    }
    fn click(&mut self, column: u16, row: u16, ui: &mut Ui) -> Action {
        let top = if !ui.medium_or_small() && ui.height > 20 { 3 + 5 + 1 } else { 3 + 1 };
        let sidebar = if ui.layout == crate::terminal::Layout::Medium { 24 } else { 30 };
        if column > 1 && column < sidebar + 2 && row >= top {
            if let MenuEvent::Selected(key) = self.menu.click(row - top) {
                return self.open(&key, ui);
            }
        }
        Action::None
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        if let Some(polls) = &self.polls {
            if let Ok((port, status)) = polls.try_recv() {
                self.port = port;
                self.status = status;
                self.polls = None;
                self.refresh_menu();
            }
        }
        if self.last_poll.map(|t| t.elapsed() >= Duration::from_secs(2)).unwrap_or(true) {
            self.poll(ui);
        }
        Action::None
    }
    fn resume(&mut self, ui: &mut Ui) {
        self.refresh_menu();
        self.poll(ui);
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        Action::None
    }
}

impl DashboardScreen {
    fn open(&mut self, key: &str, ui: &mut Ui) -> Action {
        match key {
            "exit" => Action::Quit,
            "docs" => {
                let _ = crate::simulation::open_in_browser(DOCUMENTATION);
                Action::Toast(format!("Opening {DOCUMENTATION}"), CYAN)
            }
            "running" => Action::Push(Box::new(super::running::RunningScreen::new(None))),
            other => super::open(other, "", ui).map(Action::Push).unwrap_or(Action::None),
        }
    }
}
