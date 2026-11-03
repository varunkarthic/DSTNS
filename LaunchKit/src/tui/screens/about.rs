// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! About: version, copyright, licence and map-data attribution.

use crate::tui::theme::{bold, fg, MUTED, TEXT, TEXT2};
use crate::tui::widgets::{self, key, row, status_lines, Key};
use crate::tui::{Action, Screen, Ui};
use crate::version::{engine_version, observer_version, DOCUMENTATION, FULL_NAME, LICENSE_NAME, LICENSE_SPDX, OSM_LICENSE, REPOSITORY};
use crossterm::event::KeyEvent;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

pub struct AboutScreen;

impl Screen for AboutScreen {
    fn title(&self) -> String {
        "About".into()
    }
    fn path(&self) -> String {
        "/about".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![key("Esc", "Back", "Back", true)]
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let body = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
        let mut lines = vec![Line::default()];
        lines.extend(widgets::wordmark(body, ui.unicode).lines);
        lines.push(Line::from(Span::styled(FULL_NAME, bold(TEXT))));
        lines.push(widgets::rule("", body.width, ui.unicode));
        lines.extend(status_lines(
            &[
                row("Version", engine_version()),
                row("Observer", observer_version()),
                row("Copyright", if ui.unicode { "Copyright © 2026 Varun Karthic" } else { "Copyright (C) 2026 Varun Karthic" }),
                row("Licence", LICENSE_NAME),
                row("SPDX", LICENSE_SPDX),
            ],
            12,
            body.width,
            ui.unicode,
        ));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Map data", bold(TEXT2))));
        lines.push(Line::from(Span::styled(if ui.unicode { "© OpenStreetMap contributors" } else { "(C) OpenStreetMap contributors" }, fg(TEXT))));
        lines.push(Line::from(Span::styled("OpenStreetMap data is available under the", fg(TEXT2))));
        lines.push(Line::from(Span::styled(format!("{OSM_LICENSE}."), fg(TEXT2))));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Project", bold(TEXT2))));
        lines.extend(status_lines(&[row("Source", REPOSITORY), row("Documentation", DOCUMENTATION)], 14, body.width, ui.unicode));
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("This program comes with ABSOLUTELY NO WARRANTY. It is free software, and you are welcome", fg(MUTED))));
        lines.push(Line::from(Span::styled("to redistribute it under the terms of the licence; see LICENSE.", fg(MUTED))));
        frame.render_widget(Paragraph::new(lines), body);
    }
    fn key(&mut self, _event: KeyEvent, _ui: &mut Ui) -> Action {
        Action::None
    }
}
