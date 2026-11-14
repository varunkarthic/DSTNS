// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Configuration: every setting, in sections of categories; config/defaults.json, and the observer's config/ui-config.json.

use crate::config::{self, FieldKind};
use crate::environment::State;
use crate::tui::theme::{bold, fg, ERR, MUTED, TEXT2, WARN};
use crate::tui::widgets::{self, card, form_row, heading, item, key, Editor, Form, Key, Menu, MenuEvent};
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
    /// What else a change turned on or off, said once.
    notice: String,
    /// The person confirmed a change that is a risk; the next save goes ahead once.
    risk_accepted: bool,
    /// When the settings files last changed, as read; and when that was last looked at.
    seen: Option<std::time::SystemTime>,
    looked: Option<std::time::Instant>,
}

/// The latest change to any of the files the settings live in.
fn files_changed(paths: &crate::paths::Paths) -> Option<std::time::SystemTime> {
    [paths.config(), paths.engines_config(), paths.config_dir().join("ui-config.json")].iter().filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok()).max()
}

fn editor(field: &config::Field, value: &Value) -> Editor {
    if field.key == "demo.scenes" {
        // The chosen scenes first, in their order, then the rest, off.
        let chosen: Vec<String> = value.as_str().unwrap_or("").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        let title = |id: &str| config::DEMO_SCENES.iter().position(|s| *s == id).map(|i| config::DEMO_SCENE_TITLES[i].to_string()).unwrap_or_else(|| id.to_string());
        let mut items: Vec<(String, String, bool)> = chosen.iter().filter(|id| config::DEMO_SCENES.contains(&id.as_str())).map(|id| (id.clone(), title(id), true)).collect();
        items.extend(config::DEMO_SCENES.iter().filter(|id| !chosen.iter().any(|c| c == *id)).map(|id| (id.to_string(), title(id), false)));
        return Editor::Order { items, cursor: 0 };
    }
    if field.key == "map.places" {
        // A list of countries to tick, as the demo's scenes are; places that are not countries (cities) follow, ticked.
        let countries = crate::modules::fastboot::countries(&crate::paths::Paths::default());
        if !countries.is_empty() {
            let (included, excluded) = config::place_ids(&serde_json::json!({"map": {"places": value}}));
            let mark = |id: &str| if included.iter().any(|i| i.eq_ignore_ascii_case(id)) { 1 } else if excluded.iter().any(|i| i.eq_ignore_ascii_case(id)) { 2 } else { 0 };
            let mut items: Vec<(String, String, u8)> = countries.iter().map(|(code, name, n)| (code.clone(), format!("{name} · {n} {}", if *n == 1 { "city" } else { "cities" }), mark(code))).collect();
            for (ids, m) in [(&included, 1u8), (&excluded, 2u8)] {
                for id in ids.iter().filter(|id| !countries.iter().any(|(c, ..)| c.eq_ignore_ascii_case(id))) {
                    items.push((id.clone(), "city".into(), m));
                }
            }
            return Editor::Checks { items, cursor: 0, scroll: 0, rows: 10 };
        }
    }
    if field.key.starts_with("rcs.") {
        return Editor::triple(&field.display(value), if field.key.ends_with(".memory") { "MiB" } else { "% of a core" });
    }
    match field.kind {
        FieldKind::Boolean => Editor::Toggle(value.as_bool().unwrap_or(false)),
        FieldKind::Choice => Editor::select(field.choices.iter().map(|(l, c)| (capitalise(l), c.to_string())).collect(), &value.to_string()),
        FieldKind::Integer | FieldKind::Number => Editor::number(&field.display(value)),
        FieldKind::Text => Editor::text(&field.display(value), ""),
    }
}

/// Each section a heading, its categories beneath it; the first category chosen.
fn sections() -> Menu {
    let mut items = vec![];
    let mut current = "";
    for category in config::categories() {
        let section = config::section_of(category);
        if section != current {
            current = section;
            items.push(heading(section));
        }
        items.push(item(category, category));
    }
    Menu::new(items)
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

impl ConfigurationScreen {
    pub fn new(category: Option<String>) -> Self {
        Self {
            categories: sections(),
            form: Form::default(),
            current: Value::Null,
            saved: Value::Null,
            invalid: BTreeSet::new(),
            load_error: String::new(),
            in_form: false,
            loaded: false,
            wanted: category,
            notice: String::new(),
            risk_accepted: false,
            seen: None,
            looked: None,
        }
    }

    fn load(&mut self, ui: &Ui) {
        self.loaded = true;
        self.seen = files_changed(&ui.paths);
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
                // Its meaning, what it accepts, its default, when it applies, and what it is linked to.
                r.hint = config::guidance(f);
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
            Editor::Order { .. } | Editor::Triple { .. } | Editor::Checks { .. } => field.parse(&row.editor.text_value()),
        };
        let problem = match &parsed {
            Ok(value) => config::check_field(field, value, &self.current),
            Err(problem) => problem.clone(),
        };
        if problem.is_empty() {
            self.invalid.remove(key);
            self.form.set_problem(key, "");
            // What changed with it shows at once, and says why.
            for other in field.set(&mut self.current, parsed.unwrap()) {
                let Some(linked) = config::field(other) else { continue };
                let value = linked.get(&self.current);
                // Its own kind of editor again: a linked setting may be a choice or text, not only a switch.
                if let Some(row) = self.form.get_mut(other) {
                    row.editor = editor(linked, &value);
                    row.problem.clear();
                }
                self.notice = format!("{} became {} with it", linked.label, linked.display(&value));
            }
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
        // Removing the protection of an unstable engine's runs is confirmed first, and said to be a risk.
        if !self.risk_accepted {
            let risky = config::fields().iter().find_map(|f| {
                let now = f.get(&self.current);
                (now != f.get(&self.saved)).then(|| config::risky_change(f, &now)).flatten()
            });
            if let Some(why) = risky {
                return Action::Dialog(Dialog::confirm("risk", "This is a risk", &format!("{why} Save anyway?"), "Save anyway", "Cancel"));
            }
        }
        self.risk_accepted = false;
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
        let mut keys = vec![key(if ui.unicode { "↑↓" } else { "Up/Down" }, "Categories", "Move", false), key("Tab", "Next field", "Next", true)];
        match self.form.focused().filter(|_| self.in_form) {
            Some(row) if matches!(row.editor, Editor::Triple { .. }) => {
                keys.push(key(if ui.unicode { "←→" } else { "Left/Right" }, if ui.unicode { "α β γ" } else { "alpha beta gamma" }, "Cell", true));
                keys.push(key("+ -", "Step", "Step", false));
            }
            Some(row) if matches!(row.editor, Editor::Checks { .. }) => {
                keys.push(key("Space", "Choose", "Choose", true));
                keys.push(key("-", "Leave out", "Out", false));
                keys.push(key("Ctrl+A", "All", "All", false));
                keys.push(key("Ctrl+D", "None", "None", false));
            }
            Some(row) if row.key == "map.places" => keys.push(key("Enter", "Choose countries", "Countries", true)),
            _ => {}
        }
        keys.extend([key("Ctrl+S", "Save", "Save", true), key("Esc", "Back", "Back", true)]);
        keys
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
        let (side, content) = widgets::columns(area, widgets::list_width(&self.categories, area, ui.layout == crate::terminal::Layout::Medium), ui.small(), 4);
        if ui.small() {
            self.categories.render(frame, side, !self.in_form, ui.unicode);
        } else {
            let block = card("Settings", !self.in_form);
            let inner = block.inner(side);
            frame.render_widget(block, side);
            self.categories.render(frame, inner, !self.in_form, ui.unicode);
        }
        let block = card(&self.categories.current_key().unwrap_or_default(), self.in_form);
        let inner = if ui.small() { content } else { block.inner(content) };
        if !ui.small() {
            frame.render_widget(block, content);
        }
        let inner = Rect { x: inner.x + 1, width: inner.width.saturating_sub(2), ..inner };
        // Where this category is kept, and the section it belongs to.
        let category = self.categories.current_key().unwrap_or_default();
        let file = if config::section_of(&category) == "Observer" { "config/ui-config.json · the observer's defaults; each viewer's own choices come first" } else { "config/defaults.json" };
        let mut header = vec![Line::from(Span::styled(file, fg(MUTED)))];
        if !self.load_error.is_empty() {
            header.push(Line::from(Span::styled(self.load_error.clone(), fg(ERR))));
        }
        let status = if !self.invalid.is_empty() {
            Some(Line::from(Span::styled("Correct the highlighted values before saving.", fg(ERR))))
        } else if !self.notice.is_empty() && self.dirty() {
            Some(Line::from(Span::styled(format!("{}. Ctrl+S saves.", self.notice), fg(WARN))))
        } else if self.dirty() {
            Some(Line::from(Span::styled("Unsaved changes. Ctrl+S saves them.", fg(WARN))))
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
        // Places as text, where the list cannot be shown (the server is not built yet): Enter opens the countries.
        if event.code == KeyCode::Enter && self.form.focused().map(|r| r.key == "map.places" && matches!(r.editor, Editor::Text { .. })).unwrap_or(false) {
            return Action::Push(Box::new(super::places::PlacesScreen::countries()));
        }
        // A list of its own keeps the arrows while there is somewhere in it to go.
        let checks_key = matches!(event.code, KeyCode::Char('a') | KeyCode::Char('d')) && event.modifiers.contains(KeyModifiers::CONTROL);
        if self.form.focused().map(|r| r.editor.consumes(&event) || (r.editor.is_order() && event.modifiers.contains(KeyModifiers::SHIFT)) || (checks_key && matches!(r.editor, Editor::Checks { .. }))).unwrap_or(false) {
            if let Some(key) = self.form.handle(&event) {
                self.apply(&key);
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
    fn tick(&mut self, ui: &mut Ui) -> Action {
        // A setting changed elsewhere (the command bar, ./launcher engine add IN, another window) shows here at once,
        // unless there are edits here not yet saved.
        if self.loaded && !self.dirty() && self.looked.is_none_or(|t| t.elapsed() >= std::time::Duration::from_secs(1)) {
            self.looked = Some(std::time::Instant::now());
            if files_changed(&ui.paths) != self.seen {
                let focus = self.form.focus;
                self.resume(ui);
                self.form.focus = focus.min(self.form.rows.len().saturating_sub(1));
            }
        }
        Action::None
    }
    fn resume(&mut self, ui: &mut Ui) {
        // Back from the country list, which saves on its own: show what it saved, unless there are edits here.
        if self.loaded && !self.dirty() {
            let category = self.categories.current_key();
            self.load(ui);
            if let Some(category) = category {
                self.categories.select(&category);
                self.show_category();
            }
        }
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
            ("risk", "yes") => {
                self.risk_accepted = true;
                self.save(ui)
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A change that sets another setting gives that row back its own kind of editor: the engine is a choice and
    /// Places is text, and neither may become an on/off switch.
    #[test]
    fn a_linked_setting_keeps_its_own_editor() {
        let mut screen = ConfigurationScreen::new(Some("Engine".into()));
        screen.current = json!({"engines": {"engines": {"core-legacy": {"enabled": true}}}});
        screen.categories.select("Engine");
        screen.show_category();
        let mode = config::field("map.selection_mode").unwrap();
        if let Some(row) = screen.form.get_mut("map.selection_mode") {
            row.editor = editor(mode, &json!("countries"));
        }
        screen.apply("map.selection_mode");
        assert_eq!(config::setting(&screen.current, "engines.selected"), json!("core-ng"));
        assert!(matches!(screen.form.get("engines.selected").unwrap().editor, Editor::Select { .. }), "the engine is still a choice");
        let engine = config::field("engines.selected").unwrap();
        screen.form.get_mut("engines.selected").unwrap().editor = editor(engine, &json!("core-legacy"));
        screen.apply("engines.selected");
        assert!(matches!(screen.form.get("map.places").unwrap().editor, Editor::Text { .. } | Editor::Checks { .. }), "Places is still its list (or text before the server is built)");
        assert!(screen.notice.contains("became"), "{}", screen.notice);
    }
}
