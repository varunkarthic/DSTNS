// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Line-oriented output, for scripted commands and for compatibility mode. Meaning is always carried by words and
//! markers such as `[OK]`; colour, when the terminal has it, only reinforces it.

use crate::environment::State;
use crate::reporting::{Level, Reporter};
use crate::terminal::{Capabilities, Colors};
use std::io::{self, BufRead, Write};
use std::sync::Mutex;
use std::time::Instant;

const WIDTH: usize = 60;

fn state_mark(state: State) -> &'static str {
    match state {
        State::Pass => "[OK]",
        State::Warning => "[WARN]",
        State::Fail => "[ERROR]",
        State::Skipped => "[SKIP]",
        State::Running => "[....]",
        State::Pending => "[    ]",
    }
}

fn level_mark(level: Level) -> &'static str {
    match level {
        Level::Info => "[INFO]",
        Level::Success => "[OK]",
        Level::Warning => "[WARN]",
        Level::Error => "[ERROR]",
    }
}

#[derive(Clone, Copy)]
pub enum Tone {
    Heading,
    Ok,
    Warn,
    Error,
    Muted,
    Accent,
}

fn tone_code(tone: Tone) -> &'static str {
    match tone {
        Tone::Heading => "36;1",
        Tone::Ok => "32",
        Tone::Warn => "33",
        Tone::Error => "31",
        Tone::Muted => "90",
        Tone::Accent => "36",
    }
}

fn state_tone(state: State) -> Tone {
    match state {
        State::Pass => Tone::Ok,
        State::Warning => Tone::Warn,
        State::Fail => Tone::Error,
        State::Running => Tone::Accent,
        _ => Tone::Muted,
    }
}

fn level_tone(level: Level) -> Tone {
    match level {
        Level::Info => Tone::Accent,
        Level::Success => Tone::Ok,
        Level::Warning => Tone::Warn,
        Level::Error => Tone::Error,
    }
}

/// Plain text, with ANSI colour when the terminal supports it.
pub struct Output {
    pub caps: Capabilities,
    pub color: bool,
    pub width: usize,
}

impl Output {
    pub fn new(caps: &Capabilities) -> Self {
        Self {
            caps: caps.clone(),
            color: caps.colors != Colors::None,
            width: (caps.width as usize).saturating_sub(2).clamp(40, WIDTH),
        }
    }

    pub fn paint(&self, text: &str, tone: Option<Tone>) -> String {
        match tone {
            Some(tone) if self.color => format!("\x1b[{}m{text}\x1b[0m", tone_code(tone)),
            _ => text.to_string(),
        }
    }

    pub fn write(&self, text: &str) {
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{text}");
        let _ = out.flush();
    }

    pub fn blank(&self) {
        self.write("");
    }

    pub fn rule(&self) {
        self.write(&format!(" {}", self.paint(&"-".repeat(self.width - 1), Some(Tone::Muted))));
    }

    pub fn banner(&self, title: &str, subtitle: &str) {
        self.write(&self.paint(&"=".repeat(self.width), Some(Tone::Muted)));
        self.write(&format!(" {}", self.paint(title, Some(Tone::Heading))));
        if !subtitle.is_empty() {
            self.write(&format!(" {subtitle}"));
        }
        self.write(&self.paint(&"=".repeat(self.width), Some(Tone::Muted)));
    }

    pub fn heading(&self, text: &str) {
        self.blank();
        self.write(&format!(" {}", self.paint(text, Some(Tone::Heading))));
    }

    pub fn line(&self, text: &str) {
        self.write(&format!(" {text}"));
    }

    pub fn toned(&self, text: &str, tone: Tone) {
        self.write(&format!(" {}", self.paint(text, Some(tone))));
    }

    pub fn muted(&self, text: &str) {
        self.toned(text, Tone::Muted);
    }

    pub fn status(&self, state: State, name: &str, value: &str, width: usize) {
        let mark = format!("{:<7}", state_mark(state));
        let line = format!(" {} {:<width$} {value}", self.paint(&mark, Some(state_tone(state))), name);
        self.write(line.trim_end());
    }

    pub fn message(&self, level: Level, text: &str, detail: &str) {
        let mark = self.paint(&format!("{:<7}", level_mark(level)), Some(level_tone(level)));
        let suffix = if detail.is_empty() { String::new() } else { format!("  {}", self.paint(detail, Some(Tone::Muted))) };
        self.write(&format!(" {mark} {text}{suffix}"));
    }

    pub fn table(&self, columns: &[&str], rows: &[Vec<String>], max_width: usize) {
        let cells: Vec<Vec<String>> = rows.iter().map(|row| row.iter().map(|v| fit(v, max_width)).collect()).collect();
        let mut widths: Vec<usize> = columns.iter().map(|c| c.chars().count()).collect();
        for row in &cells {
            for (i, value) in row.iter().enumerate() {
                if i < widths.len() {
                    widths[i] = widths[i].max(value.chars().count());
                }
            }
        }
        let head = columns.iter().zip(&widths).map(|(c, w)| pad(c, *w)).collect::<Vec<_>>().join("  ");
        self.write(&format!(" {}", self.paint(&head, Some(Tone::Heading))));
        for row in &cells {
            let line = row.iter().zip(&widths).map(|(v, w)| pad(v, *w)).collect::<Vec<_>>().join("  ");
            self.write(&format!(" {}", line.trim_end()));
        }
    }

    pub fn pairs(&self, rows: &[(String, String)], width: usize) {
        for (key, value) in rows {
            self.write(&format!(" {} {value}", self.paint(&pad(key, width), Some(Tone::Muted))));
        }
    }

    pub fn menu(&self, items: &[String]) {
        for (index, label) in items.iter().enumerate() {
            self.write(&format!("   {}. {label}", index + 1));
        }
    }

    /// A line typed by the operator; `None` at the end of input.
    pub fn ask(&self, prompt: &str, default: &str) -> Option<String> {
        let suffix = if default.is_empty() { String::new() } else { format!(" [{default}]") };
        print!(" {prompt}{suffix}: ");
        let _ = io::stdout().flush();
        let mut answer = String::new();
        match io::stdin().lock().read_line(&mut answer) {
            Ok(0) | Err(_) => None,
            Ok(_) => {
                let answer = answer.trim();
                Some(if answer.is_empty() { default.to_string() } else { answer.to_string() })
            }
        }
    }

    pub fn confirm(&self, prompt: &str, default: bool) -> bool {
        let hint = if default { "[Y/n]" } else { "[y/N]" };
        print!(" {prompt} {hint} ");
        let _ = io::stdout().flush();
        let mut answer = String::new();
        if io::stdin().lock().read_line(&mut answer).unwrap_or(0) == 0 {
            return default;
        }
        let answer = answer.trim().to_lowercase();
        if answer.is_empty() {
            default
        } else {
            answer == "y" || answer == "yes"
        }
    }
}

pub fn pad(text: &str, width: usize) -> String {
    let len = text.chars().count();
    if len >= width {
        text.to_string()
    } else {
        format!("{text}{}", " ".repeat(width - len))
    }
}

pub fn fit(text: &str, width: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= width {
        text
    } else {
        format!("{}...", text.chars().take(width.saturating_sub(3)).collect::<String>())
    }
}

/// Prints operations as they happen, one line at a time. Progress is redrawn in place only on an interactive terminal;
/// elsewhere it is printed at most every few seconds, so logs and pipes stay readable.
pub struct LineReporter {
    pub out: Output,
    pub verbose: bool,
    redraw: bool,
    state: Mutex<(Option<Instant>, bool)>,
}

impl LineReporter {
    pub fn new(out: Output, verbose: bool) -> Self {
        let redraw = out.caps.interactive;
        Self { out, verbose, redraw, state: Mutex::new((None, false)) }
    }

    fn clear(&self) {
        let mut state = self.state.lock().unwrap();
        if state.1 {
            print!("\r{}\r", " ".repeat(self.out.width));
            let _ = io::stdout().flush();
            state.1 = false;
        }
    }
}

impl Reporter for LineReporter {
    fn message(&self, level: Level, text: &str, detail: &str) {
        crate::log::info(&format!("{text} {detail}"));
        self.clear();
        self.out.message(level, text, detail);
    }
    fn step_started(&self, title: &str) {
        crate::log::info(&format!("step: {title}"));
        self.clear();
        self.out.status(State::Running, title, "", 36);
    }
    fn step_output(&self, title: &str, line: &str) {
        crate::log::debug(&format!("{title} | {line}"));
        if self.verbose {
            self.out.muted(&format!("    {line}"));
        }
    }
    fn step_finished(&self, title: &str, ok: bool, summary: &str) {
        crate::log::info(&format!("step {}: {title}: {summary}", if ok { "done" } else { "failed" }));
        self.clear();
        self.out.status(if ok { State::Pass } else { State::Fail }, title, summary, 36);
    }
    fn progress(&self, label: &str, done: f64, total: Option<f64>) {
        let text = match total {
            Some(total) if total > 0.0 => format!("{label}: {:3.0}%  {:.1}/{:.1} MiB", done / total * 100.0, done / 1048576.0, total / 1048576.0),
            _ if done > 0.0 => format!("{label}: {:.1} MiB", done / 1048576.0),
            _ => format!("{label}{}", if self.out.caps.unicode { "…" } else { "..." }),
        };
        let mut state = self.state.lock().unwrap();
        if self.redraw {
            let shown: String = text.chars().take(self.out.width - 2).collect();
            print!("\r {}", pad(&shown, self.out.width - 2));
            let _ = io::stdout().flush();
            state.1 = true;
        } else if state.0.map(|t| t.elapsed().as_secs_f64() >= 5.0).unwrap_or(true) {
            state.0 = Some(Instant::now());
            drop(state);
            self.out.muted(&text);
        }
    }
    fn progress_done(&self) {
        self.clear();
    }
}
