// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The few widgets the launcher is built from. Every one renders its meaning in text: the selected menu item carries
//! `>`, a status carries a symbol and a word, the focused form field carries a marker. Colour only reinforces what is
//! already readable in monochrome.

use super::theme::{self, bold, c, fg, BG, CYAN, ERR, KEYCAP, MUTED, NAVY, TEAL, TEXT, TEXT2};
use crate::environment::State;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};
use ratatui::Frame;
use std::time::Instant;
use unicode_width::UnicodeWidthStr;

pub const LOGO: &str = include_str!("../../assets/logo.txt");
pub const SMALL_LOGO: &str = include_str!("../../assets/logo-small.txt");

pub fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// The text cut to `max` cells, with an ellipsis if anything was cut.
pub fn clip(text: &str, max: usize, unicode: bool) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars() {
        if width(&out) + 2 > max {
            break;
        }
        out.push(ch);
    }
    out.push_str(if unicode { "…" } else { "." });
    out
}

pub fn mark(state: State, unicode: bool) -> Span<'static> {
    let (fancy, plain, word) = state.marker();
    Span::styled(format!("{} {word}", if unicode { fancy } else { plain }), fg(theme::tone(state)))
}

pub fn symbol(state: State, unicode: bool) -> Span<'static> {
    let (fancy, plain, _) = state.marker();
    Span::styled((if unicode { fancy } else { plain }).to_string(), fg(theme::tone(state)))
}

/// One rounded card for one thing.
pub fn card(title: &str, focused: bool) -> Block<'static> {
    let mut block = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(if focused { TEAL } else { NAVY }));
    if !title.is_empty() {
        block = block.title(Span::styled(format!(" {title} "), if focused { fg(CYAN) } else { fg(TEXT2) }));
    }
    block
}

/// The wordmark, or plain "D S T N S" where it would not fit.
pub fn wordmark(area: Rect, unicode: bool) -> Text<'static> {
    let fits = |logo: &str| area.width as usize >= logo.lines().map(width).max().unwrap_or(0);
    let pick = if unicode && fits(LOGO) && area.height >= 7 {
        Some(LOGO)
    } else if unicode && fits(SMALL_LOGO) && area.height >= 5 {
        Some(SMALL_LOGO)
    } else {
        None
    };
    match pick {
        Some(logo) => Text::from(logo.trim_end_matches('\n').lines().map(|l| Line::from(Span::styled(l.to_string(), fg(CYAN)))).collect::<Vec<_>>()),
        None => Text::from(Line::from(Span::styled("D S T N S", bold(CYAN)))),
    }
}

/// "DSTNS 2.2.0 · Screen" on the left, a state marker and word on the right.
pub fn header(frame: &mut Frame, area: Rect, title: &str, state: Option<(State, String)>, unicode: bool, small: bool) {
    let inner_width = if small { area.width as usize } else { area.width.saturating_sub(4) as usize };
    let mut left = vec![Span::styled("DSTNS", bold(CYAN)), Span::styled(format!(" {}", crate::version::engine_version()), fg(TEXT2))];
    if !title.is_empty() && area.width >= 50 {
        left.push(Span::styled(if unicode { "  ·  " } else { "  -  " }, fg(MUTED)));
        left.push(Span::styled(title.to_string(), fg(TEXT)));
    }
    let mut right = vec![];
    if let Some((state, word)) = &state {
        right.push(symbol(*state, unicode));
        right.push(Span::styled(format!(" {}", word.to_uppercase()), fg(theme::tone(*state))));
    }
    let left_width: usize = left.iter().map(|s| width(&s.content)).sum();
    let right_width: usize = right.iter().map(|s| width(&s.content)).sum();
    let gap = inner_width.saturating_sub(left_width + right_width).max(1);
    let mut spans = left;
    spans.push(Span::raw(" ".repeat(gap)));
    spans.extend(right);
    let line = Line::from(spans);
    if small {
        frame.render_widget(Paragraph::new(line).style(theme::base()), area);
    } else {
        let boxed = Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area };
        frame.render_widget(Paragraph::new(line).block(card("", false).padding(ratatui::widgets::Padding::horizontal(1))).style(theme::base()), boxed);
    }
}

#[derive(Clone, Debug)]
pub struct Key {
    pub key: String,
    pub label: String,
    pub short: String,
    pub essential: bool,
}

pub fn key(key: &str, label: &str, short: &str, essential: bool) -> Key {
    Key { key: key.into(), label: label.into(), short: short.into(), essential }
}

/// Shortcuts for the current screen, shortened to fit the terminal. A key looks like a key.
pub fn keybar(frame: &mut Frame, area: Rect, keys: &[Key]) {
    let available = area.width.saturating_sub(4) as usize;
    let variants: [Vec<(Key, String)>; 4] = [
        keys.iter().map(|k| (k.clone(), k.label.clone())).collect(),
        keys.iter().map(|k| (k.clone(), if k.short.is_empty() { k.label.clone() } else { k.short.clone() })).collect(),
        keys.iter().filter(|k| k.essential).map(|k| (k.clone(), if k.short.is_empty() { k.label.clone() } else { k.short.clone() })).collect(),
        keys.iter().filter(|k| k.essential).map(|k| (k.clone(), String::new())).collect(),
    ];
    let keycap = if theme::colourless() { Style::default().add_modifier(Modifier::REVERSED) } else { Style::default().fg(c(TEXT)).bg(c(KEYCAP)) };
    for (n, variant) in variants.iter().enumerate() {
        let mut spans = vec![];
        let mut used = 0;
        for (k, label) in variant {
            if !spans.is_empty() {
                spans.push(Span::raw("  "));
                used += 2;
            }
            spans.push(Span::styled(format!(" {} ", k.key), keycap));
            used += width(&k.key) + 2;
            if !label.is_empty() {
                spans.push(Span::styled(format!(" {label}"), fg(TEXT2)));
                used += width(label) + 1;
            }
        }
        if used <= available || n == 3 {
            let inner = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
            frame.render_widget(Paragraph::new(Line::from(spans)).style(theme::base()), inner);
            return;
        }
    }
}

/// A thin horizontal separator, optionally titled.
pub fn rule(title: &str, area_width: u16, unicode: bool) -> Line<'static> {
    let ch = if unicode { "─" } else { "-" };
    let w = area_width.max(1) as usize;
    if title.is_empty() {
        return Line::from(Span::styled(ch.repeat(w), fg(NAVY)));
    }
    let label = format!(" {title} ");
    let left = ((w.saturating_sub(width(&label))) / 2).max(2);
    let right = w.saturating_sub(left + width(&label));
    Line::from(vec![Span::styled(ch.repeat(left), fg(NAVY)), Span::styled(label, fg(TEXT2)), Span::styled(ch.repeat(right), fg(NAVY))])
}

#[derive(Clone, Debug)]
pub struct MenuItem {
    pub key: String,
    pub label: String,
    pub hint: String,
    pub disabled: bool,
}

pub fn item(key: &str, label: &str) -> MenuItem {
    MenuItem { key: key.into(), label: label.into(), hint: String::new(), disabled: false }
}

pub enum MenuEvent {
    None,
    Moved,
    Selected(String),
}

/// A vertical list with a `>` marker on the selected item. Arrow keys, j/k, Home and End move; Enter activates.
#[derive(Clone, Debug, Default)]
pub struct Menu {
    pub items: Vec<MenuItem>,
    pub index: usize,
    pub show_hints: bool,
    pub offset: usize,
}

impl Menu {
    pub fn new(items: Vec<MenuItem>) -> Self {
        Self { items, index: 0, show_hints: false, offset: 0 }
    }
    pub fn current(&self) -> Option<&MenuItem> {
        self.items.get(self.index)
    }
    pub fn current_key(&self) -> Option<String> {
        self.current().map(|i| i.key.clone())
    }
    pub fn set_items(&mut self, items: Vec<MenuItem>) {
        let keep = self.current_key();
        self.items = items;
        self.index = keep.and_then(|k| self.items.iter().position(|i| i.key == k)).unwrap_or_else(|| self.index.min(self.items.len().saturating_sub(1)));
    }
    pub fn select(&mut self, key: &str) {
        if let Some(position) = self.items.iter().position(|i| i.key == key) {
            self.index = position;
        }
    }
    fn step(&mut self, delta: i32) {
        if self.items.is_empty() {
            return;
        }
        let mut position = self.index as i32;
        for _ in 0..self.items.len() {
            position = (position + delta).clamp(0, self.items.len() as i32 - 1);
            if !self.items[position as usize].disabled || position == 0 || position == self.items.len() as i32 - 1 {
                break;
            }
        }
        self.index = position as usize;
    }
    pub fn handle(&mut self, event: &KeyEvent) -> MenuEvent {
        let before = self.index;
        match event.code {
            KeyCode::Up | KeyCode::Char('k') => self.step(-1),
            KeyCode::Down | KeyCode::Char('j') => self.step(1),
            KeyCode::Home => self.index = 0,
            KeyCode::End => self.index = self.items.len().saturating_sub(1),
            KeyCode::PageUp => self.step(-10),
            KeyCode::PageDown => self.step(10),
            KeyCode::Enter => {
                if let Some(current) = self.current().filter(|i| !i.disabled) {
                    return MenuEvent::Selected(current.key.clone());
                }
            }
            _ => return MenuEvent::None,
        }
        if self.index != before {
            MenuEvent::Moved
        } else {
            MenuEvent::None
        }
    }
    /// A click on a row of the area it was drawn in: select that item, and activate it.
    pub fn click(&mut self, row: u16) -> MenuEvent {
        let mut position = 0u16;
        for (index, item) in self.items.iter().enumerate().skip(self.offset) {
            let height = if self.show_hints && !item.hint.is_empty() { 2 } else { 1 };
            if row >= position && row < position + height {
                self.index = index;
                return match self.current().filter(|i| !i.disabled) {
                    Some(item) => MenuEvent::Selected(item.key.clone()),
                    None => MenuEvent::Moved,
                };
            }
            position += height;
        }
        MenuEvent::None
    }
    pub fn render(&mut self, frame: &mut Frame, area: Rect, focused: bool, unicode: bool) {
        let w = area.width.max(4) as usize;
        let rows = area.height as usize;
        if self.index < self.offset {
            self.offset = self.index;
        }
        if rows > 0 && self.index >= self.offset + rows {
            self.offset = self.index + 1 - rows;
        }
        let mut lines = vec![];
        for (position, item) in self.items.iter().enumerate().skip(self.offset) {
            let chosen = position == self.index;
            let label = clip(&item.label, w.saturating_sub(2), unicode);
            let text = format!("{}{label}", if chosen { "> " } else { "  " });
            let padded = format!("{text}{}", " ".repeat(w.saturating_sub(width(&text))));
            let style = if item.disabled {
                fg(MUTED)
            } else if chosen {
                theme::selected(focused)
            } else {
                fg(TEXT)
            };
            lines.push(Line::from(Span::styled(padded, style)));
            if self.show_hints && !item.hint.is_empty() {
                lines.push(Line::from(Span::styled(clip(&format!("    {}", item.hint), w, unicode), fg(MUTED))));
            }
        }
        frame.render_widget(Paragraph::new(lines), area);
    }
}

/// One line of a status table: name, value, state, and optional detail.
#[derive(Clone, Debug, Default)]
pub struct Row {
    pub name: String,
    pub value: String,
    pub state: Option<State>,
    pub detail: String,
}

pub fn row(name: &str, value: impl Into<String>) -> Row {
    Row { name: name.into(), value: value.into(), state: None, detail: String::new() }
}

pub fn row_state(name: &str, value: impl Into<String>, state: State) -> Row {
    Row { name: name.into(), value: value.into(), state: Some(state), detail: String::new() }
}

/// Aligned rows: name, value, marker. Columns never push past the area's width.
pub fn status_lines(rows: &[Row], name_width: usize, area_width: u16, unicode: bool) -> Vec<Line<'static>> {
    let w = area_width.max(20) as usize;
    let narrow = w < 56;
    let name_w = name_width.min((w / 3).max(10));
    let mark_w = if narrow { 0 } else { 12 };
    let value_w = w.saturating_sub(name_w + 2 + if narrow { 0 } else { mark_w + 2 });
    let mut lines = vec![];
    for r in rows {
        let name = clip(&r.name, name_w, unicode);
        let mut spans = vec![Span::styled(format!("{name}{}", " ".repeat(name_w.saturating_sub(width(&name)) + 2)), fg(TEXT2))];
        let mut value_text = r.value.clone();
        if narrow {
            if let Some(state) = r.state {
                spans.push(symbol(state, unicode));
                spans.push(Span::raw(" "));
                value_text = clip(&value_text, value_w.saturating_sub(2), unicode);
            }
        } else {
            value_text = clip(&value_text, value_w, unicode);
        }
        let value_cells = width(&value_text);
        spans.push(Span::styled(value_text, fg(TEXT)));
        if !narrow {
            spans.push(Span::raw(" ".repeat(value_w.saturating_sub(value_cells) + 2)));
            if let Some(state) = r.state {
                spans.push(mark(state, unicode));
            }
        }
        lines.push(Line::from(spans));
        if !r.detail.is_empty() {
            for piece in wrap(&r.detail, value_w.max(10)) {
                lines.push(Line::from(vec![Span::raw(" ".repeat(name_w + 2)), Span::styled(piece, fg(MUTED))]));
            }
        }
    }
    lines
}

/// Plain words wrapped at `max` cells.
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let mut out = vec![];
    for paragraph in text.lines() {
        let mut line = String::new();
        for word in paragraph.split_whitespace() {
            if !line.is_empty() && width(&line) + 1 + width(word) > max {
                out.push(std::mem::take(&mut line));
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
        }
        out.push(line);
    }
    out
}

/// Bounded-rate activity: never a simulated percentage. Every frame carries the work's label, and reduced motion keeps
/// a still, textual status.
pub fn activity(label: &str, busy: bool, motion: bool, started: Instant) -> Line<'static> {
    const FRAMES: [&str; 6] = ["[=   ]", "[ =  ]", "[  = ]", "[   =]", "[  = ]", "[ =  ]"];
    if label.is_empty() {
        return Line::default();
    }
    let prefix = if !busy {
        String::new()
    } else if motion {
        format!("{} ", FRAMES[(started.elapsed().as_millis() / 250) as usize % FRAMES.len()])
    } else {
        "[working] ".into()
    };
    Line::from(Span::styled(format!("{prefix}{label}"), fg(CYAN)))
}

// --- Forms ------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum Editor {
    Text { value: String, cursor: usize, placeholder: String, numeric: bool, disabled: bool, multiline: bool },
    Toggle(bool),
    Select { choices: Vec<(String, String)>, index: usize },
}

impl Editor {
    pub fn text(value: &str, placeholder: &str) -> Self {
        Editor::Text { value: value.into(), cursor: value.chars().count(), placeholder: placeholder.into(), numeric: false, disabled: false, multiline: false }
    }
    pub fn number(value: &str) -> Self {
        Editor::Text { value: value.into(), cursor: value.chars().count(), placeholder: String::new(), numeric: true, disabled: false, multiline: false }
    }
    pub fn lines(value: &str) -> Self {
        Editor::Text { value: value.into(), cursor: value.chars().count(), placeholder: String::new(), numeric: false, disabled: false, multiline: true }
    }
    pub fn select(choices: Vec<(String, String)>, value: &str) -> Self {
        let index = choices.iter().position(|(_, v)| v == value).unwrap_or(0);
        Editor::Select { choices, index }
    }
    pub fn text_value(&self) -> String {
        match self {
            Editor::Text { value, .. } => value.clone(),
            Editor::Toggle(on) => on.to_string(),
            Editor::Select { choices, index } => choices.get(*index).map(|(_, v)| v.clone()).unwrap_or_default(),
        }
    }
    pub fn toggled(&self) -> bool {
        matches!(self, Editor::Toggle(true))
    }
    pub fn height(&self) -> u16 {
        match self {
            Editor::Text { multiline: true, .. } => 6,
            _ => 3,
        }
    }
    /// Returns whether the value changed.
    pub fn handle(&mut self, event: &KeyEvent) -> bool {
        match self {
            Editor::Text { value, cursor, numeric, disabled, multiline, .. } => {
                if *disabled {
                    return false;
                }
                let chars: Vec<char> = value.chars().collect();
                match event.code {
                    KeyCode::Char(ch) if !event.modifiers.contains(KeyModifiers::CONTROL) => {
                        if *numeric && !(ch.is_ascii_digit() || ch == '.' || ch == '-') {
                            return false;
                        }
                        let mut next = chars.clone();
                        next.insert(*cursor, ch);
                        *value = next.into_iter().collect();
                        *cursor += 1;
                        true
                    }
                    KeyCode::Enter if *multiline => {
                        let mut next = chars.clone();
                        next.insert(*cursor, '\n');
                        *value = next.into_iter().collect();
                        *cursor += 1;
                        true
                    }
                    KeyCode::Backspace if *cursor > 0 => {
                        let mut next = chars.clone();
                        next.remove(*cursor - 1);
                        *value = next.into_iter().collect();
                        *cursor -= 1;
                        true
                    }
                    KeyCode::Delete if *cursor < chars.len() => {
                        let mut next = chars.clone();
                        next.remove(*cursor);
                        *value = next.into_iter().collect();
                        true
                    }
                    KeyCode::Left => {
                        *cursor = cursor.saturating_sub(1);
                        false
                    }
                    KeyCode::Right => {
                        *cursor = (*cursor + 1).min(chars.len());
                        false
                    }
                    KeyCode::Home => {
                        *cursor = 0;
                        false
                    }
                    KeyCode::End => {
                        *cursor = chars.len();
                        false
                    }
                    _ => false,
                }
            }
            Editor::Toggle(on) => match event.code {
                KeyCode::Char(' ') | KeyCode::Enter | KeyCode::Left | KeyCode::Right => {
                    *on = !*on;
                    true
                }
                _ => false,
            },
            Editor::Select { choices, index } => match event.code {
                KeyCode::Left | KeyCode::Char('h') => {
                    *index = (*index + choices.len() - 1) % choices.len().max(1);
                    true
                }
                KeyCode::Right | KeyCode::Char('l') | KeyCode::Char(' ') | KeyCode::Enter => {
                    *index = (*index + 1) % choices.len().max(1);
                    true
                }
                _ => false,
            },
        }
    }
    pub fn render(&self, frame: &mut Frame, area: Rect, focused: bool, invalid: bool, unicode: bool) {
        let border = if invalid { ERR } else if focused { CYAN } else { NAVY };
        let block = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(border));
        let inner_width = area.width.saturating_sub(2) as usize;
        let content: Vec<Line> = match self {
            Editor::Text { value, cursor, placeholder, disabled, multiline, .. } => {
                if value.is_empty() && !focused {
                    vec![Line::from(Span::styled(placeholder.clone(), fg(MUTED)))]
                } else if *multiline {
                    value.split('\n').map(|l| Line::from(Span::styled(l.to_string(), fg(TEXT)))).collect()
                } else {
                    let chars: Vec<char> = value.chars().collect();
                    let start = cursor.saturating_sub(inner_width.saturating_sub(1));
                    let shown: String = chars[start.min(chars.len())..].iter().take(inner_width).collect();
                    if focused && !disabled {
                        let at = cursor - start;
                        let before: String = shown.chars().take(at).collect();
                        let under: String = shown.chars().nth(at).map(String::from).unwrap_or_else(|| " ".into());
                        let after: String = shown.chars().skip(at + 1).collect();
                        vec![Line::from(vec![Span::styled(before, fg(TEXT)), Span::styled(under, Style::default().add_modifier(Modifier::REVERSED)), Span::styled(after, fg(TEXT))])]
                    } else {
                        vec![Line::from(Span::styled(shown, fg(if *disabled { MUTED } else { TEXT })))]
                    }
                }
            }
            Editor::Toggle(on) => {
                let (knob, word) = if *on { (if unicode { "━━●" } else { "--o" }, "on") } else { (if unicode { "●━━" } else { "o--" }, "off") };
                vec![Line::from(vec![Span::styled(knob.to_string(), fg(if *on { CYAN } else { MUTED })), Span::styled(format!(" {word}"), fg(TEXT))])]
            }
            Editor::Select { choices, index } => {
                let label = choices.get(*index).map(|(l, _)| l.clone()).unwrap_or_default();
                let arrows = if unicode { ("‹ ", " ›") } else { ("< ", " >") };
                vec![Line::from(vec![Span::styled(arrows.0, fg(MUTED)), Span::styled(label, fg(TEXT)), Span::styled(arrows.1, fg(MUTED))])]
            }
        };
        frame.render_widget(Paragraph::new(content).block(block).style(Style::default().bg(c(BG))), area);
    }
}

pub struct FormRow {
    pub key: String,
    pub label: String,
    pub editor: Editor,
    pub unit: String,
    pub problem: String,
    pub hint: String,
    pub visible: bool,
}

pub fn form_row(key: &str, label: &str, editor: Editor) -> FormRow {
    FormRow { key: key.into(), label: label.into(), editor, unit: String::new(), problem: String::new(), hint: String::new(), visible: true }
}

/// Labelled fields, one under another; Tab and Shift+Tab move between them.
#[derive(Default)]
pub struct Form {
    pub rows: Vec<FormRow>,
    pub focus: usize,
    pub scroll: u16,
}

impl Form {
    pub fn get(&self, key: &str) -> Option<&FormRow> {
        self.rows.iter().find(|r| r.key == key)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut FormRow> {
        self.rows.iter_mut().find(|r| r.key == key)
    }
    pub fn value(&self, key: &str) -> String {
        self.get(key).map(|r| r.editor.text_value()).unwrap_or_default()
    }
    pub fn set_problem(&mut self, key: &str, problem: &str) {
        if let Some(row) = self.get_mut(key) {
            row.problem = problem.into();
        }
    }
    pub fn clear_problems(&mut self) {
        for row in &mut self.rows {
            row.problem.clear();
        }
    }
    pub fn move_focus(&mut self, delta: i32) -> bool {
        let visible: Vec<usize> = (0..self.rows.len()).filter(|i| self.rows[*i].visible).collect();
        let Some(position) = visible.iter().position(|i| *i == self.focus) else {
            if let Some(first) = visible.first() {
                self.focus = *first;
            }
            return true;
        };
        let next = position as i32 + delta;
        if next < 0 || next >= visible.len() as i32 {
            return false;
        }
        self.focus = visible[next as usize];
        true
    }
    pub fn focused(&self) -> Option<&FormRow> {
        self.rows.get(self.focus)
    }
    /// Returns the key of a field whose value changed.
    pub fn handle(&mut self, event: &KeyEvent) -> Option<String> {
        let row = self.rows.get_mut(self.focus)?;
        row.editor.handle(event).then(|| row.key.clone())
    }
    fn row_height(&self, row: &FormRow, area_width: u16, label_width: u16) -> u16 {
        let stacked = area_width < 60;
        let hint = if row.hint.is_empty() { 0 } else { wrap(&row.hint, area_width.saturating_sub(if stacked { 2 } else { label_width }) as usize).len() as u16 };
        (if stacked { 1 } else { 0 }) + row.editor.height() + (if row.problem.is_empty() { 0 } else { 1 }) + hint
    }
    /// Draws the fields into `area`, scrolled so that the focused one is in view; `active` says whether the form has
    /// the keyboard.
    pub fn render(&mut self, frame: &mut Frame, area: Rect, active: bool, unicode: bool, label_width: u16) {
        let stacked = area.width < 60;
        // Keep the focused field in view.
        let mut top = 0u16;
        for (index, row) in self.rows.iter().enumerate().filter(|(_, r)| r.visible) {
            let h = self.row_height(row, area.width, label_width);
            if index == self.focus {
                if top < self.scroll {
                    self.scroll = top;
                } else if top + h > self.scroll + area.height {
                    self.scroll = (top + h).saturating_sub(area.height);
                }
            }
            top += h;
        }
        let mut y = area.y as i32 - self.scroll as i32;
        for (index, row) in self.rows.iter().enumerate().filter(|(_, r)| r.visible) {
            let h = self.row_height(row, area.width, label_width) as i32;
            if y + h <= area.y as i32 || y >= (area.y + area.height) as i32 {
                y += h;
                continue;
            }
            let focused = active && index == self.focus;
            let label_style = if focused { bold(CYAN) } else { fg(TEXT2) };
            let label_text = format!("{}{}", if focused { "> " } else { "  " }, row.label);
            let visible_rect = |ry: i32, rh: u16| -> Option<Rect> {
                let top = ry.max(area.y as i32);
                let bottom = (ry + rh as i32).min((area.y + area.height) as i32);
                (bottom > top).then(|| Rect { x: area.x, y: top as u16, width: area.width, height: (bottom - top) as u16 })
            };
            let mut line_y = y;
            let (editor_x, editor_width) = if stacked {
                if let Some(r) = visible_rect(line_y, 1) {
                    frame.render_widget(Paragraph::new(Line::from(Span::styled(label_text.clone(), label_style))), r);
                }
                line_y += 1;
                (area.x + 2, area.width.saturating_sub(2))
            } else {
                if let Some(r) = visible_rect(line_y + 1, 1) {
                    frame.render_widget(Paragraph::new(Line::from(Span::styled(clip(&label_text, label_width as usize - 1, unicode), label_style))), Rect { width: label_width, ..r });
                }
                let unit_width = if row.unit.is_empty() { 0 } else { width(&row.unit) as u16 + 2 };
                (area.x + label_width, area.width.saturating_sub(label_width + unit_width).min(60))
            };
            let editor_height = row.editor.height();
            if line_y >= area.y as i32 && line_y + editor_height as i32 <= (area.y + area.height) as i32 {
                row.editor.render(frame, Rect { x: editor_x, y: line_y as u16, width: editor_width, height: editor_height }, focused, !row.problem.is_empty(), unicode);
                if !row.unit.is_empty() && !stacked {
                    frame.render_widget(Paragraph::new(Span::styled(row.unit.clone(), fg(MUTED))), Rect { x: editor_x + editor_width + 1, y: line_y as u16 + 1, width: width(&row.unit) as u16 + 1, height: 1 });
                }
            }
            line_y += editor_height as i32;
            if !row.problem.is_empty() {
                if let Some(r) = visible_rect(line_y, 1) {
                    let cross = if unicode { "✗" } else { "x" };
                    frame.render_widget(Paragraph::new(Span::styled(format!("{cross} {}", row.problem), fg(ERR))), Rect { x: editor_x, width: area.width.saturating_sub(editor_x - area.x), ..r });
                }
                line_y += 1;
            }
            if !row.hint.is_empty() {
                let lines = wrap(&row.hint, area.width.saturating_sub(editor_x - area.x) as usize);
                for line in lines {
                    if let Some(r) = visible_rect(line_y, 1) {
                        frame.render_widget(Paragraph::new(Span::styled(line, fg(MUTED))), Rect { x: editor_x, width: area.width.saturating_sub(editor_x - area.x), ..r });
                    }
                    line_y += 1;
                }
            }
            y += h;
        }
    }
}

/// Splits an area into a sidebar and content, as the dashboard and the list screens do; stacked when small.
pub fn columns(area: Rect, sidebar: u16, small: bool, sidebar_height: u16) -> (Rect, Rect) {
    if small {
        let parts = Layout::vertical([Constraint::Length(sidebar_height.min(area.height / 2).max(3)), Constraint::Min(1)]).split(area);
        (parts[0], parts[1])
    } else {
        let parts = Layout::horizontal([Constraint::Length(sidebar + 1), Constraint::Min(10)]).split(area);
        (Rect { x: parts[0].x + 1, width: parts[0].width.saturating_sub(1), ..parts[0] }, Rect { x: parts[1].x + 1, width: parts[1].width.saturating_sub(2), ..parts[1] })
    }
}
