// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The first-launch setup: the choices worth making before the first run, a page at a time.
//!
//! It opens by itself the first time the launcher starts in a terminal, as DSTNS_SETUP_COMPLETE says (see setup.rs),
//! and again after ./launcher reset, or with ./launcher setup. Everything it sets is an ordinary setting, which
//! Configuration changes later. Skipping it keeps the defaults, and it doesn't ask again.

use crate::config::{self, FieldKind};
use crate::environment::{self, State};
use crate::tui::theme::{bold, fg, CYAN, ERR, MUTED, OK, TEXT, TEXT2, WARN};
use crate::tui::widgets::{self, card, form_row, item, key, row, status_lines, Editor, Form, FormRow, Key, Menu, MenuEvent};
use crate::tui::{Action, Dialog, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use serde_json::{json, Value};

struct Step {
    title: &'static str,
    intro: &'static str,
    keys: &'static [&'static str],
}

const STEPS: &[Step] = &[
    Step { title: "Welcome", intro: "", keys: &[] },
    Step {
        title: "Starting a run",
        intro: "How a simulation begins. Fast Boot needs every city downloaded first, which you can do at the end of this setup or later.",
        keys: &["startup.fast_boot", "startup.force_animate", "launcher.default_settings", "narration.mode"],
    },
    Step { title: "Presentation", intro: "Music and full screen for the start-up film. Demo Mode has its own, on by default.", keys: &["presentation.music", "presentation.fullscreen", "presentation.music_volume"] },
    Step {
        title: "Performance",
        intro: "Choose a preset, or set each yourself. Battery saver draws the map at 30 frames a second, at a lower resolution, with a lighter film.",
        keys: &["performance.compression", "performance.map_fps", "performance.render_scale", "performance.film_particles"],
    },
    Step {
        title: "Applications and AI",
        intro: "Your own programs connect through the Fabric API, and show in the observer through WebFabric. The MCP Handler lets an AI client call DSTNS; it is off unless you turn it on.",
        keys: &["fabric.applications", "webfabric.enabled", "fabric.legacy_api", "mcp.enabled", "mcp.allow_writes"],
    },
    Step { title: "Server", intro: "Where the server listens. 127.0.0.1 keeps it to this machine.", keys: &["api.port", "api.host"] },
    Step { title: "Done", intro: "", keys: &[] },
];

const PRESETS: &[(&str, &str, i64, f64, i64)] = &[("balanced", "Balanced", 0, 2.0, 32000), ("battery", "Battery saver", 30, 1.0, 12000), ("quality", "Best quality", 60, 2.0, 32000)];

pub struct SetupScreen {
    step: usize,
    current: Value,
    forms: Vec<Form>,
    actions: Menu,
    in_actions: bool,
    error: String,
    /// The page to open once the setup is done, as the launcher was asked for.
    pub then: Option<String>,
}

fn editor_for(field: &config::Field, value: &Value) -> Editor {
    match field.kind {
        FieldKind::Boolean => Editor::Toggle(value.as_bool().unwrap_or(false)),
        FieldKind::Choice => Editor::select(field.choices.iter().map(|(l, c)| (l.to_string(), c.to_string())).collect(), &value.to_string()),
        FieldKind::Integer | FieldKind::Number => Editor::number(&field.display(value)),
        FieldKind::Text if field.key == "narration.mode" => {
            let mut choices = vec![("Automatic: Apple's on-device model where available".to_string(), "\"auto\"".to_string()), ("Off: standard wording".to_string(), "\"off\"".to_string())];
            let shown = value.to_string();
            if !choices.iter().any(|(_, v)| *v == shown) {
                choices.push((value.as_str().unwrap_or("").to_string(), shown.clone()));
            }
            Editor::select(choices, &shown)
        }
        FieldKind::Text => Editor::text(&field.display(value), ""),
    }
}

impl SetupScreen {
    pub fn new(ui: &Ui) -> Self {
        let current = config::load(&ui.paths).unwrap_or_else(|_| json!({}));
        let forms = STEPS
            .iter()
            .map(|step| {
                let mut rows: Vec<FormRow> = vec![];
                if step.title == "Performance" {
                    let mut preset = form_row("preset", "Preset", Editor::select(PRESETS.iter().map(|p| (p.1.to_string(), p.0.to_string())).chain([("Custom".to_string(), "custom".to_string())]).collect(), "balanced"));
                    preset.hint = "Sets the three below.".into();
                    rows.push(preset);
                }
                for key in step.keys {
                    let field = config::field(key).expect("a known setting");
                    let mut r = form_row(key, field.label, editor_for(field, &field.get(&current)));
                    r.hint = field.help.into();
                    r.unit = field.unit.into();
                    rows.push(r);
                }
                Form { rows, focus: 0, scroll: 0 }
            })
            .collect();
        let mut screen = Self { step: 0, current, forms, actions: Menu::default(), in_actions: true, error: String::new(), then: None };
        screen.sync_preset();
        screen.set_actions();
        screen
    }

    fn set_actions(&mut self) {
        let last = self.step + 1 == STEPS.len();
        let mut items = vec![];
        if last {
            items.push(item("finish", "Finish"));
            if config::flag(&self.current, "startup.fast_boot") {
                items.push(item("download", "Finish, and download every city for Fast Boot"));
            }
        } else {
            items.push(item("next", if self.step == 0 { "Begin" } else { "Next" }));
        }
        if self.step > 0 {
            items.push(item("back", "Back"));
        }
        if !last {
            items.push(item("skip", "Skip the setup and keep the defaults"));
        }
        self.actions = Menu::new(items);
        self.in_actions = self.forms[self.step].rows.is_empty();
    }

    /// Which preset the performance settings match, if any.
    fn sync_preset(&mut self) {
        let fps = config::as_int(&config::setting(&self.current, "performance.map_fps")).unwrap_or(0);
        let scale = config::as_number(&config::setting(&self.current, "performance.render_scale")).unwrap_or(2.0);
        let particles = config::as_int(&config::setting(&self.current, "performance.film_particles")).unwrap_or(32000);
        let matched = PRESETS.iter().find(|p| p.2 == fps && (p.3 - scale).abs() < 1e-9 && p.4 == particles).map(|p| p.0).unwrap_or("custom");
        let form = &mut self.forms[3];
        if let Some(row) = form.get_mut("preset") {
            row.editor = Editor::select(PRESETS.iter().map(|p| (p.1.to_string(), p.0.to_string())).chain([("Custom".to_string(), "custom".to_string())]).collect(), matched);
        }
    }

    fn apply(&mut self, key: &str) {
        let form = &mut self.forms[self.step];
        if key == "preset" {
            let chosen = form.value("preset");
            if let Some(preset) = PRESETS.iter().find(|p| p.0 == chosen) {
                for (k, v) in [("performance.map_fps", json!(preset.2)), ("performance.render_scale", json!(preset.3)), ("performance.film_particles", json!(preset.4))] {
                    let field = config::field(k).unwrap();
                    field.set(&mut self.current, v.clone());
                    if let Some(row) = form.get_mut(k) {
                        row.editor = editor_for(field, &v);
                    }
                }
            }
            return;
        }
        let Some(field) = config::field(key) else { return };
        let Some(row) = form.get(key) else { return };
        let parsed = match &row.editor {
            Editor::Toggle(on) => Ok(Value::Bool(*on)),
            Editor::Select { choices, index } => Ok(serde_json::from_str::<Value>(&choices[*index].1).unwrap_or(Value::Null)),
            Editor::Text { value, .. } => field.parse(value),
        };
        let problem = match &parsed {
            Ok(value) => config::check_field(field, value, &self.current),
            Err(problem) => problem.clone(),
        };
        form.set_problem(key, &problem);
        if problem.is_empty() {
            field.set(&mut self.current, parsed.unwrap());
        }
        if key.starts_with("performance.") {
            self.sync_preset();
        }
        if key == "startup.fast_boot" && config::flag(&self.current, "startup.fast_boot") {
            // Fast Boot does without the whole film.
            config::field("startup.force_animate").unwrap().set(&mut self.current, json!(false));
            if let Some(row) = self.forms[1].get_mut("startup.force_animate") {
                row.editor = Editor::Toggle(false);
            }
        }
    }

    fn invalid(&self) -> bool {
        self.forms[self.step].rows.iter().any(|r| !r.problem.is_empty())
    }

    fn finish(&mut self, ui: &mut Ui, download: bool) -> Action {
        if let Err(error) = config::save(&self.current, &ui.paths) {
            self.error = error.message;
            return Action::None;
        }
        let _ = crate::setup::complete(&ui.paths);
        let mut actions = vec![Action::Pop, Action::Toast("All set. Everything here is in Configuration, to change any time.".into(), OK)];
        if download {
            actions.push(Action::Push(Box::new(super::tasks::TaskScreen::presentation())));
        } else if let Some(then) = self.then.clone() {
            actions.push(super::initial_page(&then, ui));
        }
        Action::Many(actions)
    }

    fn summary(&self, ui: &Ui, width: u16) -> Vec<Line<'static>> {
        let on = |k: &str| if config::flag(&self.current, k) { "on" } else { "off" };
        let shown = |k: &str| config::field(k).map(|f| f.display(&f.get(&self.current))).unwrap_or_default();
        let mut lines = vec![Line::from(Span::styled("These are your choices. Configuration changes any of them later.", fg(TEXT2))), Line::default()];
        lines.extend(status_lines(
            &[
                row("Fast Boot", on("startup.fast_boot")),
                row("Whole film", on("startup.force_animate")),
                row("Narration", shown("narration.mode")),
                row("Music", on("presentation.music")),
                row("Full screen", on("presentation.fullscreen")),
                row("Map frame rate", shown("performance.map_fps")),
                row("Render scale", shown("performance.render_scale")),
                row("Film particles", shown("performance.film_particles")),
                row("Applications", on("fabric.applications")),
                row("WebFabric", on("webfabric.enabled")),
                row("Legacy API", on("fabric.legacy_api")),
                row("MCP Handler", format!("{}{}", on("mcp.enabled"), if config::flag(&self.current, "mcp.allow_writes") { ", changes allowed" } else { "" })),
                row("Server", format!("{}:{}", shown("api.host"), shown("api.port"))),
            ],
            18,
            width,
            ui.unicode,
        ));
        if config::flag(&self.current, "startup.fast_boot") {
            let (count, _) = crate::modules::fastboot::here(&ui.paths);
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                if count == 0 { "Fast Boot has no cities yet: download them now, or later under Demo and Fast Boot.".to_string() } else { format!("Fast Boot has {count} cities.") },
                fg(if count == 0 { WARN } else { OK }),
            )));
        }
        lines
    }
}

impl Screen for SetupScreen {
    fn title(&self) -> String {
        format!("Setup · {} of {}", self.step + 1, STEPS.len())
    }
    fn path(&self) -> String {
        "/setup".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Tab", "Next field", "Next", true), key("Enter", "Choose", "Choose", true), key("Ctrl+N", "Next page", "Next", false), key("Esc", "Back", "Back", true)]
    }
    fn state(&self) -> Option<(State, String)> {
        Some((State::Running, "setting up".into()))
    }
    fn typing(&self) -> bool {
        !self.in_actions && self.forms[self.step].focused().map(|r| matches!(r.editor, Editor::Text { .. })).unwrap_or(false)
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let outer = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
        let step = &STEPS[self.step];
        let block = card(step.title, true);
        let inner = block.inner(outer);
        frame.render_widget(block, outer);
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        // Where it is: a dot for each page.
        let dots: Vec<Span> = (0..STEPS.len())
            .map(|i| Span::styled(if ui.unicode { if i == self.step { "● " } else { "○ " } } else if i == self.step { "* " } else { "o " }, fg(if i <= self.step { CYAN } else { MUTED })))
            .collect();
        let mut head = vec![Line::from(dots), Line::default()];
        if self.step == 0 {
            let logo = widgets::wordmark(inner, ui.unicode);
            if inner.height > 24 {
                head.extend(logo.lines);
                head.push(Line::default());
            }
            head.push(Line::from(Span::styled("Welcome to DSTNS.", bold(TEXT))));
            head.push(Line::default());
            for piece in widgets::wrap(
                "A few choices, then you're set: how a run starts, how it looks and sounds, how hard it works your machine, and what may connect to it. Each has a sensible default, and Configuration changes any of them later.",
                inner.width as usize,
            ) {
                head.push(Line::from(Span::styled(piece, fg(TEXT2))));
            }
            head.push(Line::default());
            if let Some(checks) = &ui.checks {
                let failed = environment::blocking(checks).len();
                let warnings = checks.iter().filter(|c| c.outcome.state == State::Warning).count();
                head.push(Line::from(Span::styled(
                    if failed > 0 {
                        format!("This machine: {failed} required check(s) failed; Diagnostics says what to do.")
                    } else if warnings > 0 {
                        format!("This machine is ready, with {warnings} thing(s) to look at in Diagnostics.")
                    } else {
                        format!("This machine is ready: {} checks passed.", checks.len())
                    },
                    fg(if failed > 0 { ERR } else if warnings > 0 { WARN } else { OK }),
                )));
            }
        } else if self.step + 1 == STEPS.len() {
            head.extend(self.summary(ui, inner.width));
        } else {
            for piece in widgets::wrap(step.intro, inner.width as usize) {
                head.push(Line::from(Span::styled(piece, fg(TEXT2))));
            }
        }
        head.push(Line::default());
        let head_height = head.len() as u16;
        frame.render_widget(Paragraph::new(head), Rect { height: head_height.min(inner.height), ..inner });
        let actions_height = self.actions.items.len() as u16 + 1;
        let error_height = if self.error.is_empty() { 0 } else { 1 };
        let form_area = Rect { y: inner.y + head_height, height: inner.height.saturating_sub(head_height + actions_height + error_height), ..inner };
        let in_actions = self.in_actions;
        self.forms[self.step].render(frame, form_area, !in_actions, ui.unicode, 28);
        if !self.error.is_empty() {
            frame.render_widget(Paragraph::new(Span::styled(self.error.clone(), fg(ERR))), Rect { y: inner.y + inner.height.saturating_sub(actions_height + 1), height: 1, ..inner });
        }
        self.actions.render(frame, Rect { y: inner.y + inner.height.saturating_sub(actions_height) + 1, height: actions_height.saturating_sub(1), ..inner }, in_actions, ui.unicode);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        if event.modifiers.contains(KeyModifiers::CONTROL) && event.code == KeyCode::Char('n') {
            return self.choose("next", ui);
        }
        if self.in_actions {
            match event.code {
                KeyCode::Tab | KeyCode::BackTab if !self.forms[self.step].rows.is_empty() => {
                    self.in_actions = false;
                    return Action::None;
                }
                KeyCode::Up if self.actions.index == 0 && !self.forms[self.step].rows.is_empty() => {
                    self.in_actions = false;
                    return Action::None;
                }
                _ => {}
            }
            if let MenuEvent::Selected(choice) = self.actions.handle(&event) {
                return self.choose(&choice, ui);
            }
            return Action::None;
        }
        match event.code {
            KeyCode::Tab | KeyCode::Down => {
                if !self.forms[self.step].move_focus(1) {
                    self.in_actions = true;
                }
            }
            KeyCode::BackTab | KeyCode::Up => {
                self.forms[self.step].move_focus(-1);
            }
            KeyCode::Enter if matches!(self.forms[self.step].focused().map(|r| &r.editor), Some(Editor::Text { .. })) => {
                if !self.forms[self.step].move_focus(1) {
                    self.in_actions = true;
                }
            }
            _ => {
                if let Some(key) = self.forms[self.step].handle(&event) {
                    self.apply(&key);
                }
            }
        }
        Action::None
    }
    fn dialog(&mut self, id: &str, choice: &str, ui: &mut Ui) -> Action {
        if id == "skip" && choice == "yes" {
            let _ = crate::setup::complete(&ui.paths);
            let mut actions = vec![Action::Pop];
            if let Some(then) = self.then.clone() {
                actions.push(super::initial_page(&then, ui));
            }
            return Action::Many(actions);
        }
        Action::None
    }
    fn back(&mut self, ui: &mut Ui) -> Action {
        if self.step > 0 {
            return self.choose("back", ui);
        }
        self.choose("skip", ui)
    }
}

impl SetupScreen {
    fn choose(&mut self, choice: &str, ui: &mut Ui) -> Action {
        self.error.clear();
        match choice {
            "next" if self.step + 1 < STEPS.len() => {
                if self.invalid() {
                    self.error = "Correct the highlighted values first.".into();
                    return Action::None;
                }
                self.step += 1;
                self.set_actions();
            }
            "back" if self.step > 0 => {
                self.step -= 1;
                self.set_actions();
            }
            "finish" => return self.finish(ui, false),
            "download" => return self.finish(ui, true),
            "skip" => {
                return Action::Dialog(Dialog::confirm(
                    "skip",
                    "Skip the setup?",
                    "The defaults stay as they are, and the setup won't open by itself again. ./launcher setup, or setup in the command bar, opens it.",
                    "Skip it",
                    "Keep going",
                ))
            }
            _ => {}
        }
        Action::None
    }
}
