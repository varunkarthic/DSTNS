// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! `./launcher demo`: the start-up film on a loop, with every feature, full screen and with music.

use super::{Command, Module, Options, Page};
use crate::api;
use crate::cli::{Context, EXIT_OK};
use crate::config;
use crate::errors::{LauncherError, Result};
use crate::reporting::Level;
use std::time::Duration;

const USAGE: &str = "usage: ./launcher demo [--no-open] [--no-music] [--no-fullscreen]

The start-up film on a loop, with every feature, until Ctrl+C.

  --no-open                 Don't open the observer; print its address
  --no-music                Without music, this time
  --no-fullscreen           In a window, this time
";

pub fn module() -> Module {
    Module {
        commands: vec![Command { name: "demo", usage: "demo", summary: "The start-up film on a loop with every feature, full screen and with music", run }],
        pages: vec![Page { key: "presentation", label: "Demo and Fast Boot", before: "section:Set up" }],
    }
}

/// A server of its own, with no simulation, and the observer showing its film until Ctrl+C.
fn run(context: &Context) -> Result<i32> {
    let options = Options::parse(&context.args.rest, &[], &["--no-open", "--no-music", "--no-fullscreen", "--help", "-h"])?;
    if options.has("--help") || options.has("-h") {
        print!("{USAGE}");
        return Ok(EXIT_OK);
    }
    let out = &context.out;
    let paths = &context.paths;
    let mut settings = config::load(paths)?;
    if options.has("--no-music") {
        config::field("demo.music").unwrap().set(&mut settings, serde_json::json!(false));
    }
    if options.has("--no-fullscreen") {
        config::field("demo.fullscreen").unwrap().set(&mut settings, serde_json::json!(false));
    }
    let shown = config::presentation(&settings, true);
    // A server of its own, so that one already running for real work is left alone.
    if crate::server::active_port(paths).is_some() {
        let base = settings.pointer("/api/port").and_then(|p| p.as_u64()).unwrap_or(8090) as u16;
        std::env::set_var("DSTNS_API_PORT", api::free_port(base + 10, "127.0.0.1").unwrap_or(base + 10).to_string());
    }
    let handle = crate::server::start_with(context.reporter.as_ref(), paths, true, None, true, settings)?;
    if !handle.managed() {
        return Err(LauncherError::start("A Demo Mode server is already running.").remedy(format!("It's at {}.", handle.url())));
    }
    crate::signals::graceful(true);
    if !options.has("--no-open") {
        let profile = crate::paths::local_cache_dir().join("browser");
        crate::simulation::open_presentation(&format!("{}", handle.url()), shown["fullscreen"].as_bool().unwrap_or(false), shown["music"].as_bool().unwrap_or(false), &profile);
    }
    out.message(Level::Success, "Demo Mode", &handle.url());
    out.muted(&format!(
        "{}{}Change these with ./launcher config. Press Ctrl+C to end it.",
        if shown["fullscreen"].as_bool().unwrap_or(false) { "Full screen, " } else { "" },
        if shown["music"].as_bool().unwrap_or(false) { "with music. " } else { "without music. " }
    ));
    let mut failure = None;
    while !crate::signals::interrupted() {
        std::thread::sleep(Duration::from_millis(500));
        if handle.exit_code().is_some() {
            failure = Some(LauncherError::start("The Demo Mode server stopped."));
            break;
        }
    }
    out.blank();
    crate::server::shut_down(&handle, paths);
    crate::signals::graceful(false);
    if let Some(error) = failure {
        return Err(error);
    }
    out.message(Level::Info, "Demo Mode ended", "");
    Ok(EXIT_OK)
}

