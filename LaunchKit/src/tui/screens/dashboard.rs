// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Dashboard: the launcher's home.

use crate::environment::State;
use crate::simulation::{self, Status};
use crate::tui::theme::{fg, ACCENT, ERR, MUTED, OK, TEXT, TEXT2, WARN};
use crate::tui::widgets::{self, card, heading, item, key, row, row_state, status_lines, Key, Menu, MenuEvent, MenuItem, Row};
use crate::tui::{Action, Screen, Ui};
use crate::version::{engine_version, DOCUMENTATION, FULL_NAME, LICENSE_SPDX, OSM_ATTRIBUTION};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

/// The dashboard's entries in sections: running a simulation, setting it up, looking into it, and help. A key that
/// starts with `section:` is a heading; an empty heading is a blank line.
const ITEMS: &[(&str, &str)] = &[
    ("section:Simulation", "Simulation"),
    ("start", "Start simulation"),
    ("seeds", "Saved seeds"),
    ("section:", ""),
    ("section:Set up", "Set up"),
    ("config", "Configuration"),
    ("diagnostics", "Diagnostics"),
    ("section: ", ""),
    ("section:Tools and services", "Tools and services"),
    ("tools", "Tools"),
    ("tests", "Tests"),
    ("logs", "Logs"),
    ("section:  ", ""),
    ("section:Help", "Help"),
    ("docs", "Documentation"),
    ("about", "About"),
    ("section:   ", ""),
    ("exit", "Exit"),
];

/// The dashboard's own entries, with what each module adds in its place.
pub fn menu_items() -> Vec<MenuItem> {
    let mut items: Vec<MenuItem> = ITEMS.iter().map(|(k, l)| if k.starts_with("section:") { heading(l) } else { item(k, l) }).collect();
    for page in crate::modules::pages() {
        let position = items.iter().position(|i| i.key == page.before).unwrap_or(1);
        items.insert(position, item(page.key, page.label));
    }
    items
}

/// What the dashboard shows of the system, gathered off the interface's thread.
#[derive(Default)]
struct Telemetry {
    port: Option<u16>,
    status: Option<Status>,
    /// The server process: pid, uptime, peak memory, processor time.
    process: Option<serde_json::Value>,
    /// Dynamic Fastboot's next world: from the server, or from next-world.json when none is running.
    next: Option<serde_json::Value>,
    log: Vec<String>,
}

pub struct DashboardScreen {
    menu: Menu,
    port: Option<u16>,
    status: Option<Status>,
    process: Option<serde_json::Value>,
    next: Option<serde_json::Value>,
    log: Vec<String>,
    polls: Option<Receiver<Telemetry>>,
    last_poll: Option<Instant>,
    scroll: u16,
    /// How wide the menu was last drawn, for a click.
    sidebar: u16,
}

impl DashboardScreen {
    pub fn new() -> Self {
        Self { menu: Menu::new(menu_items()), port: None, status: None, process: None, next: None, log: vec![], polls: None, last_poll: None, scroll: 0, sidebar: 30 }
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
            let process = port.and_then(|p| crate::api::process(p, &paths));
            let next = port
                .and_then(|p| crate::api::get(p, "/api/v1/world/status", 2.0, &paths).data().and_then(|d| d.get("next")).cloned())
                .or_else(|| std::fs::read_to_string(paths.map_cache(None).join("next-world.json")).ok().and_then(|t| serde_json::from_str(&t).ok()));
            let log = crate::logs::system_tail(12, &paths).unwrap_or_default();
            let _ = sender.send(Telemetry { port, status, process, next, log });
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
            let start = items.iter().position(|i| i.key == "start").unwrap_or(0);
            items.insert(start, item("running", "Running simulation"));
        }
        if items.iter().map(|i| &i.key).ne(self.menu.items.iter().map(|i| &i.key)) {
            self.menu.set_items(items);
        }
    }

    fn describe(&self, key: &str, ui: &Ui) -> (String, Vec<Row>, Text<'static>) {
        let mut rows = vec![];
        let hint = |text: &str| Text::from(text.lines().map(|l| Line::from(Span::styled(l.to_string(), fg(TEXT2)))).collect::<Vec<_>>());
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
                    _ => rows.insert(0, row("Server", "not running")),
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
            "tools" => ("Tools".into(), rows, hint("\nThe launcher's tools and services: build what changed, check SUMO, see the server, the daemons, the engines and their policy, the model providers and the MCP Handler, copy a launch code, write the config schemas, reset runtime data or clear the map cache.")),
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

    /// The telemetry strip: four panels of short readings, each a name and a value, never a sentence cut short.
    fn cards(&self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let parts = Layout::horizontal([Constraint::Ratio(1, 4); 4]).spacing(2).split(Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area });
        let online = self.status.as_ref().map(|s| s.reachable).unwrap_or(false);
        let write = |frame: &mut Frame, index: usize, title: &str, items: Vec<(&str, String, u32)>| widgets::readings(frame, parts[index], title, items, ui.unicode);
        let process = self.process.clone().unwrap_or_default();
        let uptime = process["uptime_s"].as_f64().map(clock).unwrap_or_else(|| "-".into());
        let memory = process["peak_rss_bytes"].as_f64().map(|b| format!("{:.0} MiB", b / 1048576.0)).unwrap_or_else(|| "-".into());
        write(
            frame,
            0,
            "Engine",
            vec![
                ("state", if online { "online".into() } else { "offline".into() }, if online { OK } else { TEXT2 }),
                ("port", self.port.filter(|_| online).map(|p| p.to_string()).unwrap_or_else(|| "-".into()), TEXT),
                ("pid", process["pid"].as_u64().map(|p| p.to_string()).unwrap_or_else(|| "-".into()), TEXT),
                ("uptime", uptime, TEXT),
                ("memory", memory, TEXT),
            ],
        );
        match &self.status {
            Some(s) if online && (s.active() || s.lifecycle == "COMPLETED") => {
                let bar = widgets::bar(s.fraction, 10, ui.unicode);
                write(frame, 1, "Simulation", vec![("state", s.lifecycle.to_lowercase(), ACCENT), ("clock", s.clock.clone(), TEXT), ("day", bar, ACCENT), ("seed", s.seed.clone(), TEXT2)]);
            }
            _ => write(frame, 1, "Simulation", vec![("state", "idle".into(), TEXT2), ("clock", "--:--:--".into(), MUTED), ("day", "-".into(), MUTED), ("seed", "-".into(), MUTED)]),
        }
        let current = crate::config::load(&ui.paths).unwrap_or_default();
        let next = self.next.clone().unwrap_or_default();
        let fastboot = if !crate::config::flag(&current, "startup.dynamic_fastboot") {
            vec![("mode", "off".to_string(), TEXT2)]
        } else {
            let state = next["state"].as_str().unwrap_or("idle").to_string();
            let tone = match state.as_str() {
                "ready" => OK,
                "fetching" => ACCENT,
                "failed" => ERR,
                _ => TEXT2,
            };
            vec![("mode", "dynamic".into(), TEXT), ("city", next["city"].as_str().unwrap_or("-").to_string(), TEXT), ("state", state, tone), ("seed", next["seed"].as_str().unwrap_or("-").to_string(), TEXT2)]
        };
        write(frame, 2, "Next world", fastboot);
        let checks = ui.checks.clone().unwrap_or_default();
        let failing = checks.iter().filter(|c| c.outcome.state == State::Fail).count();
        let warning = checks.iter().filter(|c| c.outcome.state == State::Warning).count();
        let passed = checks.iter().filter(|c| c.outcome.state == State::Pass).count();
        let known = crate::apps::load(&ui.paths).map(|a| a.len()).unwrap_or(0);
        let running = ui.session.supervisor().map(|s| s.states().iter().filter(|a| a.phase == crate::supervisor::Phase::Ready).count()).unwrap_or(0);
        write(
            frame,
            3,
            "System",
            vec![
                ("checks", format!("{passed}/{} pass", checks.len()), if failing > 0 { ERR } else if warning > 0 { WARN } else { OK }),
                ("apps", format!("{running} up · {known} known"), TEXT),
                ("mcp", if crate::config::flag(&current, "mcp.enabled") { "on".into() } else { "off".into() }, TEXT),
                ("term", format!("{}x{}", ui.width, ui.height), TEXT2),
            ],
        );
    }

    /// The end of the server's own log, as it is written.
    fn log_panel(&self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let block = card("System log", false);
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let w = inner.width as usize;
        let lines: Vec<Line> = if self.log.is_empty() {
            vec![Line::from(Span::styled("nothing yet: it is written once the server starts", fg(MUTED)))]
        } else {
            self.log[self.log.len().saturating_sub(inner.height as usize)..]
                .iter()
                .map(|l| {
                    // The date is the same on every line; the time and the rest say what happened.
                    let shown = l.split_once(' ').filter(|(d, _)| d.len() == 10 && d.chars().nth(4) == Some('-')).map(|(_, rest)| rest).unwrap_or(l);
                    let tone = if l.contains("ERROR") { ERR } else if l.contains("WARN") { WARN } else { TEXT2 };
                    Line::from(Span::styled(widgets::clip(shown, w, ui.unicode), fg(tone)))
                })
                .collect()
        };
        frame.render_widget(Paragraph::new(lines), inner);
    }
}

/// Seconds as hh:mm:ss.
fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

/// What a module's page says on the dashboard.
fn describe_page(key: &str, label: &str, ui: &Ui) -> (String, Vec<Row>, Text<'static>) {
    let hint = |text: &str| Text::from(text.lines().map(|l| Line::from(Span::styled(l.to_string(), fg(TEXT2)))).collect::<Vec<_>>());
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
            let parts = Layout::vertical([Constraint::Length(6), Constraint::Length(1), Constraint::Min(1)]).split(area);
            self.cards(frame, parts[0], ui);
            body = parts[2];
        }
        self.sidebar = widgets::list_width(&self.menu, body, ui.layout == crate::terminal::Layout::Medium);
        let (side, content) = widgets::columns(body, self.sidebar, ui.small(), self.menu.items.len() as u16 + 1);
        if ui.small() {
            self.menu.render(frame, side, true, ui.unicode);
        } else {
            let block = card("Menu", true);
            let inner = block.inner(side);
            frame.render_widget(block, side);
            self.menu.render(frame, inner, true, ui.unicode);
        }
        let Some(current) = self.menu.current_key() else { return };
        let (title, rows, hint) = self.describe(&current, ui);
        // With room, the system log runs below what is selected.
        let (detail, log) = if !ui.small() && content.height >= 22 {
            let parts = Layout::vertical([Constraint::Min(10), Constraint::Length(1), Constraint::Length(9)]).split(content);
            (parts[0], Some(parts[2]))
        } else {
            (content, None)
        };
        let block = card(&title, false);
        let inner = if ui.small() { detail } else { block.inner(detail) };
        if !ui.small() {
            frame.render_widget(block, detail);
        }
        let mut lines = vec![Line::default()];
        lines.extend(status_lines(&rows, 18, inner.width, ui.unicode));
        // Wrapped to the room there is, never cut.
        let words = hint.lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        lines.extend(widgets::wrap(&words, inner.width.max(10) as usize).into_iter().map(|l| Line::from(Span::styled(l, fg(TEXT2)))));
        frame.render_widget(Paragraph::new(lines).scroll((self.scroll, 0)), inner);
        if let Some(log) = log {
            self.log_panel(frame, log, ui);
        }
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
        // Below the status line, the line of air, the telemetry and the menu's own rule.
        let top = if !ui.medium_or_small() && ui.height > 20 { 2 + 6 + 1 + 1 } else { 2 + 1 };
        if column > 1 && column < self.sidebar + 2 && row >= top {
            if let MenuEvent::Selected(key) = self.menu.click(row - top) {
                return self.open(&key, ui);
            }
        }
        Action::None
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        if let Some(polls) = &self.polls {
            if let Ok(telemetry) = polls.try_recv() {
                self.port = telemetry.port;
                self.status = telemetry.status;
                self.process = telemetry.process;
                self.next = telemetry.next;
                self.log = telemetry.log;
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
                Action::Toast(format!("Opening {DOCUMENTATION}"), ACCENT)
            }
            "running" => Action::Push(Box::new(super::running::RunningScreen::new(None))),
            other => super::open(other, "", ui).map(Action::Push).unwrap_or(Action::None),
        }
    }
}
