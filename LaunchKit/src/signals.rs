// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! SIGTERM, SIGHUP and Ctrl+C. By default the launcher stops what this session started and exits, so that closing a
//! terminal never leaves a server or an application running. A command that waits for Ctrl+C on purpose, such as
//! Demo Mode, says so with `graceful`, and is told through `interrupted` instead, so it can wind down itself.

use crate::session::Session;
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

static INTERRUPTED: AtomicBool = AtomicBool::new(false);
static TERMINATED: AtomicBool = AtomicBool::new(false);
static GRACEFUL: AtomicBool = AtomicBool::new(false);
static INSTALLED: AtomicBool = AtomicBool::new(false);

pub fn install(session: Arc<Session>) {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGTERM, SIGHUP, SIGINT]) else { return };
    std::thread::spawn(move || {
        for signal in signals.forever() {
            if signal != SIGINT {
                TERMINATED.store(true, Ordering::SeqCst);
            }
            INTERRUPTED.store(true, Ordering::SeqCst);
            if GRACEFUL.load(Ordering::SeqCst) && signal != SIGHUP {
                continue;
            }
            crate::log::info(&format!("signal {signal}: cleaning up"));
            crate::interface::restore_terminal();
            session.cleanup();
            std::process::exit(if signal == SIGTERM { crate::cli::EXIT_TERMINATED } else { crate::cli::EXIT_INTERRUPTED });
        }
    });
}

/// This command handles Ctrl+C and SIGTERM itself, by watching `interrupted`.
pub fn graceful(on: bool) {
    GRACEFUL.store(on, Ordering::SeqCst);
    INTERRUPTED.store(false, Ordering::SeqCst);
}

pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::SeqCst)
}

pub fn terminated() -> bool {
    TERMINATED.load(Ordering::SeqCst)
}
