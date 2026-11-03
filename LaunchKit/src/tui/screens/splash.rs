// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The project wordmark and real start-up checks, with a short readable hold.

use crate::environment::{self, Check, State};
use crate::tui::theme::{bold, fg, CYAN, MUTED, TEXT, TEXT2};
use crate::tui::widgets::{self, activity, Key};
use crate::tui::{Action, Screen, Ui};
use crate::version::{engine_version, FULL_NAME, LICENSE_SPDX};
use crossterm::event::KeyEvent;
use ratatui::layout::{Alignment, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

const MINIMUM: Duration = Duration::from_secs(3);

pub struct SplashScreen {
    initial: String,
    items: Vec<Check>,
    updates: Receiver<(Vec<Check>, bool)>,
    started: Instant,
    finished: Option<Instant>,
    detail: String,
}

impl SplashScreen {
    pub fn new(initial: &str) -> Self {
        let (sender, updates) = channel();
        let paths = crate::paths::Paths::default();
        std::thread::spawn(move || {
            let notify = sender.clone();
            let items = environment::run_checks(environment::checks(false), &paths, move |items| {
                let _ = notify.send((items.to_vec(), false));
            });
            let _ = sender.send((items, true));
        });
        Self { initial: initial.into(), items: environment::checks(false), updates, started: Instant::now(), finished: None, detail: String::new() }
    }
}

impl Screen for SplashScreen {
    fn title(&self) -> String {
        String::new()
    }
    fn path(&self) -> String {
        "/splash".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![]
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let content = Rect { x: area.x + area.width.saturating_sub(76.min(area.width)) / 2, width: 76.min(area.width), ..area };
        let logo = widgets::wordmark(Rect { height: if area.height >= 22 { 7 } else if area.height >= 20 { 5 } else { 1 }, ..content }, ui.unicode);
        let complete = self.items.iter().filter(|c| !matches!(c.outcome.state, State::Pending | State::Running)).count();
        let blocking = environment::blocking(&self.items).len();
        let label = match self.finished {
            None => format!("Startup checks: {complete}/{} complete", self.items.len()),
            Some(_) if blocking > 0 => format!("{blocking} required check(s) need attention"),
            Some(_) => "Startup checks complete".into(),
        };
        let copyright = if ui.unicode { "© 2026 Varun Karthic" } else { "(C) 2026 Varun Karthic" };
        let mut lines: Vec<Line> = logo.lines;
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(FULL_NAME.to_uppercase(), bold(TEXT))));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(format!("v{}", engine_version()), fg(TEXT2))));
        lines.push(Line::default());
        lines.push(activity(&label, self.finished.is_none(), ui.motion, ui.started));
        lines.push(Line::from(Span::styled(self.detail.clone(), fg(TEXT2))));
        lines.push(Line::default());
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(format!("{copyright}{}{LICENSE_SPDX}", if ui.unicode { " • " } else { " - " }), fg(MUTED))));
        let height = lines.len() as u16;
        let y = area.y + area.height.saturating_sub(height) / 2;
        let _ = CYAN;
        frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), Rect { y, height: height.min(area.height), ..content });
    }
    fn key(&mut self, _event: KeyEvent, _ui: &mut Ui) -> Action {
        Action::None
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        while let Ok((items, done)) = self.updates.try_recv() {
            if let Some(changed) = items.iter().find(|c| !matches!(c.outcome.state, State::Pending)) {
                let last = items.iter().filter(|c| !matches!(c.outcome.state, State::Pending)).last().unwrap_or(changed);
                self.detail = format!("{}: {}", last.name, last.outcome.state.marker().2);
            }
            self.items = items;
            if done {
                self.finished = Some(Instant::now());
                ui.checks = Some(self.items.clone());
                self.detail = if environment::blocking(&self.items).is_empty() { "Opening dashboard".into() } else { "Opening check results".into() };
            }
        }
        // The reading time overlaps the real checks; nothing waits once both are done.
        if self.finished.is_some() && self.started.elapsed() >= MINIMUM {
            if !environment::blocking(&self.items).is_empty() {
                return Action::Replace(Box::new(super::environment::EnvironmentScreen::new(Some(self.items.clone()), &self.initial)));
            }
            let initial = self.initial.clone();
            return super::after_environment(&initial, ui);
        }
        Action::None
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        Action::None
    }
}
