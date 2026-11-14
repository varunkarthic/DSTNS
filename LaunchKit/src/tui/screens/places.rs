// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Places: the countries a world may be in, chosen from a list (Space, Ctrl+A, Ctrl+D, Ctrl+S); and every city a seed
//! can choose, to filter and save as CSV. Both read the server's own catalogue (dstns_server --list-cities).

use crate::config;
use crate::environment::State;
use crate::tui::theme::{bold, fg, ACCENT, ERR, MUTED, OK, TEXT, TEXT2, WARN};
use crate::tui::widgets::{card, clip, key, Key};
use crate::tui::{Action, Dialog, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mark {
    In,
    Out,
}

pub struct PlacesScreen {
    /// The country picker, or the list of cities.
    picker: bool,
    cities: Vec<Value>,
    /// Code -> (name, cities), by name.
    countries: Vec<(String, String, usize)>,
    error: String,
    loaded: bool,
    filter: String,
    cursor: usize,
    scroll: usize,
    marks: BTreeMap<String, Mark>,
    saved: BTreeMap<String, Mark>,
    /// Cities named in Places, which choosing countries here replaces.
    named_cities: Vec<String>,
    message: Option<(String, u32)>,
}

impl PlacesScreen {
    pub fn countries() -> Self {
        Self::new(true)
    }
    pub fn cities() -> Self {
        Self::new(false)
    }
    fn new(picker: bool) -> Self {
        Self { picker, cities: vec![], countries: vec![], error: String::new(), loaded: false, filter: String::new(), cursor: 0, scroll: 0, marks: BTreeMap::new(), saved: BTreeMap::new(), named_cities: vec![], message: None }
    }

    fn load(&mut self, ui: &Ui) {
        self.loaded = true;
        match crate::modules::fastboot::cities(&ui.paths) {
            Ok(cities) => self.set_cities(cities),
            Err(error) => self.error = format!("{} {}", error.message, error.remedy),
        }
        if let Ok(current) = config::load(&ui.paths) {
            self.read_marks(&current);
        }
    }

    pub(crate) fn set_cities(&mut self, cities: Vec<Value>) {
        self.loaded = true;
        let text = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let mut by_code: BTreeMap<String, (String, usize)> = BTreeMap::new();
        for city in &cities {
            by_code.entry(text(city, "country_code")).or_insert_with(|| (text(city, "country"), 0)).1 += 1;
        }
        let mut countries: Vec<(String, String, usize)> = by_code.into_iter().map(|(code, (name, n))| (code, name, n)).collect();
        countries.sort_by(|a, b| a.1.cmp(&b.1));
        self.countries = countries;
        self.cities = cities;
    }

    fn read_marks(&mut self, current: &Value) {
        let (included, excluded) = config::place_ids(current);
        self.marks.clear();
        self.named_cities.clear();
        for (list, mark) in [(included, Mark::In), (excluded, Mark::Out)] {
            for id in list {
                if id.len() == 2 && id.chars().all(|c| c.is_ascii_alphabetic()) {
                    self.marks.insert(id.to_uppercase(), mark);
                } else {
                    self.named_cities.push(if mark == Mark::Out { format!("-{id}") } else { id });
                }
            }
        }
        self.saved = self.marks.clone();
    }

    /// The rows that match the filter: indices into countries or cities.
    fn rows(&self) -> Vec<usize> {
        let needle = self.filter.to_lowercase();
        let matches = |fields: &[&str]| needle.is_empty() || fields.iter().any(|f| f.to_lowercase().contains(&needle));
        if self.picker {
            (0..self.countries.len()).filter(|&i| matches(&[&self.countries[i].0, &self.countries[i].1])).collect()
        } else {
            let text = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            (0..self.cities.len())
                .filter(|&i| {
                    let c = &self.cities[i];
                    matches(&[&text(c, "city"), &text(c, "country"), &text(c, "country_code"), &text(c, "id")])
                })
                .collect()
        }
    }

    fn dirty(&self) -> bool {
        self.marks != self.saved
    }

    /// Places as the settings write it: countries, then those left out with a -, or all.
    fn places_text(&self) -> String {
        let of = |mark: Mark| self.marks.iter().filter(|(_, m)| **m == mark).map(|(c, _)| c.clone()).collect::<Vec<_>>();
        let mut parts = of(Mark::In);
        parts.extend(of(Mark::Out).into_iter().map(|c| format!("-{c}")));
        if parts.is_empty() { "all".into() } else { parts.join(", ") }
    }

    fn toggle(&mut self, out: bool) {
        let rows = self.rows();
        let Some(&i) = rows.get(self.cursor) else { return };
        let code = self.countries[i].0.clone();
        let want = if out { Mark::Out } else { Mark::In };
        if self.marks.get(&code) == Some(&want) {
            self.marks.remove(&code);
        } else {
            self.marks.insert(code, want);
        }
    }

    fn save_places(&mut self, ui: &Ui) -> Action {
        let mut current = match config::load(&ui.paths) {
            Ok(c) => c,
            Err(e) => return Action::Toast(e.message, ERR),
        };
        let places = self.places_text();
        let any_in = self.marks.values().any(|m| *m == Mark::In);
        let mut linked = vec![];
        for (key, value) in [("map.places", json!(places)), ("map.selection_mode", json!(if any_in { "countries" } else { "global" }))] {
            let Some(field) = config::field(key) else { continue };
            linked.extend(field.set(&mut current, value).into_iter().map(String::from));
        }
        match config::save(&current, &ui.paths) {
            Ok(()) => {
                self.saved = self.marks.clone();
                self.named_cities.clear();
                let also = if linked.iter().any(|k| k == "engines.selected") { "; the engine is core-ng, which can choose countries" } else { "" };
                Action::Toast(format!("Places saved: {places}{also}."), OK)
            }
            Err(e) => Action::Toast(e.message, ERR),
        }
    }

    /// Where a saved list goes: Downloads, if there is one, else the checkout's output folder.
    fn csv_target(ui: &Ui) -> PathBuf {
        let downloads = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Downloads")).filter(|d| d.is_dir());
        downloads.unwrap_or_else(|| ui.paths.root.join("output")).join("dstns-supported-cities.csv")
    }

    fn save_csv(&mut self, ui: &Ui) -> Action {
        let target = Self::csv_target(ui);
        let rows = self.rows();
        let quote = |s: &str| if s.contains([',', '"']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
        let mut out = String::from("city,id,country,country_code,lat,lon,policies\n");
        for &i in &rows {
            let c = &self.cities[i];
            let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let number = |k: &str| c.get(k).and_then(Value::as_f64).map(|v| format!("{v:.4}")).unwrap_or_default();
            out += &format!("{},{},{},{},{},{},{}\n", quote(&text("city")), text("id"), quote(&text("country")), text("country_code"), number("lat"), number("lon"), policies(&text("since")));
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(&target, out) {
            Ok(()) => {
                self.message = Some((format!("Saved {} cities to {}", rows.len(), target.display()), OK));
                Action::Toast(format!("{} cities saved as CSV.", rows.len()), OK)
            }
            Err(e) => Action::Toast(format!("{} could not be written: {e}", target.display()), ERR),
        }
    }
}

/// The policies a city may be chosen under, by the first whose catalogue has it.
fn policies(since: &str) -> &'static str {
    if since == "urban-geo-v2" { "urban-geo-v2" } else { "urban-crfg-v3 urban-geo-v1 urban-geo-v2" }
}

impl Screen for PlacesScreen {
    fn title(&self) -> String {
        if self.picker { "Countries" } else { "Supported cities" }.into()
    }
    fn path(&self) -> String {
        if self.picker { "/tools/countries" } else { "/tools/cities" }.into()
    }
    fn keys(&self, ui: &Ui) -> Vec<Key> {
        let mut keys = vec![key(if ui.unicode { "↑↓" } else { "Up/Down" }, "Move", "Move", false), key("Type", "Filter", "Filter", false)];
        if self.picker {
            keys.extend([key("Space", "Choose", "Choose", true), key("-", "Leave out", "Out", false), key("Ctrl+A", "Choose all shown", "All", true), key("Ctrl+D", "Clear all", "None", true), key("Ctrl+S", "Save", "Save", true)]);
        } else {
            keys.push(key("Ctrl+S", "Save shown as CSV", "CSV", true));
        }
        keys.push(key("Esc", "Back", "Back", true));
        keys
    }
    fn typing(&self) -> bool {
        true
    }
    fn state(&self) -> Option<(State, String)> {
        if !self.error.is_empty() {
            Some((State::Fail, "unavailable".into()))
        } else if self.picker && self.dirty() {
            Some((State::Warning, "unsaved".into()))
        } else {
            None
        }
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        if !self.loaded {
            self.load(ui);
        }
        let block = card(&self.title(), true);
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        let width = inner.width as usize;
        let rows = self.rows();
        self.cursor = self.cursor.min(rows.len().saturating_sub(1));

        let mut header = vec![];
        if !self.error.is_empty() {
            header.push(Line::from(Span::styled(clip(&self.error, width, ui.unicode), fg(ERR))));
        }
        let summary = if self.picker {
            let chosen = self.marks.values().filter(|m| **m == Mark::In).count();
            let out = self.marks.len() - chosen;
            let mut s = format!("{} countries · {chosen} chosen", self.countries.len());
            if out > 0 {
                s += &format!(" · {out} left out");
            }
            if chosen == 0 {
                s += " · worlds may be in any country";
            }
            s
        } else {
            format!("{} cities in {} countries", self.cities.len(), self.countries.len())
        };
        header.push(Line::from(vec![Span::styled(summary, bold(TEXT)), Span::styled(format!("   {} shown", rows.len()), fg(TEXT2))]));
        let caret = if ui.unicode { "▏" } else { "_" };
        header.push(Line::from(vec![Span::styled("Filter  ", fg(MUTED)), Span::styled(self.filter.clone(), fg(ACCENT)), Span::styled(caret, fg(ACCENT)), Span::styled(if self.filter.is_empty() { "  type a name or a code" } else { "" }, fg(MUTED))]));
        if self.picker {
            header.push(Line::default());
        } else {
            let name_room = (width.saturating_sub(30) / 2).max(10);
            let country_room = width.saturating_sub(name_room + 30).max(8);
            header.push(Line::from(Span::styled(format!("  {:<name_room$} {:<country_room$} {:<4}{:<18}{}", "City", "Country", "Code", "ID", "Since"), fg(MUTED))));
        }
        let header_height = header.len() as u16;
        frame.render_widget(Paragraph::new(header), Rect { height: header_height, ..inner });

        let footer: Vec<Line> = if self.picker {
            let mut lines = vec![Line::from(vec![Span::styled("Places  ", fg(MUTED)), Span::styled(clip(&self.places_text(), width.saturating_sub(8), ui.unicode), fg(if self.dirty() { WARN } else { TEXT }))])];
            if !self.named_cities.is_empty() {
                lines.push(Line::from(Span::styled(clip(&format!("Places names cities now ({}); saving countries here replaces them.", self.named_cities.join(", ")), width, ui.unicode), fg(WARN))));
            }
            lines
        } else {
            let (text, colour) = self.message.clone().unwrap_or_else(|| (format!("Ctrl+S saves the cities shown to {}", Self::csv_target(ui).display()), MUTED));
            vec![Line::from(Span::styled(clip(&text, width, ui.unicode), fg(colour)))]
        };
        let footer_height = footer.len() as u16 + 1;
        let list = Rect { y: inner.y + header_height, height: inner.height.saturating_sub(header_height + footer_height), ..inner };
        frame.render_widget(Paragraph::new(footer), Rect { y: inner.y + inner.height.saturating_sub(footer_height - 1), height: footer_height - 1, ..inner });

        let visible = list.height as usize;
        if self.cursor < self.scroll {
            self.scroll = self.cursor;
        } else if visible > 0 && self.cursor >= self.scroll + visible {
            self.scroll = self.cursor + 1 - visible;
        }
        let pointer = if ui.unicode { "▸ " } else { "> " };
        let lines: Vec<Line> = rows
            .iter()
            .enumerate()
            .skip(self.scroll)
            .take(visible)
            .map(|(n, &i)| {
                let here = n == self.cursor;
                let lead = Span::styled(if here { pointer } else { "  " }, fg(ACCENT));
                if self.picker {
                    let (code, name, count) = &self.countries[i];
                    let (mark, colour) = match self.marks.get(code) {
                        Some(Mark::In) => (if ui.unicode { "[✓]" } else { "[x]" }, ACCENT),
                        Some(Mark::Out) => (if ui.unicode { "[−]" } else { "[-]" }, ERR),
                        None => ("[ ]", MUTED),
                    };
                    let room = width.saturating_sub(20);
                    Line::from(vec![
                        lead,
                        Span::styled(format!("{mark} "), fg(colour)),
                        Span::styled(format!("{code}  "), bold(if self.marks.contains_key(code) { colour } else { TEXT2 })),
                        Span::styled(format!("{:<room$}", clip(name, room, ui.unicode)), if here { bold(TEXT) } else { fg(TEXT) }),
                        Span::styled(format!("{count:>3} {}", if *count == 1 { "city" } else { "cities" }), fg(MUTED)),
                    ])
                } else {
                    let c = &self.cities[i];
                    let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    let new = text("since") == "urban-geo-v2";
                    let name_room = (width.saturating_sub(30) / 2).max(10);
                    let country_room = width.saturating_sub(name_room + 30).max(8);
                    Line::from(vec![
                        lead,
                        Span::styled(format!("{:<name_room$} ", clip(&text("city"), name_room, ui.unicode)), if here { bold(TEXT) } else { fg(TEXT) }),
                        Span::styled(format!("{:<country_room$} ", clip(&text("country"), country_room, ui.unicode)), fg(TEXT2)),
                        Span::styled(format!("{:<4}", text("country_code")), fg(ACCENT)),
                        Span::styled(format!("{:<18}", clip(&text("id"), 17, ui.unicode)), fg(MUTED)),
                        Span::styled(if new { "new" } else { "always" }, fg(if new { OK } else { MUTED })),
                    ])
                }
            })
            .collect();
        frame.render_widget(Paragraph::new(lines), list);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        if event.modifiers.contains(KeyModifiers::CONTROL) && event.code == KeyCode::Char('s') {
            return if self.picker { self.save_places(ui) } else { self.save_csv(ui) };
        }
        self.edit(&event);
        Action::None
    }
    fn dialog(&mut self, id: &str, choice: &str, ui: &mut Ui) -> Action {
        match (id, choice) {
            ("unsaved", "save") => {
                let toast = self.save_places(ui);
                if self.dirty() { toast } else { Action::Many(vec![toast, Action::Pop]) }
            }
            ("unsaved", "discard") => Action::Pop,
            _ => Action::None,
        }
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        if !self.filter.is_empty() {
            self.filter.clear();
            self.cursor = 0;
            return Action::None;
        }
        if self.picker && self.dirty() {
            return Action::Dialog(Dialog::new("unsaved", "Unsaved Places", ratatui::text::Text::from("The countries chosen here are not saved."), &[("save", "Save and continue"), ("discard", "Discard changes"), ("cancel", "Cancel")], Some("cancel")));
        }
        Action::Pop
    }
}

impl PlacesScreen {
    /// Every key but saving: moving, choosing, filtering.
    fn edit(&mut self, event: &KeyEvent) {
        let control = event.modifiers.contains(KeyModifiers::CONTROL);
        let rows = self.rows().len();
        match event.code {
            KeyCode::Char('a') if control && self.picker => {
                for i in self.rows() {
                    self.marks.insert(self.countries[i].0.clone(), Mark::In);
                }
            }
            KeyCode::Char('d') if control && self.picker => self.marks.clear(),
            KeyCode::Char(' ') | KeyCode::Enter if self.picker => self.toggle(false),
            KeyCode::Char('-') if self.picker => self.toggle(true),
            KeyCode::Up => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Down => self.cursor = (self.cursor + 1).min(rows.saturating_sub(1)),
            KeyCode::PageUp => self.cursor = self.cursor.saturating_sub(10),
            KeyCode::PageDown => self.cursor = (self.cursor + 10).min(rows.saturating_sub(1)),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = rows.saturating_sub(1),
            KeyCode::Backspace => {
                self.filter.pop();
                self.cursor = 0;
            }
            KeyCode::Char(c) if !control => {
                self.filter.push(c);
                self.cursor = 0;
                self.scroll = 0;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, KeyModifiers};

    fn screen() -> PlacesScreen {
        let mut s = PlacesScreen::countries();
        s.set_cities(vec![
            json!({"city": "Chennai", "country": "India", "country_code": "IN", "id": "chennai", "since": "urban-crfg-v3"}),
            json!({"city": "Kochi", "country": "India", "country_code": "IN", "id": "kochi", "since": "urban-geo-v2"}),
            json!({"city": "Dubai", "country": "United Arab Emirates", "country_code": "AE", "id": "dubai", "since": "urban-crfg-v3"}),
            json!({"city": "Paris", "country": "France", "country_code": "FR", "id": "paris", "since": "urban-crfg-v3"}),
        ]);
        s.loaded = true;
        s
    }

    fn press(s: &mut PlacesScreen, code: KeyCode, modifiers: KeyModifiers, _ui: &mut ()) {
        s.edit(&KeyEvent::new(code, modifiers));
    }

    #[test]
    fn countries_are_chosen_with_space_left_out_with_a_dash_and_written_as_places() {
        let mut ui = ();
        let mut s = screen();
        // By name: France, India, United Arab Emirates.
        assert_eq!(s.countries.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), ["FR", "IN", "AE"]);
        assert_eq!(s.countries[1].2, 2, "India has two cities");
        assert_eq!(s.places_text(), "all");
        press(&mut s, KeyCode::Down, KeyModifiers::NONE, &mut ui);
        press(&mut s, KeyCode::Char(' '), KeyModifiers::NONE, &mut ui);
        assert_eq!(s.places_text(), "IN");
        press(&mut s, KeyCode::Char(' '), KeyModifiers::NONE, &mut ui);
        assert_eq!(s.places_text(), "all", "space again takes it back");
        press(&mut s, KeyCode::Char('-'), KeyModifiers::NONE, &mut ui);
        assert_eq!(s.places_text(), "-IN", "everywhere but India");
        press(&mut s, KeyCode::Char('a'), KeyModifiers::CONTROL, &mut ui);
        assert_eq!(s.places_text(), "AE, FR, IN");
        press(&mut s, KeyCode::Char('d'), KeyModifiers::CONTROL, &mut ui);
        assert_eq!(s.places_text(), "all");
        // Typing filters; Ctrl+A chooses only what is shown.
        for c in "arab".chars() {
            press(&mut s, KeyCode::Char(c), KeyModifiers::NONE, &mut ui);
        }
        assert_eq!(s.rows().len(), 1);
        press(&mut s, KeyCode::Char('a'), KeyModifiers::CONTROL, &mut ui);
        assert_eq!(s.places_text(), "AE");
        assert!(s.dirty());
    }

    #[test]
    fn places_read_back_as_marks_and_cities_are_kept_aside() {
        let mut s = screen();
        s.read_marks(&json!({"map": {"places": "IN, ae, -dubai"}}));
        assert_eq!(s.places_text(), "AE, IN");
        assert_eq!(s.named_cities, ["-dubai"]);
        assert!(!s.dirty());
    }

    #[test]
    fn the_city_list_filters_by_any_column() {
        let mut s = screen();
        s.picker = false;
        s.filter = "in".into();
        assert_eq!(s.rows(), vec![0, 1], "India's two cities, by its name and code");
        s.filter = "kochi".into();
        assert_eq!(s.rows(), vec![1]);
        assert_eq!(policies("urban-geo-v2"), "urban-geo-v2");
    }
}
