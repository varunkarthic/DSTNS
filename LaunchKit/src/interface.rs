// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Choosing an interface: the terminal interface, or compatibility mode if it can't run.
//!
//! Compatibility mode does every launcher operation through numbered menus. It needs nothing but a line of input and
//! output, never redraws the screen or moves the cursor, so it works over any connection and in any terminal.

use crate::cli::{Context, EXIT_OK};
use crate::config::{self, FieldKind, RunOptions};
use crate::environment::{self, State};
use crate::errors::LauncherError;
use crate::output::Output;
use crate::reporting::{Level, Reporter};
use crate::version::{engine_version, observer_version, DOCUMENTATION, FULL_NAME, LICENSE_NAME, LICENSE_SPDX, OSM_ATTRIBUTION, OSM_LICENSE, PRODUCT, REPOSITORY};
use crate::{logs, maintenance, seeds, server, simulation, sumo, testing};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_terminal_active(active: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
}

/// Put the terminal back as it was, if the interface has it. Safe to call more than once, and from a signal.
pub fn restore_terminal() {
    if ACTIVE.swap(false, Ordering::SeqCst) {
        let _ = crossterm::execute!(std::io::stdout(), crossterm::event::DisableMouseCapture);
        ratatui::restore();
    }
}

pub fn run_interactive(context: Context, initial: &str) -> i32 {
    if context.args.no_tui || context.caps.term == "dumb" || context.args.reduced_ui {
        return Compatibility::new(&context).run(initial);
    }
    let reduced_resume;
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| crate::tui::run(Context { args: context.args.clone(), caps: context.caps.clone(), out: Output::new(&context.caps), reporter: context.reporter.clone(), session: context.session.clone(), paths: context.paths.clone() }, initial))) {
        Ok(Ok(outcome)) if !outcome.reduced => return outcome.code,
        Ok(Ok(_)) => {
            crate::log::info("operator switched to compatibility mode");
            reduced_resume = "home";
        }
        Ok(Err(error)) => {
            restore_terminal();
            crate::log::error(&format!("terminal interface failed: {error}"));
            explain_switch(&context, &error.to_string());
            reduced_resume = initial;
        }
        Err(_) => {
            restore_terminal();
            crate::log::error("terminal interface stopped unexpectedly");
            explain_switch(&context, "Terminal UI initialization failed.");
            reduced_resume = initial;
        }
    }
    Compatibility::new(&context).run(reduced_resume)
}

fn explain_switch(context: &Context, reason: &str) {
    println!();
    println!("{PRODUCT} Launcher");
    println!();
    println!("The enhanced terminal interface could not be started.");
    println!("Switching to compatibility mode.");
    println!();
    println!("Reason:");
    println!("  {reason}");
    println!("  Details: {}", context.paths.launcher_log().display());
    println!();
}

struct Back;

struct Compatibility<'a> {
    context: &'a Context,
    out: Output,
}

impl<'a> Compatibility<'a> {
    fn new(context: &'a Context) -> Self {
        Self { context, out: Output::new(&context.caps) }
    }

    fn reporter(&self) -> &dyn Reporter {
        self.context.reporter.as_ref()
    }

    fn ask(&self, prompt: &str, default: &str) -> Result<String, Back> {
        self.out.ask(prompt, default).ok_or(Back)
    }

    /// A numbered menu; the 0-based choice, or Back.
    fn choose(&self, title: &str, items: &[String], back: &str) -> Result<usize, Back> {
        loop {
            self.out.heading(title);
            self.out.rule();
            let mut all = items.to_vec();
            all.push(back.to_string());
            self.out.menu(&all);
            self.out.rule();
            let answer = self.ask("Select", "")?;
            if ["q", "b", "back", "esc"].contains(&answer.to_lowercase().as_str()) {
                return Err(Back);
            }
            match answer.parse::<usize>() {
                Ok(n) if n == all.len() => return Err(Back),
                Ok(n) if (1..all.len()).contains(&n) => return Ok(n - 1),
                _ => self.out.message(Level::Warning, &format!("Enter a number from 1 to {}.", all.len()), ""),
            }
        }
    }

    fn pause(&self) {
        let _ = self.out.ask("Press Enter to continue", "");
    }

    fn explain(&self, error: &LauncherError) {
        self.out.blank();
        self.out.message(Level::Error, &error.message, "");
        for line in error.remedy.lines() {
            self.out.muted(&format!("  {line}"));
        }
        let lines: Vec<&str> = error.detail.lines().collect();
        for line in &lines[lines.len().saturating_sub(12)..] {
            self.out.muted(&format!("  {line}"));
        }
        self.out.muted(&format!("  Details have been written to {}", self.context.paths.launcher_log().display()));
    }

    fn guard(&self, action: impl FnOnce(&Self) -> Result<(), LauncherError>) {
        if let Err(error) = action(self) {
            if !error.is_cancelled() {
                crate::log::error(&error.message);
                self.explain(&error);
            }
        }
    }

    fn run(&self, initial: &str) -> i32 {
        crate::log::info("compatibility mode");
        if crate::setup::first_launch() || initial == "setup" {
            self.guard(|s| s.setup());
        }
        match initial {
            "start" => self.guard(|s| s.start(s.context.args.run.clone(), false)),
            "config" => self.guard(|s| s.configuration()),
            "logs" => self.guard(|s| s.logs()),
            _ => {}
        }
        self.home()
    }

    fn header(&self) {
        self.out.blank();
        self.out.banner(&format!("{PRODUCT} {}", engine_version()), FULL_NAME);
        self.out.heading("Status");
        match config::load(&self.context.paths) {
            Ok(_) => self.out.status(State::Pass, "Configuration", "valid", 22),
            Err(error) => self.out.status(State::Fail, "Configuration", &error.message, 22),
        }
        let built = self.context.paths.server().exists();
        self.out.status(if built { State::Pass } else { State::Warning }, "Simulation core", if built { "built" } else { "built automatically on first start" }, 22);
        match self.context.session.any_port() {
            Some(port) => self.out.status(State::Pass, "Server", &format!("port {port} · {}", simulation::status(port, &self.context.paths).lifecycle), 22),
            None => self.out.status(State::Skipped, "Server", "not running", 22),
        }
    }

    fn home(&self) -> i32 {
        loop {
            self.header();
            let mut items: Vec<&str> = vec!["Start simulation", "Saved seeds", "Configuration", "Diagnostics", "Logs", "Tests", "Tools", "Demo and Fast Boot", "Type a command", "First-launch setup", "About"];
            let running = self.context.session.handle().map(|h| h.running(&self.context.paths)).unwrap_or(false);
            if running {
                items.insert(0, "Running simulation");
            }
            let labels: Vec<String> = items.iter().map(|s| s.to_string()).collect();
            let Ok(choice) = self.choose("Main menu", &labels, "Exit") else { return self.leave() };
            match items[choice] {
                "Running simulation" => self.guard(|s| s.monitor()),
                "Start simulation" => self.guard(|s| {
                    let options = s.ask_run_options().map_err(|_| LauncherError::cancelled())?;
                    s.start(options, true)
                }),
                "Saved seeds" => self.guard(|s| s.saved_seeds()),
                "Configuration" => self.guard(|s| s.configuration()),
                "Diagnostics" => self.guard(|s| s.diagnostics()),
                "Logs" => self.guard(|s| s.logs()),
                "Tests" => self.guard(|s| s.tests()),
                "Tools" => self.guard(|s| s.tools()),
                "Demo and Fast Boot" => self.guard(|s| s.presentation()),
                "Type a command" => self.guard(|s| s.command()),
                "First-launch setup" => self.guard(|s| s.setup()),
                _ => self.about(),
            }
        }
    }

    fn leave(&self) -> i32 {
        let running = self.context.session.handle().map(|h| h.managed() && h.running(&self.context.paths)).unwrap_or(false);
        if running {
            if !self.out.confirm("The simulation is running. Stop it and exit?", false) {
                return self.home();
            }
            self.out.message(Level::Info, "Stopping the simulation", "");
            self.context.session.stop_server();
        }
        self.out.line(&format!("{PRODUCT} launcher closed."));
        EXIT_OK
    }

    fn ask_run_options(&self) -> Result<RunOptions, Back> {
        self.out.heading("New simulation");
        self.out.muted("Press Enter to accept a default. Leave the seed empty for a new one.");
        let mut options = RunOptions::default();
        options.seed = Some(self.ask("Seed", "")?).filter(|s| !s.is_empty());
        let day = self.ask("Day type (weekday/weekend)", "weekday")?;
        if day == "weekday" || day == "weekend" {
            options.day_type = Some(day);
        } else {
            self.out.message(Level::Warning, "Unknown day type; using the configured default", "");
        }
        let cached = simulation::cached_maps(&self.context.paths);
        let hint = cached.first().map(|c| format!(" ({} cached: e.g. {c})", cached.len())).unwrap_or_default();
        let map = self.ask(&format!("Map: auto, or a file path{hint}"), "auto")?;
        options.osm_file = (map != "auto").then_some(map);
        let save = self.ask("Save this configuration as (optional ID)", "")?;
        if !save.is_empty() {
            options.save_seed = Some(save);
            options.description = Some(self.ask("Description (optional)", "")?).filter(|d| !d.is_empty());
        }
        if let Err(error) = config::start_request(&options, &self.context.paths) {
            self.explain(&error);
            return Err(Back);
        }
        Ok(options)
    }

    fn start(&self, options: RunOptions, _asked: bool) -> Result<(), LauncherError> {
        self.out.heading("Starting a simulation");
        self.out.rule();
        let world = self.context.session.launch(&options, self.context.reporter.clone(), self.context.args.open, crate::process::Cancel::new())?;
        if world.is_none() {
            self.out.message(Level::Info, "A run is already in progress; showing it", "");
        }
        self.monitor()
    }

    fn monitor(&self) -> Result<(), LauncherError> {
        let paths = &self.context.paths;
        let Some(port) = self.context.session.any_port() else {
            self.out.message(Level::Info, "No simulation is running", "");
            return Ok(());
        };
        loop {
            let current = simulation::status(port, paths);
            self.out.heading("Simulation");
            self.out.rule();
            if !current.reachable {
                let alive = self.context.session.handle().map(|h| h.managed() && h.exit_code().is_none()).unwrap_or(false);
                if alive {
                    self.out.message(Level::Info, "The server is busy; checking again", "");
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
                self.out.message(Level::Warning, "The server is no longer reachable", "");
                return Ok(());
            }
            let figures = simulation::metrics(port, paths);
            let mut rows = vec![
                ("State".to_string(), if current.observer_hold { "Waiting for the observer".to_string() } else { current.lifecycle.clone() }),
                ("Simulation time".into(), format!("{} / 24:00:00 ({:.1}%)", current.clock, current.fraction * 100.0)),
            ];
            if let Some(world) = self.context.session.world.lock().unwrap().clone() {
                rows.extend([("Place".into(), world.place()), ("Seed".into(), world.seed.clone()), ("Day".into(), world.day_name().into())]);
            } else if !current.seed.is_empty() {
                rows.push(("Seed".into(), current.seed.clone()));
            }
            if let Some(rate) = current.tick_rate {
                rows.push(("Speed".into(), format!("{}x", config::fmt_g(rate))));
            }
            if let Some(vehicles) = figures.vehicles {
                rows.push(("Vehicles (modelled)".into(), simulation::thousands(vehicles as usize)));
            }
            if let Some(congestion) = figures.congestion {
                rows.push(("Congestion".into(), format!("{congestion:.1}%")));
            }
            rows.push(("Observer".into(), format!("http://127.0.0.1:{port}/")));
            self.out.pairs(&rows, 20);
            if current.lifecycle == "COMPLETED" {
                self.out.message(Level::Success, "The simulated day is complete", "");
            }
            self.out.rule();
            self.out.muted("Enter refresh · p pause · r resume · o open observer · d restart the day");
            self.out.muted("s stop the simulation · b back to the menu");
            let Ok(answer) = self.ask("Action", "") else { return Ok(()) };
            let outcome = match answer.to_lowercase().as_str() {
                "b" | "back" | "q" => return Ok(()),
                "p" => simulation::control(port, "pause", paths).map(|_| ()),
                "r" => simulation::control(port, "play", paths).map(|_| ()),
                "d" if self.out.confirm("Restart the same day from 00:00:00?", false) => simulation::control(port, "restart", paths).map(|_| ()),
                "o" => {
                    let url = format!("http://127.0.0.1:{port}/");
                    let opened = simulation::open_in_browser(&url);
                    self.out.message(if opened { Level::Success } else { Level::Warning }, if opened { "Observer opened" } else { "Open this address in your browser" }, &url);
                    Ok(())
                }
                "s" if self.out.confirm("Stop the simulation? The current run has not been saved.", false) => {
                    self.out.message(Level::Info, "Stopping the simulation...", "");
                    if self.context.session.handle().is_none() {
                        *self.context.session.handle.lock().unwrap() = Some(std::sync::Arc::new(server::ServerHandle::attached(port)));
                    }
                    let stopped = self.context.session.stop_server();
                    self.out.message(if stopped { Level::Success } else { Level::Error }, if stopped { "Simulation stopped" } else { "The server did not stop" }, "");
                    return Ok(());
                }
                _ => Ok(()),
            };
            if let Err(error) = outcome {
                self.explain(&error);
            }
        }
    }

    fn saved_seeds(&self) -> Result<(), LauncherError> {
        let paths = &self.context.paths;
        loop {
            let rows = seeds::operate("list", &json!({}), paths)?.as_array().cloned().unwrap_or_default();
            self.out.heading("Saved seeds");
            if rows.is_empty() {
                self.out.muted("No saved seeds yet. Save one when starting a simulation.");
                self.pause();
                return Ok(());
            }
            let s = |r: &serde_json::Value, k: &str| r[k].as_str().unwrap_or("").to_string();
            let table: Vec<Vec<String>> = rows.iter().map(|r| vec![s(r, "id"), s(r, "seed"), s(r, "created_at").chars().take(19).collect::<String>().replace('T', " "), s(r, "description")]).collect();
            self.out.table(&["ID", "Seed", "Created", "Description"], &table, 48);
            let ids: Vec<String> = rows.iter().map(|r| s(r, "id")).collect();
            let Ok(choice) = self.choose("Choose a saved seed", &ids, "Back") else { return Ok(()) };
            let name = ids[choice].clone();
            let Ok(action) = self.choose(&name, &["Start it".into(), "Inspect".into(), "Delete".into()], "Back") else { continue };
            match action {
                0 => return self.start(RunOptions { saved_seed: Some(name), ..Default::default() }, false),
                1 => {
                    let record = seeds::operate("inspect", &json!({"id": name}), paths)?;
                    let config = &record["config"];
                    self.out.pairs(
                        &[
                            ("Seed".into(), s(&record, "seed")),
                            ("Created".into(), s(&record, "created_at")),
                            ("Description".into(), Some(s(&record, "description")).filter(|d| !d.is_empty()).unwrap_or_else(|| "-".into())),
                            ("Day".into(), if config["day"] == json!(1) { "weekend" } else { "weekday" }.into()),
                            ("Map".into(), config.pointer("/map/osm_file").and_then(|v| v.as_str()).unwrap_or("").into()),
                            ("Map selection".into(), s(&record, "map_version")),
                        ],
                        20,
                    );
                    self.pause();
                }
                _ => {
                    if self.out.confirm(&format!("Delete the saved seed {name}?"), false) {
                        seeds::operate("delete", &json!({"id": name}), paths)?;
                        self.out.message(Level::Success, &format!("Deleted {name}"), "");
                    }
                }
            }
        }
    }

    fn edit_field(&self, field: &config::Field, current: &mut serde_json::Value) {
        self.out.muted(field.help);
        let hint = match field.kind {
            FieldKind::Choice => field.choices.iter().map(|(l, _)| *l).collect::<Vec<_>>().join("/"),
            FieldKind::Boolean => "on/off".into(),
            _ if field.minimum.is_some() => field.range_text().trim_end_matches('.').replace("Must be ", ""),
            _ => String::new(),
        };
        let prompt = if hint.is_empty() { field.label.to_string() } else { format!("{} ({hint})", field.label) };
        let Ok(text) = self.ask(&prompt, &field.display(&field.get(current))) else { return };
        match field.parse(&text).and_then(|value| {
            let problem = config::check_field(field, &value, current);
            if problem.is_empty() {
                Ok(value)
            } else {
                Err(problem)
            }
        }) {
            Ok(value) => {
                for other in field.set(current, value) {
                    if let Some(other) = config::field(other) {
                        self.out.message(Level::Info, &format!("{} is now {}, as it must be", other.label, other.display(&other.get(current))), "");
                    }
                }
            }
            Err(problem) => self.out.message(Level::Error, &format!("{}: {problem}", field.label), ""),
        }
    }

    fn configuration(&self) -> Result<(), LauncherError> {
        let paths = &self.context.paths;
        let mut current = config::load(paths)?;
        let mut saved = current.clone();
        loop {
            let dirty = current != saved;
            let labels: Vec<String> = config::fields().iter().map(|f| format!("{:<12} {:<26} {} {}", f.category, f.label, f.display(&f.get(&current)), f.unit).trim_end().to_string()).collect();
            let mut items = labels.clone();
            items.push("Save changes".into());
            let title = format!("Configuration{}", if dirty { "   * UNSAVED" } else { "" });
            match self.choose(&title, &items, "Back") {
                Err(Back) => {
                    if dirty {
                        if let Ok(0) = self.choose("Unsaved changes: configuration has been modified", &["Save and continue".into(), "Discard changes".into()], "Cancel") {
                            config::save(&current, paths)?;
                            self.out.message(Level::Success, "Configuration saved", "");
                        } else if self.choose("Leave without saving?", &["Discard changes".into()], "Cancel").is_err() {
                            continue;
                        }
                    }
                    return Ok(());
                }
                Ok(choice) if choice == labels.len() => {
                    config::save(&current, paths)?;
                    saved = current.clone();
                    self.out.message(Level::Success, "Configuration saved", "");
                }
                Ok(choice) => self.edit_field(&config::fields()[choice], &mut current),
            }
        }
    }

    /// The first-launch setup, as questions.
    fn setup(&self) -> Result<(), LauncherError> {
        let paths = &self.context.paths;
        let mut current = config::load(paths)?;
        self.out.heading("Welcome to DSTNS");
        self.out.muted("A few choices, then you're set. Press Enter to keep each default; Configuration changes any of them later.");
        if !self.out.confirm("Go through the setup now?", true) {
            let _ = crate::setup::complete(paths);
            self.out.message(Level::Info, "Setup skipped; the defaults stay. ./launcher setup opens it again.", "");
            return Ok(());
        }
        for key in [
            "startup.fast_boot",
            "startup.force_animate",
            "presentation.music",
            "presentation.fullscreen",
            "performance.map_fps",
            "performance.render_scale",
            "fabric.applications",
            "webfabric.enabled",
            "fabric.legacy_api",
            "mcp.enabled",
            "api.port",
        ] {
            self.edit_field(config::field(key).unwrap(), &mut current);
        }
        config::save(&current, paths)?;
        let _ = crate::setup::complete(paths);
        self.out.message(Level::Success, "All set", "Configuration changes any of this later.");
        if config::flag(&current, "startup.fast_boot") && crate::modules::fastboot::here(paths).0 == 0 {
            self.out.muted("Fast Boot needs every city downloaded first: ./launcher fastboot download, or Demo and Fast Boot here.");
        }
        Ok(())
    }

    fn diagnostics(&self) -> Result<(), LauncherError> {
        let suites = self.out.confirm("Also run the test suites (takes a minute)?", false);
        self.out.heading("Diagnostics");
        self.out.rule();
        let items = environment::run_checks(environment::checks(suites), &self.context.paths, |_| {});
        for check in &items {
            self.out.status(check.outcome.state, check.name, &check.outcome.value, 22);
            if matches!(check.outcome.state, State::Fail | State::Warning) {
                for line in check.outcome.detail.lines().take(3) {
                    self.out.muted(&format!("          {line}"));
                }
                if !check.outcome.remedy.is_empty() {
                    self.out.muted(&format!("          {}", check.outcome.remedy));
                }
            }
        }
        self.out.rule();
        let blocking = environment::blocking(&items);
        if blocking.is_empty() {
            self.out.message(Level::Success, "Ready to run", "");
        } else {
            self.out.message(Level::Error, &format!("{} required check(s) failed; a simulation cannot start", blocking.len()), "");
        }
        self.out.muted(&format!("Terminal: {}", self.context.caps.summary()));
        self.pause();
        Ok(())
    }

    fn logs(&self) -> Result<(), LauncherError> {
        let sources = logs::sources();
        loop {
            let labels: Vec<String> = sources.iter().map(|(_, l)| l.to_string()).collect();
            let Ok(choice) = self.choose("Logs", &labels, "Back") else { return Ok(()) };
            let key = sources[choice].0;
            if key == "system" {
                match logs::system_tail(60, &self.context.paths) {
                    None => self.out.message(Level::Info, "No system log yet", ""),
                    Some(lines) => lines.iter().for_each(|l| self.out.line(l)),
                }
            } else {
                match logs::journal(key, 40, &self.context.paths) {
                    None => self.out.message(Level::Info, "No runtime database yet", ""),
                    Some(table) if table.rows.is_empty() => self.out.message(Level::Info, "No log records found", ""),
                    Some(table) => self.out.table(&table.columns.iter().map(|c| c.as_str()).collect::<Vec<_>>(), &table.rows, 40),
                }
            }
            self.pause();
        }
    }

    fn tests(&self) -> Result<(), LauncherError> {
        let scopes: Vec<String> = testing::SCOPES.iter().map(|s| s.to_string()).collect();
        let Ok(choice) = self.choose("Tests", &scopes, "Back") else { return Ok(()) };
        let results = testing::run(&scopes[choice], self.reporter(), &self.context.paths);
        let failed = results.iter().filter(|r| !r.passed).count();
        if failed > 0 {
            self.out.message(Level::Error, &format!("{failed} of {} stage(s) failed", results.len()), "");
        } else {
            self.out.message(Level::Success, &format!("All {} stages passed", results.len()), "");
        }
        self.pause();
        Ok(())
    }

    fn tools(&self) -> Result<(), LauncherError> {
        let paths = &self.context.paths;
        let Ok(choice) = self.choose("Tools", &["Check the SUMO toolchain".into(), "Rebuild the observer".into(), "Reset runtime data".into()], "Back") else { return Ok(()) };
        match choice {
            0 => self.out.pairs(&sumo::run_standalone(self.reporter(), paths)?, 20),
            1 => {
                let plan = crate::buildplan::plan(paths, false, true);
                let steps: Vec<&crate::buildplan::Step> = plan.steps.iter().filter(|s| s.observer).collect();
                crate::buildplan::execute(&steps, self.reporter(), paths, None)?;
            }
            _ => {
                for path in maintenance::describe(paths) {
                    self.out.muted(&format!("  {path}"));
                }
                if self.out.confirm("Delete these runtime files? Maps, saved seeds and configuration are kept.", false) {
                    maintenance::reset(self.reporter(), paths);
                }
            }
        }
        self.pause();
        Ok(())
    }

    /// Demo Mode and the Fast Boot downloads, run as the commands are.
    fn presentation(&self) -> Result<(), LauncherError> {
        let items = vec!["Demo Mode (Ctrl+C ends it)".to_string(), "Download every city for Fast Boot (Ctrl+C stops it)".into(), "Fast Boot status".into()];
        let Ok(choice) = self.choose("Demo and Fast Boot", &items, "Back") else { return Ok(()) };
        let arguments: &[&str] = match choice {
            0 => &["demo"],
            1 => &["fastboot", "download"],
            _ => &["fastboot", "status"],
        };
        self.child(arguments)
    }

    fn child(&self, arguments: &[&str]) -> Result<(), LauncherError> {
        let exe = std::env::current_exe()?;
        let status = std::process::Command::new(exe).args(arguments).env("DSTNS_ROOT", &self.context.paths.root).status()?;
        if !status.success() {
            self.out.message(Level::Warning, &format!("It ended with status {}", status.code().unwrap_or(130)), "");
        }
        self.pause();
        Ok(())
    }

    /// Any command, as in the terminal interface's command bar, or as at the shell.
    fn command(&self) -> Result<(), LauncherError> {
        self.out.muted("As at the shell, without ./launcher: apps list, fastboot status, config set performance.map_fps 30, test unit.");
        let Ok(line) = self.ask("Command", "") else { return Ok(()) };
        let Some(words) = shlex::split(&line) else {
            self.out.message(Level::Error, "It could not be read: a quotation mark is not closed.", "");
            return Ok(());
        };
        if words.is_empty() {
            return Ok(());
        }
        let arguments: Vec<&str> = words.iter().map(|s| s.as_str()).collect();
        self.child(&arguments)
    }

    fn about(&self) {
        let unicode = self.context.caps.unicode;
        self.out.heading(PRODUCT);
        self.out.line(FULL_NAME);
        self.out.blank();
        self.out.pairs(
            &[
                ("Version".into(), engine_version().into()),
                ("Observer".into(), observer_version().into()),
                ("Copyright".into(), if unicode { "© 2026 Varun Karthic" } else { "(C) 2026 Varun Karthic" }.into()),
                ("License".into(), LICENSE_NAME.into()),
                ("SPDX".into(), LICENSE_SPDX.into()),
            ],
            12,
        );
        self.out.blank();
        self.out.line("Map data");
        self.out.line(&format!("  {}", if unicode { OSM_ATTRIBUTION } else { "(C) OpenStreetMap contributors" }));
        self.out.line(&format!("  OpenStreetMap data is available under the {OSM_LICENSE}."));
        self.out.blank();
        self.out.pairs(&[("Project".into(), REPOSITORY.into()), ("Documentation".into(), DOCUMENTATION.into())], 14);
        self.pause();
    }
}
