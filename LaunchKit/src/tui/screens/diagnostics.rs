// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Diagnostics: every environment check, the terminal, the server and the paths.

use crate::environment::{self, Check, State};
use crate::tui::theme::{bold, fg, ERR, TEXT, TEXT2};
use crate::tui::widgets::{self, card, item, key, row, row_state, status_lines, Key, Menu, MenuEvent, Row};
use crate::tui::{Action, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};

pub struct DiagnosticsScreen {
    menu: Menu,
    items: Vec<Check>,
    updates: Option<Receiver<(Vec<Check>, bool)>>,
    server: Vec<Row>,
    server_updates: Option<Receiver<Vec<Row>>>,
    scroll: u16,
    done: bool,
}

impl DiagnosticsScreen {
    pub fn new(ui: &Ui) -> Self {
        let mut screen = Self {
            menu: Menu::new(vec![item("checks", "Run checks"), item("suites", "Include test suites")]),
            items: ui.checks.clone().unwrap_or_else(|| environment::checks(false)),
            updates: None,
            server: vec![],
            server_updates: None,
            scroll: 0,
            done: ui.checks.is_some(),
        };
        if ui.checks.is_none() {
            screen.run(false, ui);
        }
        let (sender, receiver) = channel();
        let paths = ui.paths.clone();
        std::thread::spawn(move || {
            let rows = match crate::server::active_port(&paths) {
                None => vec![row_state("Server", "not running", State::Skipped)],
                Some(port) => {
                    let body = crate::api::get(port, "/api/v1/system/info", 3.0, &paths).body;
                    let sumo = body.get("sumo").cloned().unwrap_or_default();
                    let available = sumo.get("available").and_then(|v| v.as_bool()).unwrap_or(false);
                    vec![
                        row_state("Server", format!("port {port} · {}", body.get("lifecycle").and_then(|v| v.as_str()).unwrap_or("?").to_lowercase()), State::Pass),
                        row("Version", body.get("version").and_then(|v| v.as_str()).unwrap_or("?")),
                        row("Compiler", body.pointer("/build/compiler").and_then(|v| v.as_str()).unwrap_or("?")),
                        row_state("SUMO", format!("{} {}", if available { "available" } else { "unavailable" }, sumo.get("version").and_then(|v| v.as_str()).unwrap_or("")).trim().to_string(), if available { State::Pass } else { State::Skipped }),
                    ]
                }
            };
            let _ = sender.send(rows);
        });
        screen.server_updates = Some(receiver);
        screen
    }

    fn run(&mut self, suites: bool, ui: &Ui) {
        self.items = environment::checks(suites);
        self.done = false;
        let (sender, receiver) = channel();
        let paths = ui.paths.clone();
        std::thread::spawn(move || {
            let notify = sender.clone();
            let items = environment::run_checks(environment::checks(suites), &paths, move |items| {
                let _ = notify.send((items.to_vec(), false));
            });
            let _ = sender.send((items, true));
        });
        self.updates = Some(receiver);
    }
}

impl Screen for DiagnosticsScreen {
    fn title(&self) -> String {
        "Diagnostics".into()
    }
    fn path(&self) -> String {
        "/diagnostics".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Enter", "Run", "Run", true), key("PgUp/PgDn", "Scroll", "Scroll", false), key("Esc", "Back", "Back", true)]
    }
    fn state(&self) -> Option<(State, String)> {
        Some(if !self.done {
            (State::Running, "checking".into())
        } else if environment::blocking(&self.items).is_empty() {
            (State::Pass, "ready".into())
        } else {
            (State::Fail, "not ready".into())
        })
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let (side, content) = widgets::columns(area, 30, ui.small(), 3);
        let block = card("Run", true);
        let inner = block.inner(side);
        frame.render_widget(block, side);
        self.menu.render(frame, Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner }, true, ui.unicode);
        let block = card("", false);
        let inner = block.inner(content);
        frame.render_widget(block, content);
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        let rows: Vec<Row> = self
            .items
            .iter()
            .map(|c| {
                let mut value = if c.outcome.value.is_empty() && c.outcome.state == State::Running { "Checking...".to_string() } else { c.outcome.value.clone() };
                if c.seconds >= 1.0 && !matches!(c.outcome.state, State::Pending | State::Running) {
                    value += &format!("  ({:.1} s)", c.seconds);
                }
                let mut r = row_state(&format!("{}{}", c.name, if c.required { "" } else { " (optional)" }), value, c.outcome.state);
                if matches!(c.outcome.state, State::Fail | State::Warning) {
                    r.detail = c.outcome.remedy.clone();
                }
                r
            })
            .collect();
        let mut lines = vec![Line::from(Span::styled("ENVIRONMENT", bold(TEXT))), widgets::rule("", inner.width, ui.unicode)];
        lines.extend(status_lines(&rows, 30, inner.width, ui.unicode));
        for check in self.items.iter().filter(|c| c.outcome.state == State::Fail && !c.outcome.detail.is_empty()) {
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(check.name, bold(ERR))));
            let detail: String = check.outcome.detail.trim().chars().rev().take(800).collect::<String>().chars().rev().collect();
            for piece in widgets::wrap(&detail, inner.width as usize) {
                lines.push(Line::from(Span::styled(piece, fg(TEXT2))));
            }
        }
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("SERVER", bold(TEXT2))));
        lines.push(widgets::rule("", inner.width, ui.unicode));
        lines.extend(status_lines(&self.server, 20, inner.width, ui.unicode));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("TERMINAL AND PATHS", bold(TEXT2))));
        lines.push(widgets::rule("", inner.width, ui.unicode));
        let caps = &ui.caps;
        lines.extend(status_lines(
            &[
                row("Launcher", format!("DSTNS {} · Rust", crate::version::engine_version())),
                row("Interface", format!("Terminal · layout {}", ui.layout.name())),
                row("Terminal", format!("{} x {} · colour {} · {}", ui.width, ui.height, caps.colors.name(), if caps.unicode { "Unicode" } else { "ASCII" })),
                row("TERM", if caps.term.is_empty() { "unset".to_string() } else { caps.term.clone() }),
                row("Repository", ui.paths.root.to_string_lossy()),
                row("Logs", ui.paths.logs().to_string_lossy()),
                row("Launcher log", ui.paths.launcher_log().to_string_lossy()),
                row("Program", std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
            ],
            20,
            inner.width,
            ui.unicode,
        ));
        self.scroll = self.scroll.min((lines.len() as u16).saturating_sub(inner.height));
        frame.render_widget(Paragraph::new(lines).scroll((self.scroll, 0)), inner);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        match event.code {
            KeyCode::PageDown => self.scroll += 10,
            KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(10),
            _ => {
                if let MenuEvent::Selected(choice) = self.menu.handle(&event) {
                    self.run(choice == "suites", ui);
                }
            }
        }
        Action::None
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        if let Some(updates) = &self.updates {
            while let Ok((items, done)) = updates.try_recv() {
                self.items = items;
                if done {
                    self.done = true;
                    let quick: Vec<Check> = self.items.iter().filter(|c| !c.slow).cloned().collect();
                    if !quick.is_empty() {
                        ui.checks = Some(quick);
                    }
                }
            }
        }
        if let Some(updates) = &self.server_updates {
            if let Ok(rows) = updates.try_recv() {
                self.server = rows;
                self.server_updates = None;
            }
        }
        Action::None
    }
}
