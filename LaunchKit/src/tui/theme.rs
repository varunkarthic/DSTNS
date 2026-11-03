// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The same design as the observer, as far as a terminal goes: its colours, its quiet surfaces, one rounded card for
//! one thing, a line between things rather than a box around each, and plain words. Meaning never depends on colour;
//! every state also has a symbol and a word. Colours are given as the terminal can show them: true colour where it
//! can, else the nearest of 256 or 16, else none.

use crate::environment::State;
use crate::terminal::Colors;
use ratatui::style::{Color, Modifier, Style};
use std::sync::atomic::{AtomicU8, Ordering};

static DEPTH: AtomicU8 = AtomicU8::new(0);

pub fn set_depth(colors: Colors) {
    DEPTH.store(
        match colors {
            Colors::TrueColor => 0,
            Colors::Extended => 1,
            Colors::Standard => 2,
            Colors::None => 3,
        },
        Ordering::SeqCst,
    );
}

pub fn colourless() -> bool {
    DEPTH.load(Ordering::SeqCst) == 3
}

pub const BG: u32 = 0x071420;
pub const SURFACE: u32 = 0x0D1C28;
pub const SURFACE_ALT: u32 = 0x122431;
pub const KEYCAP: u32 = 0x1A2F3E;
pub const CYAN: u32 = 0x37D7FF;
pub const TEAL: u32 = 0x1E7C8F;
pub const NAVY: u32 = 0x243B4C;
pub const TEXT: u32 = 0xE6F0F7;
pub const TEXT2: u32 = 0x93A8B6;
pub const MUTED: u32 = 0x5F7685;
pub const OK: u32 = 0x5EE3BF;
pub const WARN: u32 = 0xF0AA2E;
pub const ERR: u32 = 0xEF5A64;

fn cube(value: u8) -> u8 {
    if value < 48 {
        0
    } else if value < 115 {
        1
    } else {
        (value - 35) / 40
    }
}

/// The nearest of the 256 colours: the 6x6x6 cube or the grey ramp, whichever is closer.
fn indexed(r: u8, g: u8, b: u8) -> u8 {
    let level = |i: u8| if i == 0 { 0 } else { 55 + i * 40 };
    let (cr, cg, cb) = (cube(r), cube(g), cube(b));
    let cube_index = 16 + 36 * cr + 6 * cg + cb;
    let cube_distance = (r as i32 - level(cr) as i32).pow(2) + (g as i32 - level(cg) as i32).pow(2) + (b as i32 - level(cb) as i32).pow(2);
    let grey = ((r as u32 + g as u32 + b as u32) / 3) as u8;
    let grey_step = if grey < 8 { 0 } else { ((grey - 8) / 10).min(23) };
    let grey_level = 8 + grey_step * 10;
    let grey_distance = (r as i32 - grey_level as i32).pow(2) + (g as i32 - grey_level as i32).pow(2) + (b as i32 - grey_level as i32).pow(2);
    if grey_distance < cube_distance {
        232 + grey_step
    } else {
        cube_index
    }
}

fn basic(rgb: u32) -> Color {
    match rgb {
        BG | SURFACE | SURFACE_ALT | KEYCAP => Color::Reset,
        CYAN | TEAL => Color::Cyan,
        NAVY | MUTED => Color::DarkGray,
        TEXT => Color::White,
        TEXT2 => Color::Gray,
        OK => Color::Green,
        WARN => Color::Yellow,
        ERR => Color::Red,
        _ => Color::Reset,
    }
}

pub fn c(rgb: u32) -> Color {
    let (r, g, b) = ((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8);
    match DEPTH.load(Ordering::SeqCst) {
        0 => Color::Rgb(r, g, b),
        1 => Color::Indexed(indexed(r, g, b)),
        2 => basic(rgb),
        _ => Color::Reset,
    }
}

pub fn fg(rgb: u32) -> Style {
    Style::default().fg(c(rgb))
}

pub fn bold(rgb: u32) -> Style {
    fg(rgb).add_modifier(Modifier::BOLD)
}

pub fn base() -> Style {
    Style::default().fg(c(TEXT)).bg(c(BG))
}

pub fn tone(state: State) -> u32 {
    match state {
        State::Pass => OK,
        State::Warning => WARN,
        State::Fail => ERR,
        State::Running => CYAN,
        State::Skipped | State::Pending => MUTED,
    }
}

/// The selected item: reversed where colour can't show it, so it is never colour alone.
pub fn selected(focused: bool) -> Style {
    if colourless() {
        return Style::default().add_modifier(Modifier::REVERSED | Modifier::BOLD);
    }
    if focused {
        Style::default().fg(c(BG)).bg(c(CYAN)).add_modifier(Modifier::BOLD)
    } else {
        bold(CYAN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_come_down_to_what_the_terminal_shows() {
        assert_eq!(indexed(0, 0, 0), 16);
        assert_eq!(indexed(255, 255, 255), 231);
        let cyan = indexed(0x37, 0xD7, 0xFF);
        assert!((16..232).contains(&cyan));
        assert_eq!(basic(OK), Color::Green);
    }
}
