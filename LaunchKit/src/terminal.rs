// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! What the terminal can do: size, colour depth, Unicode, interactivity. Detection is conservative: a plain interface
//! that works beats a rich one that renders as garbage.

use std::env;
use std::io::IsTerminal;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Colors {
    TrueColor,
    Extended,
    Standard,
    None,
}

impl Colors {
    pub fn name(self) -> &'static str {
        match self {
            Colors::TrueColor => "truecolor",
            Colors::Extended => "256",
            Colors::Standard => "16",
            Colors::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    Large,
    Medium,
    Small,
    TooSmall,
}

impl Layout {
    pub fn name(self) -> &'static str {
        match self {
            Layout::Large => "large",
            Layout::Medium => "medium",
            Layout::Small => "small",
            Layout::TooSmall => "too-small",
        }
    }
}

/// Breakpoints, in character cells.
pub const LARGE: (u16, u16) = (100, 30);
pub const MEDIUM: (u16, u16) = (70, 22);
pub const MINIMUM: (u16, u16) = (50, 15);

pub fn layout_for(width: u16, height: u16) -> Layout {
    if width < MINIMUM.0 || height < MINIMUM.1 {
        Layout::TooSmall
    } else if width >= LARGE.0 && height >= LARGE.1 {
        Layout::Large
    } else if width >= MEDIUM.0 && height >= MEDIUM.1 {
        Layout::Medium
    } else {
        Layout::Small
    }
}

#[derive(Clone, Debug)]
pub struct Capabilities {
    pub interactive: bool,
    pub width: u16,
    pub height: u16,
    pub colors: Colors,
    pub unicode: bool,
    pub term: String,
}

impl Capabilities {
    pub fn summary(&self) -> String {
        format!(
            "{}, {}x{}, colour {}, {}, TERM={}",
            if self.interactive { "interactive" } else { "non-interactive" },
            self.width,
            self.height,
            self.colors.name(),
            if self.unicode { "unicode" } else { "ascii" },
            if self.term.is_empty() { "unset" } else { &self.term }
        )
    }
}

pub fn detect(no_color: bool) -> Capabilities {
    let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let (width, height) = crossterm::terminal::size().unwrap_or((80, 24));
    let term = env::var("TERM").unwrap_or_default();
    // https://no-color.org: any non-empty NO_COLOR disables colour.
    let colors = if no_color || env::var("NO_COLOR").map(|v| !v.is_empty()).unwrap_or(false) || term == "dumb" || !interactive {
        Colors::None
    } else {
        let colorterm = env::var("COLORTERM").unwrap_or_default().to_lowercase();
        if colorterm == "truecolor" || colorterm == "24bit" || env::var_os("WT_SESSION").is_some() {
            Colors::TrueColor
        } else if term.contains("256color") {
            Colors::Extended
        } else {
            Colors::Standard
        }
    };
    let locale = ["LC_ALL", "LC_CTYPE", "LANG"].iter().filter_map(|k| env::var(k).ok()).find(|v| !v.is_empty()).unwrap_or_default().to_lowercase();
    // A terminal on macOS speaks UTF-8 whatever the locale says; elsewhere, trust the locale.
    let unicode = locale.contains("utf") || (cfg!(target_os = "macos") && locale.is_empty());
    Capabilities { interactive, width, height, colors, unicode, term }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_follow_the_breakpoints() {
        assert_eq!(layout_for(160, 45), Layout::Large);
        assert_eq!(layout_for(80, 24), Layout::Medium);
        assert_eq!(layout_for(60, 18), Layout::Small);
        assert_eq!(layout_for(49, 30), Layout::TooSmall);
    }
}
