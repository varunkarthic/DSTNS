// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Environment check: real checks, shown as they complete.

use crate::environment::{self, Check, State};
use crate::tui::theme::{bold, fg, ERR, TEXT, TEXT2, WARN};
use crate::tui::widgets::{self, activity, key, row_state, status_lines, Key, Menu, MenuEvent, Row};
use crate::tui::{Action, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};

pub struct EnvironmentScreen {
    initial: String,
    items: Vec<Check>,
    updates: Option<Receiver<(Vec<Check>, bool)>>,
    done: bool,
    menu: Menu,
    scroll: u16,
}

impl EnvironmentScreen {
    pub fn new(results: Option<Vec<Check>>, initial: &str) -> Self {
        let mut screen = Self { initial: initial.into(), items: environment::checks(false), updates: None, done: false, menu: Menu::default(), scroll: 0 };
        match results {
            Some(items) => {
                screen.items = items;
                screen.finish_menu();
            }
            None => screen.start(),
        }
        screen
    }

    fn start(&mut self) {
        self.done = false;
        self.items = environment::checks(false);
        let (sender, receiver) = channel();
        let paths = crate::paths::Paths::default();
        std::thread::spawn(move || {
            let notify = sender.clone();
            let items = environment::run_checks(environment::checks(false), &paths, move |items| {
                let _ = notify.send((items.to_vec(), false));
            });
            let _ = sender.send((items, true));
        });
        self.updates = Some(receiver);
        self.menu = Menu::default();
    }

    fn finish_menu(&mut self) {
        self.done = true;
        self.menu = Menu::new(vec![widgets::item("retry", "Retry"), widgets::item("diagnostics", "Diagnostics"), widgets::item("continue", "Continue to the dashboard"), widgets::item("exit", "Exit")]);
    }

    fn rows(&self, required: bool) -> Vec<Row> {
        self.items
            .iter()
            .filter(|c| c.required == required)
            .map(|c| {
                let state = c.outcome.state;
                let value = if c.outcome.value.is_empty() && state == State::Running { "Checking...".to_string() } else { c.outcome.value.clone() };
                let mut r = row_state(c.name, value, state);
                if matches!(state, State::Fail | State::Warning) {
                    r.detail = c.outcome.remedy.clone();
                }
                r
            })
            .collect()
    }
}

impl Screen for EnvironmentScreen {
    fn title(&self) -> String {
        "Environment Check".into()
    }
    fn path(&self) -> String {
        "/environment".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Enter", "Select", "Select", true), key("r", "Retry", "Retry", false), key("q", "Quit", "Quit", true)]
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
        let body = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
        let mut lines: Vec<Line> = vec![];
        if !ui.medium_or_small() {
            lines.extend(widgets::wordmark(body, ui.unicode).lines);
        }
        let complete = self.items.iter().filter(|c| !matches!(c.outcome.state, State::Pending | State::Running)).count();
        lines.push(activity(&if self.done { "Environment check complete".to_string() } else { format!("Checking environment: {complete}/{} complete", self.items.len()) }, !self.done, ui.motion, ui.started));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Required", bold(TEXT2))));
        lines.push(widgets::rule("", body.width, ui.unicode));
        lines.extend(status_lines(&self.rows(true), 20, body.width, ui.unicode));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Optional", bold(TEXT2))));
        lines.push(widgets::rule("", body.width, ui.unicode));
        lines.extend(status_lines(&self.rows(false), 20, body.width, ui.unicode));
        if self.done {
            let blocking = environment::blocking(&self.items);
            let warnings = self.items.iter().filter(|c| c.outcome.state == State::Warning).count();
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(format!("{} required check(s) failed. A simulation cannot start until they pass.", blocking.len()), fg(ERR))));
            for check in blocking {
                lines.push(Line::default());
                lines.push(Line::from(vec![Span::styled(format!("{}: ", check.name), bold(TEXT)), Span::styled(check.outcome.value.clone(), fg(TEXT))]));
                if !check.outcome.detail.is_empty() {
                    for piece in widgets::wrap(&check.outcome.detail.chars().take(400).collect::<String>(), body.width as usize) {
                        lines.push(Line::from(Span::styled(piece, fg(TEXT2))));
                    }
                }
                if !check.outcome.remedy.is_empty() {
                    lines.push(Line::from(Span::styled(format!("Action: {}", check.outcome.remedy), fg(TEXT2))));
                }
            }
            if warnings > 0 {
                lines.push(Line::default());
                lines.push(Line::from(Span::styled(format!("{warnings} warning(s); see above."), fg(WARN))));
            }
            lines.push(Line::default());
        }
        let text_height = lines.len() as u16;
        let menu_height = if self.done { self.menu.items.len() as u16 } else { 0 };
        let total = text_height + menu_height;
        self.scroll = self.scroll.min(total.saturating_sub(area.height));
        if self.done && total > area.height {
            self.scroll = total - area.height;
        }
        frame.render_widget(Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }).scroll((self.scroll, 0)), body);
        if self.done {
            let y = (area.y + text_height).saturating_sub(self.scroll);
            if y < area.y + area.height {
                let h = menu_height.min(area.y + area.height - y);
                self.menu.render(frame, Rect { y, height: h, ..body }, true, ui.unicode);
            }
        }
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        match event.code {
            KeyCode::Char('r') if self.done => {
                self.start();
                return Action::None;
            }
            KeyCode::Char('q') => return Action::Quit,
            _ => {}
        }
        if let MenuEvent::Selected(choice) = self.menu.handle(&event) {
            return match choice.as_str() {
                "retry" => {
                    self.start();
                    Action::None
                }
                "diagnostics" => Action::Push(Box::new(super::diagnostics::DiagnosticsScreen::new(ui))),
                "continue" => super::after_environment(&self.initial.clone(), ui),
                _ => Action::Quit,
            };
        }
        Action::None
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        let mut finished = false;
        if let Some(updates) = &self.updates {
            while let Ok((items, done)) = updates.try_recv() {
                self.items = items;
                finished |= done;
            }
        }
        if finished {
            self.updates = None;
            ui.checks = Some(self.items.clone());
            if environment::blocking(&self.items).is_empty() {
                // Nothing stops a run: continue straight on; warnings stay visible on the dashboard.
                return super::after_environment(&self.initial.clone(), ui);
            }
            self.finish_menu();
        }
        Action::None
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        Action::None
    }
}
