// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Running simulation: start-up progress, then the engine's own figures and log.
//!
//! The terminal does not try to draw the city; the observer does that. This screen shows what the engine reports,
//! refreshed a few times a second, so the interface never competes with the simulation for time.

use crate::config::RunOptions;
use crate::environment::State;
use crate::errors::LauncherError;
use crate::logs::Follower;
use crate::process::Cancel;
use crate::reporting::Level;
use crate::simulation::{self, Metrics, Status};
use crate::tui::theme::{self, fg, CYAN, MUTED, OK, TEXT2, WARN};
use crate::tui::widgets::{self, activity, key, row, status_lines, Key};
use crate::tui::{level_tone, now_stamp, reporter, Action, Dialog, Event_, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Gauge, Paragraph};
use ratatui::Frame;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

#[derive(PartialEq)]
enum Phase {
    Preparing,
    Live,
    Failed,
}

struct Reading {
    status: Status,
    figures: Option<Metrics>,
    usage: Option<(f64, f64)>,
    lines: Vec<String>,
    exited: Option<i32>,
}

pub struct RunningScreen {
    options: Option<RunOptions>,
    phase: Phase,
    port: Option<u16>,
    status: Option<Status>,
    figures: Metrics,
    usage: Option<(f64, f64)>,
    misses: u32,
    launch: Option<Receiver<Event_>>,
    done: Option<Receiver<Result<(), LauncherError>>>,
    readings: Option<Receiver<Reading>>,
    stopping: Option<Receiver<bool>>,
    last_poll: Option<Instant>,
    last_figures: Option<Instant>,
    last_usage: Option<Instant>,
    follower: Option<Follower>,
    follower_back: Option<Receiver<Follower>>,
    activity: String,
    progress: Option<(String, f64, f64)>,
    log: Vec<(String, u32)>,
    follow: bool,
    log_scroll: usize,
    cancel: Cancel,
    completed: bool,
}

impl RunningScreen {
    pub fn new(options: Option<RunOptions>) -> Self {
        Self {
            phase: if options.is_some() { Phase::Preparing } else { Phase::Live },
            options,
            port: None,
            status: None,
            figures: Metrics::default(),
            usage: None,
            misses: 0,
            launch: None,
            done: None,
            readings: None,
            stopping: None,
            last_poll: None,
            last_figures: None,
            last_usage: None,
            follower: Some(Follower::default()),
            follower_back: None,
            activity: String::new(),
            progress: None,
            log: vec![],
            follow: true,
            log_scroll: 0,
            cancel: Cancel::new(),
            completed: false,
        }
    }

    fn say(&mut self, ui: &mut Ui, level: Level, text: &str, detail: &str) {
        let line = format!("[{}] {text}{}", now_stamp(), if detail.is_empty() { String::new() } else { format!(" · {detail}") });
        ui.log(line.clone());
        self.log.push((line, level_tone(level)));
        if self.phase == Phase::Preparing && level == Level::Info {
            self.activity = text.into();
        }
    }

    fn begin(&mut self, ui: &mut Ui) {
        let (events, receiver) = reporter();
        let (finished, done) = channel();
        let session = ui.session.clone();
        let options = self.options.clone().unwrap_or_default();
        let open = ui.args.open;
        let cancel = self.cancel.clone();
        std::thread::spawn(move || {
            let outcome = session.launch(&options, events, open, cancel).map(|_| ());
            let _ = finished.send(outcome);
        });
        self.launch = Some(receiver);
        self.done = Some(done);
        self.activity = "Preparing the simulation".into();
    }

    fn fetch(&mut self, ui: &Ui) {
        let Some(port) = self.port else { return };
        if self.readings.is_some() {
            return;
        }
        let now = Instant::now();
        let want_figures = self.last_figures.map(|t| t.elapsed() >= Duration::from_secs(1)).unwrap_or(true);
        let handle = ui.session.handle();
        let want_usage = handle.as_ref().map(|h| h.managed()).unwrap_or(false) && self.last_usage.map(|t| t.elapsed() >= Duration::from_secs(2)).unwrap_or(true);
        if want_figures {
            self.last_figures = Some(now);
        }
        if want_usage {
            self.last_usage = Some(now);
        }
        let paths = ui.paths.clone();
        let mut follower = self.follower.take().unwrap_or_default();
        let (sender, receiver) = channel();
        std::thread::spawn(move || {
            let status = simulation::status(port, &paths);
            let figures = (status.reachable && want_figures).then(|| simulation::metrics(port, &paths));
            let usage = if want_usage { handle.as_ref().and_then(|h| h.pid()).and_then(simulation::server_usage) } else { None };
            let lines = follower.read(&paths, 200);
            let exited = handle.as_ref().and_then(|h| h.exit_code());
            let _ = sender.send((Reading { status, figures, usage, lines, exited }, follower));
        });
        let (forward, readings) = channel();
        let (follower_back, follower_receiver) = channel();
        std::thread::spawn(move || {
            if let Ok((reading, follower)) = receiver.recv() {
                let _ = follower_back.send(follower);
                let _ = forward.send(reading);
            }
        });
        self.readings = Some(readings);
        self.follower_back = Some(follower_receiver);
        self.last_poll = Some(now);
    }

    fn gone(&mut self, ui: &mut Ui, exited: Option<i32>) -> Action {
        if self.stopping.is_some() || self.phase != Phase::Live {
            return Action::None;
        }
        self.phase = Phase::Failed;
        let reason = match exited {
            Some(0) => "The server stopped.".to_string(),
            Some(code) => format!("The server exited with status {code}."),
            None => "The server is no longer reachable.".into(),
        };
        self.say(ui, Level::Error, &reason, "");
        let error = LauncherError::runtime(reason).remedy("Inspect the logs, or start a new simulation.");
        let actions: Vec<(&str, &str)> = if self.options.is_some() { vec![("retry", "Start again"), ("logs", "Inspect logs"), ("menu", "Return to menu")] } else { vec![("logs", "Inspect logs"), ("menu", "Return to menu")] };
        Action::Dialog(Dialog::error("gone", "Simulation stopped", &error, &actions, &ui.paths))
    }
}

// The follower goes to the worker and comes back with the reading.
impl RunningScreen {
    #[allow(clippy::type_complexity)]
    fn take_follower(&mut self) {
        if let Some(back) = &self.follower_back {
            if let Ok(follower) = back.try_recv() {
                self.follower = Some(follower);
                self.follower_back = None;
            }
        }
    }
}

impl Screen for RunningScreen {
    fn title(&self) -> String {
        "Running Simulation".into()
    }
    fn path(&self) -> String {
        "/running".into()
    }
    fn keys(&self, _ui: &Ui) -> Vec<Key> {
        if self.phase == Phase::Preparing {
            return vec![key("Esc", "Cancel", "Cancel", true), key("f", "Follow log", "Follow", false)];
        }
        vec![
            key("Space", "Pause/resume", "Pause", true),
            key("o", "Open observer", "Observer", false),
            key("s", "Stop", "Stop", true),
            key("Esc", "Dashboard", "Back", true),
            key("f", "Follow log", "Follow", false),
            key("c", "Clear log", "Clear", false),
        ]
    }
    fn state(&self) -> Option<(State, String)> {
        if self.stopping.is_some() {
            return Some((State::Running, "stopping".into()));
        }
        match self.phase {
            Phase::Preparing => Some((State::Running, "starting".into())),
            Phase::Failed => Some((State::Fail, "failed".into())),
            Phase::Live => self.status.as_ref().map(|s| {
                if s.observer_hold {
                    (State::Running, "waiting for the observer".into())
                } else if self.misses >= 3 {
                    (State::Warning, "server busy".into())
                } else {
                    let state = match s.lifecycle.as_str() {
                        "RUNNING" | "SEEKING" => State::Running,
                        "PAUSED" => State::Warning,
                        _ => State::Pending,
                    };
                    (state, s.lifecycle.to_lowercase())
                }
            }),
        }
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui) {
        let body = Rect { x: area.x + 2, width: area.width.saturating_sub(4), ..area };
        let mut lines: Vec<Line> = vec![Line::from(Span::styled(if self.phase == Phase::Preparing { "STARTING" } else { "SIMULATION" }, theme::bold(TEXT2))), widgets::rule("", body.width, ui.unicode)];
        let mut rows = vec![];
        if let Some(current) = &self.status {
            let world = ui.session.world.lock().unwrap().clone();
            if let Some(world) = &world {
                rows.extend([row("Place", world.place()), row("Seed", world.seed.clone()), row("Day", world.day_name())]);
            } else if !current.seed.is_empty() {
                rows.push(row("Seed", current.seed.clone()));
            }
            rows.push(row("Simulation time", format!("{} / 24:00:00", current.clock)));
            let mut lifecycle = current.lifecycle.to_lowercase();
            if let Some(first) = lifecycle.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            rows.push(row("State", lifecycle));
            if let Some(rate) = current.tick_rate {
                rows.push(row("Speed", format!("{}{}", crate::config::fmt_g(rate), if ui.unicode { "×" } else { "x" })));
            }
            let f = &self.figures;
            if let Some(vehicles) = f.vehicles {
                rows.push(row("Vehicles", format!("{} modelled · {} halting", simulation::thousands(vehicles as usize), simulation::thousands(f.halting.unwrap_or(0) as usize))));
            }
            if let Some(congestion) = f.congestion {
                rows.push(row("Congestion", format!("{congestion:.1}% (15-min average {:.1}%)", f.congestion_average.unwrap_or(0.0))));
            }
            if let Some(closed) = f.closed_roads {
                rows.push(row("Roads", format!("{} flooded · {closed} closed", f.flooded_roads.unwrap_or(0))));
            }
            if let Some(storms) = f.storms {
                rows.push(row("Storms", format!("{storms} active")));
            }
            if let Some(port) = self.port {
                rows.push(row("Observer", format!("http://127.0.0.1:{port}/")));
                let managed = ui.session.handle().map(|h| h.managed()).unwrap_or(false);
                rows.push(row("Server", format!("port {port} · {}", if managed { "started by this launcher" } else { "already running" })));
            }
            if ui.small() {
                // Keep progress and live output visible at 50x15; full telemetry returns on resize.
                rows.retain(|r| ["Place", "Seed", "Simulation time", "State", "Speed"].contains(&r.name.as_str()));
            }
        }
        lines.extend(status_lines(&rows, 18, body.width, ui.unicode));
        let mut y = body.y + lines.len() as u16;
        frame.render_widget(Paragraph::new(lines), body);
        // Progress: the day, or the map download.
        let bar = match (&self.phase, &self.progress, &self.status) {
            (Phase::Preparing, Some((_, done, total)), _) if *total > 0.0 => Some(("Map download".to_string(), (done / total).clamp(0.0, 1.0))),
            (Phase::Live, _, Some(s)) => Some(("Progress".to_string(), s.fraction.clamp(0.0, 1.0))),
            _ => None,
        };
        if let Some((label, ratio)) = bar {
            if y < body.y + body.height {
                frame.render_widget(Paragraph::new(Span::styled(label, fg(TEXT2))), Rect { x: body.x, y, width: 19.min(body.width), height: 1 });
                let gauge_width = body.width.saturating_sub(19);
                frame.render_widget(
                    Gauge::default().ratio(ratio).label(format!("{:.0}%", ratio * 100.0)).gauge_style(Style::default().fg(theme::c(CYAN)).bg(theme::c(theme::SURFACE_ALT))).use_unicode(ui.unicode),
                    Rect { x: body.x + 19.min(body.width), y, width: gauge_width, height: 1 },
                );
                y += 1;
            }
        }
        if !self.activity.is_empty() && y < body.y + body.height {
            frame.render_widget(Paragraph::new(activity(&self.activity, self.phase == Phase::Preparing || self.stopping.is_some(), ui.motion, ui.started)), Rect { y, height: 1, ..body });
            y += 1;
        }
        if y + 2 >= body.y + body.height {
            return;
        }
        frame.render_widget(Paragraph::new(widgets::rule("Live log", body.width, ui.unicode)), Rect { y, height: 1, ..body });
        y += 1;
        let usage_line = !ui.small();
        let log_height = (body.y + body.height).saturating_sub(y + if usage_line { 1 } else { 0 });
        let mut log_lines: Vec<Line> = vec![];
        for (text, tone) in &self.log {
            for piece in widgets::wrap(text, body.width as usize) {
                log_lines.push(Line::from(Span::styled(piece, fg(*tone))));
            }
        }
        let end = if self.follow { log_lines.len() } else { log_lines.len().saturating_sub(self.log_scroll) };
        let start = end.saturating_sub(log_height as usize);
        frame.render_widget(Paragraph::new(log_lines[start..end].to_vec()).style(Style::default().bg(theme::c(theme::SURFACE))), Rect { y, height: log_height, ..body });
        if usage_line {
            let mut parts = vec![];
            if let Some((cpu, ram)) = self.usage {
                parts.push(format!("CPU {cpu:.0}%"));
                parts.push(format!("RAM {ram:.0} MiB"));
            }
            if let Some(remaining) = self.status.as_ref().and_then(|s| simulation::remaining_wall_seconds(s, self.figures.target_rate)) {
                parts.push(format!("Day ends in {}m {:02}s", remaining as u64 / 60, remaining as u64 % 60));
            }
            frame.render_widget(Paragraph::new(Span::styled(parts.join("      "), fg(MUTED))), Rect { y: y + log_height, height: 1, ..body });
        }
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        match event.code {
            KeyCode::Char('f') => {
                self.follow = !self.follow;
                self.log_scroll = 0;
                Action::Toast(format!("Log follow {}", if self.follow { "on" } else { "off" }), CYAN)
            }
            KeyCode::PageUp | KeyCode::Up => {
                self.follow = false;
                self.log_scroll += 5;
                Action::None
            }
            KeyCode::PageDown | KeyCode::Down => {
                self.log_scroll = self.log_scroll.saturating_sub(5);
                Action::None
            }
            KeyCode::End => {
                self.follow = true;
                self.log_scroll = 0;
                Action::None
            }
            KeyCode::Char('c') => {
                // Only the view: system.log and the journal are untouched.
                self.log.clear();
                ui.run_log.clear();
                Action::None
            }
            KeyCode::Char(' ') | KeyCode::Char('p') if self.phase == Phase::Live => {
                let (Some(port), Some(status)) = (self.port, &self.status) else { return Action::None };
                let action = if status.lifecycle == "RUNNING" { "pause" } else { "play" };
                match simulation::control(port, action, &ui.paths) {
                    Ok(_) => self.say(ui, Level::Info, if action == "pause" { "Paused" } else { "Resumed" }, ""),
                    Err(error) => self.say(ui, Level::Error, &error.message, ""),
                }
                Action::None
            }
            KeyCode::Char('o') => {
                if let Some(port) = self.port {
                    let url = format!("http://127.0.0.1:{port}/");
                    let shown = url.clone();
                    std::thread::spawn(move || simulation::open_in_browser(&url));
                    self.say(ui, Level::Info, "Opening the observer", &shown);
                }
                Action::None
            }
            KeyCode::Char('s') if self.phase == Phase::Live && self.stopping.is_none() => Action::Dialog(Dialog::confirm(
                "stop",
                "Stop Simulation?",
                "The current simulation has not completed. Stopping ends the run and shuts the server down.",
                "Stop",
                "Cancel",
            )),
            KeyCode::Char('b') => self.back(ui),
            _ => Action::None,
        }
    }
    fn dialog(&mut self, id: &str, choice: &str, ui: &mut Ui) -> Action {
        match (id, choice) {
            ("stop", "yes") => {
                self.activity = "Stopping simulation".into();
                self.say(ui, Level::Info, "Stopping simulation...", "");
                if ui.session.handle().is_none() {
                    if let Some(port) = self.port {
                        *ui.session.handle.lock().unwrap() = Some(std::sync::Arc::new(crate::server::ServerHandle::attached(port)));
                    }
                }
                let session = ui.session.clone();
                let (sender, receiver) = channel();
                std::thread::spawn(move || {
                    let _ = sender.send(session.stop_server());
                });
                self.stopping = Some(receiver);
                Action::None
            }
            ("cancel", "yes") => {
                self.cancel.set();
                self.activity = "Cancelling start-up".into();
                self.say(ui, Level::Warning, "Cancelling start-up...", "");
                Action::None
            }
            ("failed", "retry") | ("gone", "retry") => Action::Replace(Box::new(RunningScreen::new(self.options.clone()))),
            ("failed", "diagnostics") => Action::Replace(Box::new(super::diagnostics::DiagnosticsScreen::new(ui))),
            ("gone", "logs") => Action::Replace(Box::new(super::logs::LogsScreen::new(ui))),
            ("failed", _) | ("gone", _) => Action::Pop,
            _ => Action::None,
        }
    }
    fn tick(&mut self, ui: &mut Ui) -> Action {
        if self.phase == Phase::Preparing && self.launch.is_none() {
            self.log = ui.run_log.iter().map(|l| (l.clone(), TEXT2)).collect();
            self.begin(ui);
        } else if self.phase == Phase::Live && self.port.is_none() && self.status.is_none() && self.readings.is_none() {
            if self.log.is_empty() {
                self.log = ui.run_log.iter().map(|l| (l.clone(), TEXT2)).collect();
            }
            self.port = ui.session.any_port();
        }
        let mut events = vec![];
        if let Some(receiver) = &self.launch {
            while let Ok(event) = receiver.try_recv() {
                events.push(event);
            }
        }
        for event in events {
            match event {
                Event_::Message(level, text, detail) => self.say(ui, level, &text, &detail),
                Event_::Step(state, title, summary) => {
                    if state == "running" {
                        self.activity = title;
                    } else {
                        self.say(ui, if state == "pass" { Level::Success } else { Level::Error }, &title, &summary);
                    }
                }
                Event_::Output(line) => self.log.push((format!("    {line}"), MUTED)),
                Event_::Progress(label, done, total) => {
                    self.activity = match total {
                        Some(total) if total > 0.0 => format!("{label}: {:.1} of {:.1} MiB", done / 1048576.0, total / 1048576.0),
                        _ if done > 0.0 => format!("{label}: {:.1} MiB", done / 1048576.0),
                        _ => format!("{label}..."),
                    };
                    self.progress = Some((label, done, total.unwrap_or(0.0)));
                }
                Event_::ProgressDone => {
                    self.progress = None;
                    self.activity = "Preparing the world".into();
                }
            }
        }
        if let Some(done) = &self.done {
            if let Ok(outcome) = done.try_recv() {
                self.done = None;
                self.launch = None;
                match outcome {
                    Ok(()) => {
                        self.phase = Phase::Live;
                        self.port = ui.session.port();
                        self.activity.clear();
                    }
                    Err(error) => {
                        self.activity.clear();
                        if self.cancel.is_set() {
                            return Action::Pop;
                        }
                        self.phase = Phase::Failed;
                        self.say(ui, Level::Error, &error.message, "");
                        return Action::Dialog(Dialog::error(
                            "failed",
                            "Unable to start the simulation",
                            &error,
                            &[("retry", "Retry"), ("diagnostics", "Diagnostics"), ("menu", "Return to menu")],
                            &ui.paths,
                        ));
                    }
                }
            }
        }
        self.take_follower();
        if let Some(readings) = &self.readings {
            if let Ok(reading) = readings.try_recv() {
                self.readings = None;
                if let Some(figures) = reading.figures {
                    self.figures = figures;
                }
                if reading.usage.is_some() {
                    self.usage = reading.usage;
                }
                for line in reading.lines {
                    ui.log(line.clone());
                    let tone = if line.contains("[INFO]") { TEXT2 } else { WARN };
                    self.log.push((line, tone));
                }
                if !reading.status.reachable {
                    self.misses += 1;
                    // A busy engine can miss a few polls. Only a process that has really gone, or one silent for
                    // this long, means the simulation has stopped.
                    let ours = ui.session.handle().map(|h| h.managed()).unwrap_or(false) && reading.exited.is_none();
                    let limit = if ours { simulation::BUSY_POLL_LIMIT } else { simulation::GONE_POLL_LIMIT };
                    if reading.exited.is_some() || self.misses >= limit {
                        return self.gone(ui, reading.exited);
                    }
                } else {
                    self.misses = 0;
                    let completed = reading.status.lifecycle == "COMPLETED";
                    self.status = Some(reading.status);
                    if completed && !self.completed {
                        self.completed = true;
                        let world = ui.session.world.lock().unwrap().clone();
                        return Action::Replace(Box::new(super::completion::CompletionScreen::new(world, self.status.clone().unwrap(), self.port)));
                    }
                }
            }
        }
        if let Some(stopping) = &self.stopping {
            if let Ok(stopped) = stopping.try_recv() {
                self.stopping = None;
                self.activity.clear();
                if !stopped {
                    self.say(ui, Level::Error, "The server did not stop", "");
                    return Action::None;
                }
                self.say(ui, Level::Success, "Simulation stopped", "");
                *ui.session.handle.lock().unwrap() = None;
                return Action::Many(vec![Action::Pop, Action::Toast("Simulation stopped.".into(), OK)]);
            }
        }
        if self.phase == Phase::Live && self.stopping.is_none() && self.last_poll.map(|t| t.elapsed() >= Duration::from_millis(250)).unwrap_or(true) {
            if self.port.is_none() {
                self.port = ui.session.any_port();
            }
            self.fetch(ui);
        }
        Action::None
    }
    fn back(&mut self, _ui: &mut Ui) -> Action {
        if self.phase == Phase::Preparing {
            return Action::Dialog(Dialog::confirm("cancel", "Cancel start-up?", "The world is still being prepared.", "Cancel start-up", "Keep waiting"));
        }
        Action::Pop
    }
}
