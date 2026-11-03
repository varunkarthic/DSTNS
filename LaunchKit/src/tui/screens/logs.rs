// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Logs: the server's system log and its SQLite journal.

use crate::tui::theme::{bold, fg, CYAN, ERR, TEXT, TEXT2, WARN};
use crate::tui::widgets::{self, card, item, key, Key, Menu, MenuEvent};
use crate::tui::{Action, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

pub struct LogsScreen {
    menu: Menu,
    lines: Vec<Line<'static>>,
    title: String,
    scroll: usize,
    in_view: bool,
}

impl LogsScreen {
    pub fn new(ui: &Ui) -> Self {
        let mut screen = Self { menu: Menu::new(crate::logs::sources().into_iter().map(|(k, l)| item(k, l)).collect()), lines: vec![], title: String::new(), scroll: 0, in_view: false };
        screen.load(ui);
        screen
    }
    fn load(&mut self, ui: &Ui) {
        let Some(source) = self.menu.current_key() else { return };
        let label = crate::logs::sources().into_iter().find(|(k, _)| *k == source).map(|(_, l)| l).unwrap_or("");
        self.scroll = 0;
        if source == "system" {
            self.title = format!("{}  ·  logs/system.log", label.to_uppercase());
            self.lines = match crate::logs::system_tail(500, &ui.paths) {
                None => vec![Line::from(Span::styled("No system log yet. It is created when the server first starts.", fg(TEXT2)))],
                Some(lines) => lines.into_iter().map(|l| Line::from(Span::styled(l.clone(), fg(if l.contains("[ERROR]") { ERR } else if l.contains("[WARN") { WARN } else { TEXT })))).collect(),
            };
        } else {
            self.title = format!("{}  ·  logs/runtime.db", label.to_uppercase());
            self.lines = match crate::logs::journal(&source, 200, &ui.paths) {
                None => vec![Line::from(Span::styled("No runtime database yet. It is created when the server first starts.", fg(TEXT2)))],
                Some(table) if table.rows.is_empty() => vec![Line::from(Span::styled("No records yet.", fg(TEXT2)))],
                Some(table) => {
                    let widths: Vec<usize> = (0..table.columns.len())
                        .map(|i| table.rows.iter().map(|r| widgets::width(&r[i])).chain(std::iter::once(table.columns[i].len())).max().unwrap_or(0).min(48))
                        .collect();
                    let format = |cells: &[String]| cells.iter().zip(&widths).map(|(c, w)| crate::output::pad(&widgets::clip(c, *w, true), *w)).collect::<Vec<_>>().join("  ");
                    std::iter::once(Line::from(Span::styled(format(&table.columns), bold(CYAN)))).chain(table.rows.iter().map(|r| Line::from(Span::styled(format(r), fg(TEXT))))).collect()
                }
            };
        }
    }
}

impl Screen for LogsScreen {
    fn title(&self) -> String {
        "Logs".into()
    }
    fn path(&self) -> String {
        format!("/logs/{}", self.menu.current_key().unwrap_or_default())
    }
    fn keys(&self, ui: &Ui) -> Vec<Key> {
        vec![key(if ui.unicode { "↑↓" } else { "Up/Down" }, "Source", "Source", false), key("r", "Refresh", "Refresh", true), key("PgUp/PgDn", "Scroll", "Scroll", false), key("Esc", "Back", "Back", true)]
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let (side, content) = widgets::columns(area, 30, ui.small(), 5);
        let block = card("Sources", !self.in_view);
        let inner = block.inner(side);
        frame.render_widget(block, side);
        self.menu.render(frame, Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner }, !self.in_view, ui.unicode);
        let block = card("", self.in_view);
        let inner = block.inner(content);
        frame.render_widget(block, content);
        let inner = Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner };
        frame.render_widget(Paragraph::new(Line::from(Span::styled(self.title.clone(), bold(TEXT)))), Rect { height: 1, ..inner });
        let view = Rect { y: inner.y + 2, height: inner.height.saturating_sub(2), ..inner };
        let total = self.lines.len();
        let visible = view.height as usize;
        let end = total.saturating_sub(self.scroll.min(total.saturating_sub(visible)));
        let start = end.saturating_sub(visible);
        frame.render_widget(Paragraph::new(self.lines[start..end].to_vec()), view);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        match event.code {
            KeyCode::Char('r') => self.load(ui),
            KeyCode::PageUp => self.scroll += 10,
            KeyCode::PageDown => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::Up | KeyCode::Char('k') if self.in_view => self.scroll += 1,
            KeyCode::Down | KeyCode::Char('j') if self.in_view => self.scroll = self.scroll.saturating_sub(1),
            _ => match self.menu.handle(&event) {
                MenuEvent::Moved => self.load(ui),
                MenuEvent::Selected(_) => self.in_view = true,
                MenuEvent::None => {}
            },
        }
        Action::None
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        if self.in_view {
            self.in_view = false;
            return Action::None;
        }
        Action::Pop
    }
}
