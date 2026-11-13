// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Start simulation: choose what to run.

use crate::config::{self, RunOptions};
use crate::tui::theme::{fg, ERR, TEXT2};
use crate::tui::widgets::{self, card, form_row, key, Editor, Form, Key};
use crate::tui::{Action, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

const AUTO: &str = "__auto__";
const CUSTOM: &str = "__custom__";

pub struct StartScreen {
    form: Form,
    apps: Vec<(String, String, bool)>,
    error: String,
}

impl StartScreen {
    pub fn new(ui: &Ui) -> Self {
        let defaults = config::load(&ui.paths).ok();
        let day = defaults.as_ref().and_then(|d| d.get("day")).and_then(|d| d.as_i64()).unwrap_or(0);
        let speed = defaults.as_ref().and_then(|d| d.pointer("/playback/tick_rate")).map(|v| v.to_string()).unwrap_or_else(|| "1".into());
        let mut maps: Vec<(String, String)> = vec![("Chosen by the seed".into(), AUTO.into())];
        maps.extend(crate::simulation::cached_maps(&ui.paths).into_iter().map(|m| (m.clone(), m)));
        maps.push(("Bundled offline district".into(), "data/fixtures/real_network.osm.xml".into()));
        maps.push(("Another file...".into(), CUSTOM.into()));
        let mut rows = vec![
            form_row("seed", "Seed", Editor::text("", "empty: a new seed")),
            form_row("day", "Day type", Editor::select(vec![("Weekday".into(), "weekday".into()), ("Weekend".into(), "weekend".into())], if day == 1 { "weekend" } else { "weekday" })),
            form_row("map", "Map", Editor::select(maps, AUTO)),
            form_row("map-file", "Map file", Editor::text("", "path to an OpenStreetMap XML file")),
            {
                let mut r = form_row("speed", "Speed", Editor::number(&speed));
                r.unit = if ui.unicode { "×" } else { "x" }.into();
                r
            },
            form_row("engine", "Engine", Editor::select(config::ENGINES.iter().map(|e| (e.to_string(), e.to_string())).collect(), defaults.as_ref().map(|d| config::setting(d, "engine.implementation")).and_then(|v| v.as_str().map(String::from)).as_deref().unwrap_or("core-legacy"))),
        ];
        rows[3].visible = false;
        let apps: Vec<(String, String, bool)> = crate::apps::load(&ui.paths).map(|a| a.into_values().map(|a| (a.id.clone(), a.title(), a.required)).collect()).unwrap_or_default();
        let catalogue = crate::apps::load(&ui.paths).unwrap_or_default();
        for (id, title, required) in &apps {
            let mut r = form_row(&format!("app:{id}"), title, Editor::Toggle(catalogue.get(id).map(|a| a.autostart).unwrap_or(false)));
            if *required {
                r.unit = "required".into();
            }
            rows.push(r);
        }
        if let Some(first) = rows.iter_mut().find(|r| r.key.starts_with("app:")) {
            first.hint = "Started once the observer is open. The simulation waits until they are ready.".into();
        }
        rows.push(form_row("save-as", "Save as", Editor::text("", "ID to save this configuration")));
        rows.push(form_row("description", "Description", Editor::text("", "a note stored with the saved seed")));
        rows.push(form_row("open", "Open observer", Editor::Toggle(ui.args.open)));
        Self { form: Form { rows, focus: 0, scroll: 0 }, apps, error: String::new() }
    }

    fn options(&mut self) -> Option<RunOptions> {
        self.form.clear_problems();
        self.error.clear();
        let text = |form: &Form, key: &str| Some(form.value(key).trim().to_string()).filter(|v| !v.is_empty());
        let map = self.form.value("map");
        let osm_file = if map == CUSTOM {
            match text(&self.form, "map-file") {
                Some(file) => Some(file),
                None => {
                    self.form.set_problem("map-file", "Enter the path of a map file.");
                    return None;
                }
            }
        } else if map != AUTO {
            Some(map)
        } else {
            None
        };
        let chosen: Vec<String> = self.apps.iter().filter(|(id, _, _)| self.form.get(&format!("app:{id}")).map(|r| r.editor.toggled()).unwrap_or(false)).map(|(id, _, _)| id.clone()).collect();
        let options = RunOptions {
            seed: text(&self.form, "seed"),
            day_type: Some(self.form.value("day")),
            speed: text(&self.form, "speed"),
            engine: Some(self.form.value("engine")),
            osm_file,
            apps: Some(chosen.join(",")),
            save_seed: text(&self.form, "save-as"),
            description: text(&self.form, "description"),
            ..Default::default()
        };
        if let Err(error) = config::start_request(&options, &crate::paths::Paths::default()) {
            let message = error.message.clone();
            let target = if message.contains("eed") && !message.to_lowercase().contains("saved") {
                Some("seed")
            } else if message.contains("speed") || message.contains("tick_rate") {
                Some("speed")
            } else if message.contains("OSM") || message.to_lowercase().contains("map") {
                Some("map-file")
            } else {
                None
            };
            match target {
                Some("map-file") => {
                    self.form.get_mut("map-file").unwrap().visible = true;
                    self.form.set_problem("map-file", &message);
                }
                Some(key) => self.form.set_problem(key, &message),
                None => self.error = message,
            }
            return None;
        }
        if let Some(name) = &options.save_seed {
            if !crate::seeds::valid_id(name) {
                self.form.set_problem("save-as", "1 to 64 letters, digits, _ or -, starting with a letter or digit.");
                return None;
            }
        }
        Some(options)
    }
}

impl Screen for StartScreen {
    fn title(&self) -> String {
        "Start Simulation".into()
    }
    fn path(&self) -> String {
        "/start".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Tab", "Next field", "Next", true), key("Ctrl+S", "Start", "Start", true), key("Esc", "Cancel", "Back", true)]
    }
    fn typing(&self) -> bool {
        self.form.focused().map(|r| matches!(r.editor, Editor::Text { .. })).unwrap_or(false)
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let outer = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
        let block = card("What to run", true);
        let inner = block.inner(outer);
        frame.render_widget(block, outer);
        let footer = 2;
        let form_area = Rect { height: inner.height.saturating_sub(footer), ..inner };
        self.form.render(frame, Rect { x: form_area.x + 1, width: form_area.width.saturating_sub(2), ..form_area }, true, ui.unicode, 24);
        let mut lines = vec![];
        if !self.error.is_empty() {
            lines.push(Line::from(Span::styled(self.error.clone(), fg(ERR))));
        }
        lines.push(Line::from(Span::styled("Ctrl+S starts it; Esc cancels.", fg(TEXT2))));
        frame.render_widget(Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }), Rect { y: inner.y + inner.height.saturating_sub(footer), height: footer, x: inner.x + 1, width: inner.width.saturating_sub(2) });
        let _ = widgets::width("");
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        if event.modifiers.contains(KeyModifiers::CONTROL) && event.code == KeyCode::Char('s') {
            return self.start(ui);
        }
        match event.code {
            KeyCode::Tab | KeyCode::Down => {
                self.form.move_focus(1);
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.form.move_focus(-1);
            }
            KeyCode::Enter if !matches!(self.form.focused().map(|r| &r.editor), Some(Editor::Toggle(_)) | Some(Editor::Select { .. })) => {
                if !self.form.move_focus(1) {
                    return self.start(ui);
                }
            }
            _ => {
                if self.form.handle(&event).as_deref() == Some("map") {
                    let custom = self.form.value("map") == CUSTOM;
                    self.form.get_mut("map-file").unwrap().visible = custom;
                }
            }
        }
        Action::None
    }
}

impl StartScreen {
    fn start(&mut self, ui: &mut Ui) -> Action {
        let Some(options) = self.options() else { return Action::None };
        ui.args.open = self.form.get("open").map(|r| r.editor.toggled()).unwrap_or(true);
        Action::Replace(Box::new(super::running::RunningScreen::new(Some(options))))
    }
}
