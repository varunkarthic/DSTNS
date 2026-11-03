// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Completion: the simulated day has ended.

use crate::environment::State;
use crate::simulation::{self, Status, World};
use crate::tui::theme::{bold, fg, ACCENT, TEXT, TEXT2};
use crate::tui::widgets::{self, item, key, row, status_lines, symbol, Key, Menu, MenuEvent};
use crate::tui::{Action, Screen, Ui};
use crossterm::event::KeyEvent;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

pub struct CompletionScreen {
    world: Option<World>,
    status: Status,
    port: Option<u16>,
    menu: Menu,
}

impl CompletionScreen {
    pub fn new(world: Option<World>, status: Status, port: Option<u16>) -> Self {
        let menu = Menu::new(vec![item("observer", "Open the observer"), item("restart", "Restart the same day"), item("another", "Run another simulation"), item("menu", "Back to main menu")]);
        Self { world, status, port, menu }
    }
}

impl Screen for CompletionScreen {
    fn title(&self) -> String {
        "Simulation Completed".into()
    }
    fn path(&self) -> String {
        "/running".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Enter", "Select", "Select", true), key("Esc", "Dashboard", "Back", true)]
    }
    fn state(&self) -> Option<(State, String)> {
        Some((State::Pass, "completed".into()))
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let body = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
        let mut lines = vec![Line::from(vec![symbol(State::Pass, ui.unicode), Span::styled(" SIMULATION COMPLETED", bold(TEXT2))]), widgets::rule("", body.width, ui.unicode)];
        let mut rows = vec![];
        if let Some(world) = &self.world {
            rows.extend([
                row("Place", world.place()),
                row("Seed", world.seed.clone()),
                row("Day", world.day_name()),
                row("Road network", format!("{} junctions · {} road segments", simulation::thousands(world.nodes), simulation::thousands(world.edges))),
                row("Places", simulation::thousands(world.places)),
            ]);
        } else if !self.status.seed.is_empty() {
            rows.push(row("Seed", self.status.seed.clone()));
        }
        rows.push(row("Simulation time", "24:00:00"));
        if !self.status.run_id.is_empty() {
            rows.push(row("Run", self.status.run_id.clone()));
        }
        if let Some(port) = self.port {
            rows.push(row("Observer", format!("http://127.0.0.1:{port}/")));
        }
        lines.extend(status_lines(&rows, 18, body.width, ui.unicode));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("The observer holds the full report: choose Save Report there for the PDF.", fg(TEXT2))));
        lines.push(Line::default());
        let height = lines.len() as u16;
        frame.render_widget(Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }), body);
        self.menu.render(frame, Rect { y: body.y + height, height: body.height.saturating_sub(height), ..body }, true, ui.unicode);
        let _ = (ACCENT, TEXT);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        let MenuEvent::Selected(choice) = self.menu.handle(&event) else { return Action::None };
        match choice.as_str() {
            "observer" => {
                if let Some(port) = self.port {
                    std::thread::spawn(move || simulation::open_in_browser(&format!("http://127.0.0.1:{port}/")));
                }
                Action::Toast("Opening the observer".into(), ACCENT)
            }
            "restart" => match self.port.map(|p| simulation::control(p, "restart", &ui.paths)) {
                Some(Ok(_)) => Action::Replace(Box::new(super::running::RunningScreen::new(None))),
                Some(Err(error)) => Action::Toast(error.message, crate::tui::theme::ERR),
                None => Action::None,
            },
            "another" => Action::Replace(Box::new(super::start::StartScreen::new(ui))),
            _ => Action::Pop,
        }
    }
}
