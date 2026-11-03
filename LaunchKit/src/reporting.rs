// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! How long operations tell an interface what they are doing. Operations call these methods; each interface supplies
//! its own implementation. The default only logs, so an operation can run with no interface at all.

use crate::log;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Success,
    Warning,
    Error,
}

pub trait Reporter: Send + Sync {
    fn message(&self, level: Level, text: &str, detail: &str) {
        let line = if detail.is_empty() { text.to_string() } else { format!("{text} ({detail})") };
        match level {
            Level::Warning | Level::Error => log::warn(&line),
            _ => log::info(&line),
        }
    }
    fn step_started(&self, title: &str) {
        log::info(&format!("step: {title}"));
    }
    fn step_output(&self, title: &str, line: &str) {
        log::debug(&format!("{title} | {line}"));
    }
    fn step_finished(&self, title: &str, ok: bool, summary: &str) {
        let line = format!("step {}: {title}: {summary}", if ok { "done" } else { "failed" });
        if ok {
            log::info(&line)
        } else {
            log::error(&line)
        }
    }
    /// A determinate (`total` known) or indeterminate activity.
    fn progress(&self, _label: &str, _done: f64, _total: Option<f64>) {}
    /// The activity reported through `progress` has ended.
    fn progress_done(&self) {}
}

/// Logs only.
pub struct Quiet;
impl Reporter for Quiet {}

pub fn duration(seconds: f64) -> String {
    if seconds < 1.0 {
        format!("{:.0} ms", seconds * 1000.0)
    } else if seconds < 60.0 {
        format!("{seconds:.1} s")
    } else {
        format!("{} min {} s", (seconds / 60.0) as u64, (seconds % 60.0) as u64)
    }
}
