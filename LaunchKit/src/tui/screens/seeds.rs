// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Saved seeds: start, inspect or delete a saved configuration.

use crate::config::RunOptions;
use crate::tui::theme::{fg, ERR, TEXT2};
use crate::tui::widgets::{self, card, item, key, row, status_lines, Key, Menu, MenuEvent};
use crate::tui::{Action, Dialog, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use serde_json::{json, Value};

pub struct SeedsScreen {
    menu: Menu,
    error: String,
}

impl SeedsScreen {
    pub fn new(ui: &Ui) -> Self {
        let mut screen = Self { menu: Menu::default(), error: String::new() };
        screen.reload(ui);
        screen
    }
    fn reload(&mut self, ui: &Ui) {
        match crate::seeds::operate("list", &json!({}), &ui.paths) {
            Ok(list) => {
                let ids: Vec<String> = list.as_array().cloned().unwrap_or_default().iter().filter_map(|r| r["id"].as_str().map(String::from)).collect();
                self.menu.set_items(ids.iter().map(|id| item(id, id)).collect());
            }
            Err(error) => self.error = error.message,
        }
    }
}

impl Screen for SeedsScreen {
    fn title(&self) -> String {
        "Saved Seeds".into()
    }
    fn path(&self) -> String {
        "/seeds".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Enter", "Start", "Start", true), key("d", "Delete", "Delete", false), key("Esc", "Back", "Back", true)]
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let (side, content) = widgets::columns(area, widgets::list_width(&self.menu, area, ui.layout == crate::terminal::Layout::Medium), ui.small(), (self.menu.items.len() as u16 + 1).max(3));
        let block = card("Saved", true);
        let inner = block.inner(side);
        frame.render_widget(block, side);
        self.menu.render(frame, inner, true, ui.unicode);
        let block = card(&self.menu.current_key().unwrap_or_else(|| "No saved seeds".into()), false);
        let inner = block.inner(content);
        frame.render_widget(block, content);
        let inner = Rect { x: inner.x + 2, width: inner.width.saturating_sub(4), ..inner };
        let mut lines = vec![Line::default()];
        if !self.error.is_empty() {
            lines.push(Line::from(Span::styled(self.error.clone(), fg(ERR))));
        }
        match self.menu.current_key() {
            None => {
                lines.push(Line::from(Span::styled("Save a configuration from Start simulation (Save as), or with", fg(TEXT2))));
                lines.push(Line::from(Span::styled("./launcher start --seed N --save-seed ID", fg(TEXT2))));
            }
            Some(id) => match crate::seeds::operate("inspect", &json!({"id": id}), &ui.paths) {
                Err(error) => lines.push(Line::from(Span::styled(error.message, fg(ERR)))),
                Ok(record) => {
                    let config: &Value = &record["config"];
                    let osm = config.pointer("/map/osm_file").and_then(|v| v.as_str()).unwrap_or("auto");
                    let created = record["created_at"].as_str().unwrap_or("").chars().take(19).collect::<String>().replace('T', " ");
                    lines.extend(status_lines(
                        &[
                            row("Seed", record["seed"].as_str().unwrap_or("")),
                            row("Day", if config["day"] == json!(1) { "weekend" } else { "weekday" }),
                            row("Speed", format!("{}x", config.get("tick_rate").map(|v| v.to_string()).unwrap_or_else(|| "1".into()))),
                            row("Map", if osm == "auto" { "chosen by the seed" } else { "pinned copy (verified on start)" }),
                            row("Created", format!("{created} UTC")),
                            row("Description", record["description"].as_str().filter(|d| !d.is_empty()).unwrap_or("-")),
                        ],
                        16,
                        inner.width,
                        ui.unicode,
                    ));
                    lines.push(Line::default());
                    lines.push(Line::from(Span::styled("Enter starts this configuration; d deletes it.", fg(TEXT2))));
                }
            },
        }
        frame.render_widget(Paragraph::new(lines).wrap(ratatui::widgets::Wrap { trim: false }), inner);
    }
    fn key(&mut self, event: KeyEvent, _ui: &mut Ui) -> Action {
        if matches!(event.code, KeyCode::Char('d') | KeyCode::Delete) {
            if let Some(id) = self.menu.current_key() {
                return Action::Dialog(Dialog::confirm("delete", "Delete saved seed?", &format!("Delete {id}? Map copies it used are kept."), "Delete", "Cancel"));
            }
        }
        if let MenuEvent::Selected(id) = self.menu.handle(&event) {
            return Action::Replace(Box::new(super::running::RunningScreen::new(Some(RunOptions { saved_seed: Some(id), ..Default::default() }))));
        }
        Action::None
    }
    fn dialog(&mut self, id: &str, choice: &str, ui: &mut Ui) -> Action {
        if id == "delete" && choice == "yes" {
            if let Some(seed) = self.menu.current_key() {
                let outcome = crate::seeds::operate("delete", &json!({"id": seed}), &ui.paths);
                self.reload(ui);
                return match outcome {
                    Ok(_) => Action::Toast(format!("Deleted {seed}"), crate::tui::theme::OK),
                    Err(error) => Action::Toast(error.message, ERR),
                };
            }
        }
        Action::None
    }
}
