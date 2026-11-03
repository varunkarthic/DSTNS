// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The start-up: the wordmark assembling itself out of particles, a sweep of light across it, the product's name typed
//! out, and the real start-up checks scrolling by as a boot log, with a short readable hold.
//!
//! The particles are the observer's film, as far as a terminal goes: each cell of the wordmark starts somewhere on the
//! screen and flies in, drawn as a dot until it lands, when it becomes the glyph it is. Reduced motion shows the end.

use crate::environment::{self, Check, State};
use crate::tui::theme::{self, bold, fg, ACCENT, GLOW, MUTED, NAVY, TEAL, TEXT, TEXT2};
use crate::tui::widgets::{self, Key};
use crate::tui::{Action, Screen, Ui};
use crate::version::{engine_version, FULL_NAME, LICENSE_SPDX};
use crossterm::event::KeyEvent;
use ratatui::layout::{Alignment, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

/// Long enough for the whole sequence to be seen: the particles land, the light passes, the name is typed, and the
/// boot log reads out. The checks run meanwhile, and it waits for them if they take longer.
const MINIMUM: Duration = Duration::from_millis(3400);

pub struct SplashScreen {
    initial: String,
    items: Vec<Check>,
    updates: Receiver<(Vec<Check>, bool)>,
    started: Instant,
    finished: Option<Instant>,
    detail: String,
    /// When each check settled, for the boot log.
    settled_at: std::collections::HashMap<&'static str, f64>,
}

impl SplashScreen {
    pub fn new(initial: &str) -> Self {
        let (sender, updates) = channel();
        let paths = crate::paths::Paths::default();
        std::thread::spawn(move || {
            let notify = sender.clone();
            let items = environment::run_checks(environment::checks(false), &paths, move |items| {
                let _ = notify.send((items.to_vec(), false));
            });
            let _ = sender.send((items, true));
        });
        Self { initial: initial.into(), items: environment::checks(false), updates, started: Instant::now(), finished: None, detail: String::new(), settled_at: Default::default() }
    }
}

impl Screen for SplashScreen {
    fn title(&self) -> String {
        String::new()
    }
    fn path(&self) -> String {
        "/splash".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        vec![]
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let t = if ui.motion { self.started.elapsed().as_secs_f64() } else { 99.0 };
        let content = Rect { x: area.x + area.width.saturating_sub(80.min(area.width)) / 2, width: 80.min(area.width), ..area };
        let logo = widgets::wordmark(Rect { height: if area.height >= 24 { 7 } else if area.height >= 20 { 5 } else { 1 }, ..content }, ui.unicode);
        let logo_lines: Vec<String> = logo.lines.iter().map(|l| l.to_string()).collect();
        let logo_width = logo_lines.iter().map(|l| widgets::width(l)).max().unwrap_or(0) as u16;
        let complete = self.items.iter().filter(|c| !matches!(c.outcome.state, State::Pending | State::Running)).count();
        let blocking = environment::blocking(&self.items).len();
        let label = match self.finished {
            None => format!("boot: checks {complete}/{}", self.items.len()),
            Some(_) if blocking > 0 => format!("boot: {blocking} required check(s) need attention"),
            Some(_) => "boot: complete".into(),
        };
        // The boot log: each check as it settles, with when.
        let settled: Vec<&environment::Check> = self.items.iter().filter(|c| !matches!(c.outcome.state, State::Pending | State::Running)).collect();
        let log_rows = 6usize.min(area.height.saturating_sub(logo_lines.len() as u16 + 10) as usize);
        let height = logo_lines.len() as u16 + 6 + log_rows as u16 + 2;
        let top = area.y + area.height.saturating_sub(height) / 2;
        let left = content.x + content.width.saturating_sub(logo_width) / 2;

        // The wordmark, assembling.
        let buffer = frame.buffer_mut();
        let mut index = 0usize;
        for (row, line) in logo_lines.iter().enumerate() {
            for (column, ch) in line.chars().enumerate() {
                index += 1;
                if ch == ' ' {
                    continue;
                }
                let (tx, ty) = (left + column as u16, top + row as u16);
                // Where it comes from, the same each time, and when it sets off: left to right, a little apart.
                let hash = (index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0x51ED_270B;
                let (sx, sy) = ((hash % area.width.max(1) as u64) as f64, ((hash >> 20) % area.height.max(1) as u64) as f64);
                // They appear as dust first, then set off left to right, a little apart.
                let appear = ((hash >> 30) % 100) as f64 / 100.0 * 0.4;
                let delay = 0.3 + column as f64 / logo_width.max(1) as f64 * 0.55 + ((hash >> 40) % 100) as f64 / 100.0 * 0.25;
                let progress = ((t - delay) / 0.9).clamp(0.0, 1.0);
                let eased = 1.0 - (1.0 - progress).powi(3);
                if progress <= 0.0 {
                    // Waiting: a faint dot where it is, once it has appeared.
                    if t >= appear {
                        let cell = &mut buffer[(sx as u16 + area.x, sy as u16 + area.y)];
                        if cell.symbol() == " " {
                            cell.set_symbol(if ui.unicode { "·" } else { "." }).set_style(fg(if t - appear < 0.15 { TEAL } else { NAVY }));
                        }
                    }
                    continue;
                }
                if progress < 1.0 {
                    // In flight, on a curve: drawn aside from the straight line, most in the middle of the way.
                    let (dx, dy) = (tx as f64 - area.x as f64 - sx, ty as f64 - area.y as f64 - sy);
                    let length = (dx * dx + dy * dy).sqrt().max(1.0);
                    let bend = (progress * std::f64::consts::PI).sin() * (6.0 + ((hash >> 50) % 6) as f64) * if hash & 1 == 0 { 1.0 } else { -1.0 };
                    let x = (sx + dx * eased - dy / length * bend).round();
                    let y = (sy + dy * eased + dx / length * bend * 0.5).round();
                    if x >= 0.0 && y >= 0.0 && (x as u16) < area.width && (y as u16) < area.height {
                        let symbol = if !ui.unicode { "*" } else if progress > 0.75 { "•" } else if progress > 0.35 { "∙" } else { "·" };
                        buffer[(x as u16 + area.x, y as u16 + area.y)].set_symbol(symbol).set_style(fg(if progress > 0.6 { ACCENT } else { TEAL }));
                    }
                    continue;
                }
                // Landed. Then a band of light passes across, once, and settles.
                let sweep = (t - 1.75) / 0.9 * (logo_width as f64 + 14.0) - 7.0;
                let near = (column as f64 - sweep).abs();
                let tone = if (1.75..=2.65).contains(&t) && near < 3.5 { GLOW } else { ACCENT };
                if tx < area.x + area.width && ty < area.y + area.height {
                    buffer[(tx, ty)].set_symbol(&ch.to_string()).set_style(bold(tone));
                }
            }
        }

        // The name, typed out, with a cursor while it types.
        let name = FULL_NAME.to_uppercase();
        let typed = (((t - 1.1) / 1.2).clamp(0.0, 1.0) * name.chars().count() as f64) as usize;
        let mut shown: String = name.chars().take(typed).collect();
        if typed < name.chars().count() && (t * 3.0) as i64 % 2 == 0 {
            shown.push(if ui.unicode { '▌' } else { '_' });
        }
        let mut lines: Vec<Line> = vec![Line::from(Span::styled(shown, bold(TEXT))), Line::default()];
        // How far start-up has got: the checks done, and no faster than the sequence itself.
        let share = (complete as f64 / self.items.len().max(1) as f64).min(t / MINIMUM.as_secs_f64());
        lines.push(Line::from(vec![
            Span::styled(format!("v{}", engine_version()), fg(TEXT2)),
            Span::styled(if ui.unicode { "  ·  " } else { "  -  " }, fg(MUTED)),
            Span::styled(label, fg(ACCENT)),
            Span::styled(if ui.unicode { "  ·  " } else { "  -  " }, fg(MUTED)),
            Span::styled(widgets::bar(share, 14, ui.unicode), fg(if share >= 1.0 { TEXT2 } else { ACCENT })),
        ]));
        lines.push(Line::from(Span::styled(self.detail.clone(), fg(MUTED))));
        lines.push(Line::default());
        lines.push(Line::default());
        // The boot log: one block, left-aligned within it, the block itself centred.
        let mut log: Vec<Line> = vec![];
        let start = settled.len().saturating_sub(log_rows);
        for (row, check) in settled[start..].iter().enumerate() {
            // The log reads out a line at a time once the name is up, however quickly the checks were done.
            if t < 2.1 + row as f64 * 0.16 {
                continue;
            }
            let (fancy, plain, _) = check.outcome.state.marker();
            log.push(Line::from(vec![
                Span::styled(format!("[{:>7.3}] ", self.settled_at.get(check.key).copied().unwrap_or(0.0)), fg(MUTED)),
                Span::styled(format!("{} ", if ui.unicode { fancy } else { plain }), fg(theme::tone(check.outcome.state))),
                Span::styled(format!("{:<19}", widgets::clip(check.name, 17, ui.unicode)), fg(TEXT2)),
                Span::styled(widgets::clip(&check.outcome.value, 38, ui.unicode), fg(MUTED)),
            ]));
        }
        while log.len() < log_rows {
            log.push(Line::default());
        }
        let copyright = if ui.unicode { "© 2026 Varun Karthic" } else { "(C) 2026 Varun Karthic" };
        let footer = Line::from(Span::styled(format!("{copyright}{}{LICENSE_SPDX}", if ui.unicode { " · " } else { " - " }), fg(MUTED)));
        let y = top + logo_lines.len() as u16 + 1;
        let bottom = area.y + area.height;
        let head = lines.len() as u16;
        frame.render_widget(Paragraph::new(lines).alignment(Alignment::Center), Rect { y, height: head.min(bottom.saturating_sub(y)), ..content });
        let log_width = 72.min(content.width);
        let log_y = y + head;
        if log_y < bottom {
            let rect = Rect { x: content.x + (content.width - log_width) / 2, y: log_y, width: log_width, height: (log.len() as u16).min(bottom - log_y) };
            frame.render_widget(Paragraph::new(log), rect);
        }
        let footer_y = log_y + log_rows as u16 + 1;
        if footer_y < bottom {
            frame.render_widget(Paragraph::new(footer).alignment(Alignment::Center), Rect { y: footer_y, height: 1, ..content });
        }
    }
    fn key(&mut self, _event: KeyEvent, _ui: &mut Ui) -> Action {
        Action::None
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        while let Ok((items, done)) = self.updates.try_recv() {
            if let Some(changed) = items.iter().find(|c| !matches!(c.outcome.state, State::Pending)) {
                let last = items.iter().filter(|c| !matches!(c.outcome.state, State::Pending)).last().unwrap_or(changed);
                self.detail = format!("{}: {}", last.name, last.outcome.state.marker().2);
            }
            let elapsed = self.started.elapsed().as_secs_f64();
            for check in items.iter().filter(|c| !matches!(c.outcome.state, State::Pending | State::Running)) {
                self.settled_at.entry(check.key).or_insert(elapsed);
            }
            self.items = items;
            if done {
                self.finished = Some(Instant::now());
                ui.checks = Some(self.items.clone());
                self.detail = if environment::blocking(&self.items).is_empty() { "Opening dashboard".into() } else { "Opening check results".into() };
            }
        }
        // The reading time overlaps the real checks; nothing waits once both are done.
        if self.finished.is_some() && self.started.elapsed() >= MINIMUM {
            if !environment::blocking(&self.items).is_empty() {
                return Action::Replace(Box::new(super::environment::EnvironmentScreen::new(Some(self.items.clone()), &self.initial)));
            }
            let initial = self.initial.clone();
            return super::after_environment(&initial, ui);
        }
        Action::None
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        Action::None
    }
}
