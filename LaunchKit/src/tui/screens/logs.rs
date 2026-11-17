// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Logs: the server's system log and its SQLite journal.

use crate::tui::theme::{bold, fg, ACCENT, ERR, MUTED, TEXT, TEXT2, WARN};
use crate::tui::widgets::{self, card, item, key, Key, Menu, MenuEvent};
use crate::tui::{Action, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
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
    /// Only the lines with this in them; `filtering` while it is being typed.
    filter: String,
    filtering: bool,
}

impl LogsScreen {
    pub fn new(ui: &Ui) -> Self {
        let mut screen = Self { menu: Menu::new(crate::logs::sources().into_iter().map(|(k, l)| item(k, l)).collect()), lines: vec![], title: String::new(), scroll: 0, in_view: false, filter: String::new(), filtering: false };
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
                None => widgets::wrap("No system log yet. It is created when the server first starts.", 48).into_iter().map(|l| Line::from(Span::styled(l, fg(TEXT2)))).collect(),
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
                    std::iter::once(Line::from(Span::styled(format(&table.columns), bold(ACCENT)))).chain(table.rows.iter().map(|r| Line::from(Span::styled(format(r), fg(TEXT))))).collect()
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
        if self.filtering {
            return vec![key("Type", "Filter", "Filter", true), key("Enter", "Keep it", "Keep", true), key("Esc", "Clear", "Clear", true)];
        }
        vec![key(if ui.unicode { "↑↓" } else { "Up/Down" }, "Source", "Source", false), key("Ctrl+F", "Filter", "Filter", true), key("r", "Refresh", "Refresh", true), key("PgUp/PgDn", "Scroll", "Scroll", false), key("Esc", "Back", "Back", true)]
    }
    fn typing(&self) -> bool {
        self.filtering
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let (side, content) = widgets::columns(area, widgets::list_width(&self.menu, area, ui.layout == crate::terminal::Layout::Medium), ui.small(), 5);
        let block = card("Sources", !self.in_view);
        let inner = block.inner(side);
        frame.render_widget(block, side);
        self.menu.render(frame, inner, !self.in_view, ui.unicode);
        let (name, source) = self.title.split_once("  ·  ").unwrap_or((&self.title, ""));
        let block = card(name, self.in_view);
        let inner = block.inner(content);
        frame.render_widget(block, content);
        let inner = Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner };
        let needle = self.filter.to_lowercase();
        let shown: Vec<Line<'static>> = if needle.is_empty() { self.lines.clone() } else { self.lines.iter().filter(|l| l.to_string().to_lowercase().contains(&needle)).cloned().collect() };
        // Where the log is kept; or, while filtering, the filter as a search box.
        let top = if self.filtering || !self.filter.is_empty() {
            Line::from(vec![
                Span::styled(if ui.unicode { "⌕ " } else { "/ " }, fg(ACCENT)),
                Span::styled(self.filter.clone(), bold(TEXT)),
                Span::styled(if self.filtering { " " } else { "" }, ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED)),
                Span::styled(format!("   {} of {} lines", shown.len(), self.lines.len()), fg(MUTED)),
            ])
        } else {
            Line::from(Span::styled(source.to_string(), fg(MUTED)))
        };
        frame.render_widget(Paragraph::new(top), Rect { height: 1, ..inner });
        let view = Rect { y: inner.y + 2, height: inner.height.saturating_sub(2), ..inner };
        let total = shown.len();
        let visible = view.height as usize;
        let end = total.saturating_sub(self.scroll.min(total.saturating_sub(visible)));
        let start = end.saturating_sub(visible);
        let mut text = Paragraph::new(shown[start..end].to_vec());
        // A single line is a message about the log, not the log: wrapped, never cut.
        if total == 1 {
            text = text.wrap(ratatui::widgets::Wrap { trim: true });
        }
        frame.render_widget(text, view);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        if event.modifiers.contains(KeyModifiers::CONTROL) && event.code == KeyCode::Char('f') {
            self.filtering = true;
            return Action::None;
        }
        if self.filtering {
            match event.code {
                KeyCode::Enter => self.filtering = false,
                KeyCode::Backspace => {
                    self.filter.pop();
                }
                KeyCode::Char(c) if !event.modifiers.contains(KeyModifiers::CONTROL) => self.filter.push(c),
                _ => {}
            }
            self.scroll = 0;
            return Action::None;
        }
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
        if self.filtering || !self.filter.is_empty() {
            self.filtering = false;
            self.filter.clear();
            return Action::None;
        }
        if self.in_view {
            self.in_view = false;
            return Action::None;
        }
        Action::Pop
    }
}
