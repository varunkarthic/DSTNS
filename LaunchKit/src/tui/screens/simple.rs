// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Simplified Launch Control: the launcher for a terminal too small for the full interface. No command bar and no
//! panels: whether a simulation runs, start or stop it, open the observer, and the few settings that matter most, one
//! line each. Every choice is logged, as everywhere else.

use crate::config;
use crate::process::Cancel;
use crate::config::RunOptions;
use crate::tui::theme::{bold, fg, selected, ACCENT, ERR, MUTED, OK, TEXT, TEXT2};
use crate::tui::widgets::clip;
use crate::tui::{Action, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Item {
    StartStop,
    Open,
    Toggle(&'static str, &'static str),
    Day,
    Full,
    Exit,
}

pub struct SimpleScreen {
    selected: usize,
    note: (String, u32),
    starting: Option<Receiver<Result<(), String>>>,
}

impl SimpleScreen {
    pub fn new() -> Self {
        Self { selected: 0, note: ("↑ ↓ and Enter, or a number. q leaves.".into(), MUTED), starting: None }
    }

    fn running(ui: &Ui) -> Option<u16> {
        ui.session.any_port()
    }

    fn items(&self, ui: &Ui) -> Vec<Item> {
        let mut items = vec![Item::StartStop];
        if Self::running(ui).is_some() {
            items.push(Item::Open);
        }
        items.extend([
            Item::Toggle("startup.fast_boot", "Fast Boot"),
            Item::Toggle("startup.dynamic_fastboot", "Dynamic Fastboot"),
            Item::Toggle("startup.dynamic_particles", "Adaptive start-up film"),
            Item::Toggle("presentation.music", "Music"),
            Item::Day,
        ]);
        // Big enough again: the full interface can come back.
        if crate::terminal::layout_for(ui.width, ui.height) != crate::terminal::Layout::TooSmall && ui.width >= crate::terminal::MEDIUM.0 && ui.height >= crate::terminal::MEDIUM.1 {
            items.push(Item::Full);
        }
        items.push(Item::Exit);
        items
    }

    fn label(&self, item: Item, ui: &Ui) -> String {
        let settings = config::load(&ui.paths).unwrap_or_default();
        match item {
            Item::StartStop if self.starting.is_some() => "Starting…".into(),
            Item::StartStop => if Self::running(ui).is_some() { "Stop the simulation".into() } else { "Start a simulation".into() },
            Item::Open => "Open the observer".into(),
            Item::Toggle(key, label) => format!("{label}: {}", if config::flag(&settings, key) { "on" } else { "off" }),
            Item::Day => format!("Day: {}", config::setting(&settings, "day").as_str().unwrap_or("weekday")),
            Item::Full => "The full interface".into(),
            Item::Exit => "Leave".into(),
        }
    }

    fn change(&mut self, ui: &Ui, key: &str, value: serde_json::Value, label: &str) {
        let Some(field) = config::field(key) else { return };
        let mut settings = config::load(&ui.paths).unwrap_or_default();
        let also = field.set(&mut settings, value.clone());
        self.note = match config::save(&settings, &ui.paths) {
            Ok(()) => {
                crate::log::info(&format!("simplified launch control: {key} = {value}"));
                let more = also.iter().filter_map(|k| config::field(k)).map(|f| format!(", {} {}", f.label, f.display(&f.get(&settings)))).collect::<String>();
                (format!("{label} is {}{more}. From the next start.", field.display(&value)), OK)
            }
            Err(e) => (e.message, ERR),
        };
    }

    fn activate(&mut self, item: Item, ui: &mut Ui) -> Action {
        crate::log::info(&format!("simplified launch control: {}", self.label(item, ui)));
        match item {
            Item::StartStop if self.starting.is_some() => {}
            Item::StartStop => {
                if Self::running(ui).is_some() {
                    // As `./launcher stop` would: the server, and what this launcher started.
                    let _ = std::process::Command::new(std::env::current_exe().unwrap_or_default()).arg("stop").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
                    self.note = ("Stopping the simulation.".into(), TEXT2);
                } else {
                    let (tx, rx) = channel();
                    let session = ui.session.clone();
                    std::thread::spawn(move || {
                        let outcome = session.launch(&RunOptions::default(), Arc::new(crate::reporting::Quiet), false, Cancel::new());
                        let _ = tx.send(outcome.map(|_| ()).map_err(|e| e.message));
                    });
                    self.starting = Some(rx);
                    self.note = ("Starting. The first start downloads its city, up to a minute.".into(), ACCENT);
                }
            }
            Item::Open => {
                if let Some(port) = Self::running(ui) {
                    let url = format!("http://127.0.0.1:{port}/");
                    self.note = (if crate::simulation::open_in_browser(&url) { format!("Opened {url}") } else { format!("Open {url}") }, TEXT2);
                }
            }
            Item::Toggle(key, label) => {
                let on = config::flag(&config::load(&ui.paths).unwrap_or_default(), key);
                self.change(ui, key, serde_json::json!(!on), label);
            }
            Item::Day => {
                let day = config::setting(&config::load(&ui.paths).unwrap_or_default(), "day");
                self.change(ui, "day", serde_json::json!(if day == "weekend" { "weekday" } else { "weekend" }), "The day");
            }
            Item::Full => return Action::Home,
            Item::Exit => return Action::Quit,
        }
        Action::None
    }

    pub fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        let items = self.items(ui);
        match event.code {
            KeyCode::Up | KeyCode::Char('k') => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => self.selected = (self.selected + 1).min(items.len() - 1),
            KeyCode::Enter | KeyCode::Char(' ') => return self.activate(items[self.selected.min(items.len() - 1)], ui),
            KeyCode::Char(c @ '1'..='9') => {
                let index = c as usize - '1' as usize;
                if index < items.len() {
                    self.selected = index;
                    return self.activate(items[index], ui);
                }
            }
            KeyCode::Char('q') | KeyCode::Esc => return Action::Quit,
            _ => {}
        }
        Action::None
    }

    pub fn tick(&mut self, ui: &Ui) {
        if let Some(rx) = &self.starting {
            if let Ok(outcome) = rx.try_recv() {
                self.starting = None;
                self.note = match outcome {
                    Ok(()) => (format!("Running on :{}.", Self::running(ui).map(|p| p.to_string()).unwrap_or_default()), OK),
                    Err(problem) => (problem, ERR),
                };
            }
        }
    }

    pub fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let width = area.width.saturating_sub(2) as usize;
        let items = self.items(ui);
        self.selected = self.selected.min(items.len() - 1);
        let state = match Self::running(ui) {
            Some(port) => {
                let status = crate::simulation::status(port, &ui.paths);
                Line::from(vec![Span::styled(if ui.unicode { "● " } else { "* " }, fg(OK)), Span::styled(clip(&format!(":{port} {} {}", status.lifecycle.to_lowercase(), status.clock), width.saturating_sub(2), ui.unicode), fg(TEXT))])
            }
            None => Line::from(vec![Span::styled(if ui.unicode { "○ " } else { "- " }, fg(TEXT2)), Span::styled("No simulation running", fg(TEXT2))]),
        };
        let mut lines = vec![
            Line::from(vec![Span::styled("DSTNS", bold(ACCENT)), Span::styled(clip(" · Simplified Launch Control", width.saturating_sub(5), ui.unicode), fg(TEXT2))]),
            state,
            Line::default(),
        ];
        for (i, item) in items.iter().enumerate() {
            let text = clip(&format!("{} {}", i + 1, self.label(*item, ui)), width.saturating_sub(2), ui.unicode);
            lines.push(if i == self.selected { Line::from(Span::styled(format!("{}{text:<w$}", if ui.unicode { "› " } else { "> " }, w = width.saturating_sub(2)), selected(true))) } else { Line::from(Span::styled(format!("  {text}"), fg(TEXT))) });
        }
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(clip(&self.note.0, width, ui.unicode), fg(self.note.1))));
        let rect = Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area };
        frame.render_widget(Paragraph::new(lines), rect);
    }
}
