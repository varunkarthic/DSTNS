// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Configuration: edit config/defaults.json, a category at a time.

use crate::config::{self, FieldKind};
use crate::environment::State;
use crate::tui::theme::{bold, fg, ERR, MUTED, TEXT2, WARN};
use crate::tui::widgets::{self, card, form_row, item, key, Editor, Form, Key, Menu, MenuEvent};
use crate::tui::{Action, Dialog, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use serde_json::Value;
use std::collections::BTreeSet;

pub struct ConfigurationScreen {
    categories: Menu,
    form: Form,
    current: Value,
    saved: Value,
    invalid: BTreeSet<String>,
    load_error: String,
    in_form: bool,
    loaded: bool,
    wanted: Option<String>,
}

fn editor(field: &config::Field, value: &Value) -> Editor {
    match field.kind {
        FieldKind::Boolean => Editor::Toggle(value.as_bool().unwrap_or(false)),
        FieldKind::Choice => Editor::select(field.choices.iter().map(|(l, c)| (capitalise(l), c.to_string())).collect(), &value.to_string()),
        FieldKind::Integer | FieldKind::Number => Editor::number(&field.display(value)),
        FieldKind::Text => Editor::text(&field.display(value), ""),
    }
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

impl ConfigurationScreen {
    pub fn new(category: Option<String>) -> Self {
        Self {
            categories: Menu::new(config::categories().into_iter().map(|c| item(c, c)).collect()),
            form: Form::default(),
            current: Value::Null,
            saved: Value::Null,
            invalid: BTreeSet::new(),
            load_error: String::new(),
            in_form: false,
            loaded: false,
            wanted: category,
        }
    }

    fn load(&mut self, ui: &Ui) {
        self.loaded = true;
        match config::load(&ui.paths) {
            Ok(value) => {
                self.saved = value.clone();
                self.current = value;
            }
            Err(error) => {
                self.load_error = error.message;
                self.saved = serde_json::json!({});
                self.current = serde_json::json!({});
            }
        }
        if let Some(wanted) = self.wanted.take() {
            if let Some(category) = config::categories().into_iter().find(|c| c.eq_ignore_ascii_case(&wanted)) {
                self.categories.select(category);
            }
        }
        self.show_category();
    }

    fn show_category(&mut self) {
        let category = self.categories.current_key().unwrap_or_default();
        let rows = config::fields()
            .iter()
            .filter(|f| f.category == category)
            .map(|f| {
                let mut r = form_row(f.key, f.label, editor(f, &f.get(&self.current)));
                r.unit = f.unit.into();
                r.hint = f.help.into();
                r
            })
            .collect();
        self.form = Form { rows, focus: 0, scroll: 0 };
    }

    fn dirty(&self) -> bool {
        self.current != self.saved
    }

    fn apply(&mut self, key: &str) {
        let Some(field) = config::field(key) else { return };
        let Some(row) = self.form.get(key) else { return };
        let parsed = match &row.editor {
            Editor::Toggle(on) => Ok(Value::Bool(*on)),
            Editor::Select { choices, index } => {
                let text = choices.get(*index).map(|(_, v)| v.clone()).unwrap_or_default();
                Ok(field.choices.iter().find(|(_, c)| c.to_string() == text).map(|(_, c)| c.clone()).unwrap_or(Value::Null))
            }
            Editor::Text { value, .. } => field.parse(value),
        };
        let problem = match &parsed {
            Ok(value) => config::check_field(field, value, &self.current),
            Err(problem) => problem.clone(),
        };
        if problem.is_empty() {
            self.invalid.remove(key);
            self.form.set_problem(key, "");
            field.set(&mut self.current, parsed.unwrap());
        } else {
            self.invalid.insert(key.to_string());
            self.form.set_problem(key, &problem);
        }
    }

    fn save(&mut self, ui: &Ui) -> Action {
        if !self.invalid.is_empty() {
            return Action::Toast("Correct the invalid values first.".into(), ERR);
        }
        if !self.load_error.is_empty() {
            return Action::Toast("The configuration file could not be read, so it is not overwritten.".into(), ERR);
        }
        match config::save(&self.current, &ui.paths) {
            Ok(()) => {
                self.saved = self.current.clone();
                Action::Toast("Configuration saved.".into(), crate::tui::theme::OK)
            }
            Err(error) => Action::Toast(error.message, ERR),
        }
    }
}

impl Screen for ConfigurationScreen {
    fn title(&self) -> String {
        "Configuration".into()
    }
    fn path(&self) -> String {
        format!("/config/{}", self.categories.current_key().unwrap_or_default())
    }
    fn keys(&self, ui: &Ui) -> Vec<Key> {
        vec![key(if ui.unicode { "↑↓" } else { "Up/Down" }, "Categories", "Move", false), key("Tab", "Next field", "Next", true), key("Ctrl+S", "Save", "Save", true), key("Esc", "Back", "Back", true)]
    }
    fn typing(&self) -> bool {
        self.in_form && self.form.focused().map(|r| matches!(r.editor, Editor::Text { .. })).unwrap_or(false)
    }
    fn state(&self) -> Option<(State, String)> {
        Some(if !self.invalid.is_empty() {
            (State::Fail, format!("{} invalid", self.invalid.len()))
        } else if self.dirty() {
            (State::Warning, "unsaved".into())
        } else {
            (State::Pass, "saved".into())
        })
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        if !self.loaded {
            self.load(ui);
        }
        let sidebar = if ui.layout == crate::terminal::Layout::Medium { 24 } else { 30 };
        let (side, content) = widgets::columns(area, sidebar, ui.small(), 4);
        if ui.small() {
            self.categories.render(frame, side, !self.in_form, ui.unicode);
        } else {
            let block = card("Settings", !self.in_form);
            let inner = block.inner(side);
            frame.render_widget(block, side);
            self.categories.render(frame, Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner }, !self.in_form, ui.unicode);
        }
        let block = card(&self.categories.current_key().unwrap_or_default(), self.in_form);
        let inner = if ui.small() { content } else { block.inner(content) };
        if !ui.small() {
            frame.render_widget(block, content);
        }
        let inner = Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner };
        let mut header = vec![Line::from(Span::styled("config/defaults.json", fg(MUTED)))];
        if !self.load_error.is_empty() {
            header.push(Line::from(Span::styled(self.load_error.clone(), fg(ERR))));
        }
        let status = if !self.invalid.is_empty() {
            Some(Line::from(Span::styled("Correct the highlighted values before saving.", fg(ERR))))
        } else if self.dirty() {
            Some(Line::from(Span::styled("Unsaved changes. Ctrl+S saves them to config/defaults.json.", fg(WARN))))
        } else {
            None
        };
        let header_height = header.len() as u16 + 1;
        frame.render_widget(Paragraph::new(header).wrap(ratatui::widgets::Wrap { trim: false }), Rect { height: header_height, ..inner });
        let footer = if status.is_some() { 2 } else { 0 };
        let form_area = Rect { y: inner.y + header_height, height: inner.height.saturating_sub(header_height + footer), ..inner };
        self.form.render(frame, form_area, self.in_form, ui.unicode, 30);
        if let Some(status) = status {
            frame.render_widget(Paragraph::new(status), Rect { y: inner.y + inner.height.saturating_sub(1), height: 1, ..inner });
        }
        let _ = (bold(TEXT2), TEXT2);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        if event.modifiers.contains(KeyModifiers::CONTROL) && event.code == KeyCode::Char('s') {
            return self.save(ui);
        }
        if !self.in_form {
            match self.categories.handle(&event) {
                MenuEvent::Moved => self.show_category(),
                MenuEvent::Selected(_) => self.in_form = true,
                MenuEvent::None => {
                    if matches!(event.code, KeyCode::Tab | KeyCode::Right) {
                        self.in_form = true;
                    }
                }
            }
            return Action::None;
        }
        match event.code {
            KeyCode::Tab | KeyCode::Down => {
                if !self.form.move_focus(1) && event.code == KeyCode::Tab {
                    self.in_form = false;
                }
            }
            KeyCode::BackTab | KeyCode::Up => {
                if !self.form.move_focus(-1) {
                    self.in_form = false;
                }
            }
            _ => {
                if let Some(key) = self.form.handle(&event) {
                    self.apply(&key);
                }
            }
        }
        Action::None
    }
    fn dialog(&mut self, id: &str, choice: &str, ui: &mut Ui) -> Action {
        match (id, choice) {
            ("unsaved", "save") => {
                let toast = self.save(ui);
                if self.dirty() {
                    toast
                } else {
                    Action::Many(vec![toast, Action::Pop])
                }
            }
            ("unsaved", "discard") => Action::Pop,
            _ => Action::None,
        }
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        if self.in_form {
            self.in_form = false;
            return Action::None;
        }
        if !self.dirty() && self.invalid.is_empty() {
            return Action::Pop;
        }
        Action::Dialog(Dialog::new(
            "unsaved",
            "Unsaved Changes",
            ratatui::text::Text::from("Configuration has been modified."),
            &[("save", "Save and continue"), ("discard", "Discard changes"), ("cancel", "Cancel")],
            Some("cancel"),
        ))
    }
}
