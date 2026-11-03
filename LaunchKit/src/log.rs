// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher's own diagnostic log, `logs/launcher.log`.
//!
//! The log is best effort. If it cannot be written - a full disk, a directory that vanished, a sync client that has
//! evicted the file - logging stops quietly for the rest of the session instead of interrupting anything.

use crate::paths::{dataless, Paths};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_BYTES: u64 = 1_000_000;
const BACKUPS: u32 = 2;

struct Sink {
    path: PathBuf,
    file: Option<File>,
    failed: bool,
    debug: bool,
    echo: bool,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

pub fn configure(paths: &Paths, debug: bool, echo: bool) {
    let path = paths.launcher_log();
    let failed = dataless(&path);
    *SINK.lock().unwrap() = Some(Sink { path, file: None, failed, debug, echo });
    info(&format!("launcher {} · Rust launcher · {} {}", crate::version::engine_version(), std::env::consts::OS, std::env::consts::ARCH));
}

/// Stop echoing to the terminal, which a full-screen interface now owns.
pub fn silence_console() {
    if let Some(sink) = SINK.lock().unwrap().as_mut() {
        sink.echo = false;
    }
}

fn write(level: &str, message: &str) {
    let mut guard = SINK.lock().unwrap();
    let Some(sink) = guard.as_mut() else { return };
    if level == "DEBUG" && !sink.debug {
        return;
    }
    if sink.echo {
        eprintln!("[debug] {message}");
    }
    if sink.failed {
        return;
    }
    let line = format!("{} {level} {message}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S,%3f"));
    let result = (|| -> std::io::Result<()> {
        if sink.file.is_none() {
            if let Some(parent) = sink.path.parent() {
                fs::create_dir_all(parent)?;
            }
            sink.file = Some(OpenOptions::new().create(true).append(true).open(&sink.path)?);
        }
        if fs::metadata(&sink.path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > MAX_BYTES {
            sink.file = None;
            for n in (1..BACKUPS).rev() {
                let _ = fs::rename(format!("{}.{n}", sink.path.display()), format!("{}.{}", sink.path.display(), n + 1));
            }
            let _ = fs::rename(&sink.path, format!("{}.1", sink.path.display()));
            sink.file = Some(OpenOptions::new().create(true).append(true).open(&sink.path)?);
        }
        sink.file.as_mut().unwrap().write_all(line.as_bytes())
    })();
    if result.is_err() {
        sink.failed = true;
        sink.file = None;
    }
}

pub fn info(message: &str) {
    write("INFO", message);
}
pub fn warn(message: &str) {
    write("WARNING", message);
}
pub fn error(message: &str) {
    write("ERROR", message);
}
pub fn debug(message: &str) {
    write("DEBUG", message);
}
