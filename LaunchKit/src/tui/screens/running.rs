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
use crate::tui::theme::{fg, ACCENT, MUTED, OK, TEXT, TEXT2, WARN};
use crate::tui::widgets::{self, activity, key, row, status_lines, Key};
use crate::tui::{level_tone, now_stamp, reporter, Action, Dialog, Event_, Screen, Ui};
use crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;

use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
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
        let body = Rect { x: area.x + 1, width: area.width.saturating_sub(2), ..area };
        let world = ui.session.world.lock().unwrap().clone();
        let current = self.status.clone();
        let f = &self.figures;
        let unicode = ui.unicode;
        let times = if unicode { "×" } else { "x" };
        let mut y = body.y;
        let bottom = body.y + body.height;
        if ui.small() {
            // Keep what matters most at 50x15: where, which seed, the time and the state; full telemetry returns on resize.
            let mut rows = vec![];
            if let Some(world) = &world {
                rows.extend([row("Place", world.place()), row("Seed", world.seed.clone())]);
            }
            if let Some(c) = &current {
                rows.extend([row("Time", format!("{} / 24:00:00", c.clock)), row("State", c.lifecycle.to_lowercase())]);
            }
            let lines = status_lines(&rows, 10, body.width, unicode);
            y += lines.len() as u16;
            frame.render_widget(Paragraph::new(lines), body);
        } else {
            // Four sections of readings, as on the dashboard.
            let strip = Rect { y, height: 6.min(body.height), ..body };
            let parts = ratatui::layout::Layout::horizontal([ratatui::layout::Constraint::Ratio(1, 4); 4]).spacing(2).split(strip);
            let dash = || "-".to_string();
            widgets::readings(
                frame,
                parts[0],
                "World",
                vec![
                    ("place", world.as_ref().map(|w| w.place()).unwrap_or_else(dash), TEXT),
                    ("seed", world.as_ref().map(|w| w.seed.clone()).or_else(|| current.as_ref().map(|c| c.seed.clone())).unwrap_or_else(dash), TEXT2),
                    ("day", world.as_ref().map(|w| w.day_name().to_string()).unwrap_or_else(dash), TEXT2),
                    ("network", world.as_ref().map(|w| format!("{} junctions", simulation::thousands(w.nodes))).unwrap_or_else(dash), TEXT2),
                ],
                unicode,
            );
            let remaining = current.as_ref().and_then(|s| simulation::remaining_wall_seconds(s, f.target_rate));
            widgets::readings(
                frame,
                parts[1],
                "Clock",
                vec![
                    ("time", current.as_ref().map(|c| c.clock.clone()).unwrap_or_else(|| "--:--:--".into()), ACCENT),
                    ("state", current.as_ref().map(|c| c.lifecycle.to_lowercase()).unwrap_or_else(|| "starting".into()), if self.phase == Phase::Live { OK } else { ACCENT }),
                    ("speed", current.as_ref().and_then(|c| c.tick_rate).map(|r| format!("{}{times}", crate::config::fmt_g(r))).unwrap_or_else(dash), TEXT),
                    ("ends in", remaining.map(|r| format!("{}m {:02}s", r as u64 / 60, r as u64 % 60)).unwrap_or_else(dash), TEXT2),
                ],
                unicode,
            );
            widgets::readings(
                frame,
                parts[2],
                "Traffic",
                vec![
                    ("vehicles", f.vehicles.map(|v| simulation::thousands(v as usize)).unwrap_or_else(dash), TEXT),
                    ("halting", f.halting.map(|v| simulation::thousands(v as usize)).unwrap_or_else(dash), if f.halting.unwrap_or(0) > 0 { WARN } else { TEXT2 }),
                    ("congest", f.congestion.map(|c| format!("{c:.1}% · 15m {:.1}%", f.congestion_average.unwrap_or(0.0))).unwrap_or_else(dash), TEXT),
                    ("roads", f.closed_roads.map(|c| format!("{} flooded · {c} closed", f.flooded_roads.unwrap_or(0))).unwrap_or_else(dash), TEXT2),
                    ("storms", f.storms.map(|s| format!("{s} active")).unwrap_or_else(dash), TEXT2),
                ],
                unicode,
            );
            let managed = ui.session.handle().map(|h| h.managed()).unwrap_or(false);
            widgets::readings(
                frame,
                parts[3],
                "Engine",
                vec![
                    ("port", self.port.map(|p| p.to_string()).unwrap_or_else(dash), TEXT),
                    ("owner", if self.port.is_none() { dash() } else if managed { "this launcher".into() } else { "attached".into() }, TEXT2),
                    ("cpu", self.usage.map(|(c, _)| format!("{c:.0}%")).unwrap_or_else(dash), TEXT),
                    ("memory", self.usage.map(|(_, r)| format!("{r:.0} MiB")).unwrap_or_else(dash), TEXT),
                    ("observer", self.port.map(|p| format!("127.0.0.1:{p}")).unwrap_or_else(dash), TEXT2),
                ],
                unicode,
            );
            y += strip.height + 1;
        }
        // Progress: the day, or the map download, across the whole width.
        let progress = match (&self.phase, &self.progress, &current) {
            (Phase::Preparing, Some((_, done, total)), _) if *total > 0.0 => Some(("map", (done / total).clamp(0.0, 1.0))),
            (Phase::Live, _, Some(s)) => Some(("day", s.fraction.clamp(0.0, 1.0))),
            _ => None,
        };
        if let Some((label, ratio)) = progress {
            if y < bottom {
                let w = body.width.saturating_sub(16) as usize;
                let line = Line::from(vec![Span::styled(format!(" {label:<6}"), fg(MUTED)), Span::styled(widgets::bar(ratio, w, unicode), fg(ACCENT))]);
                frame.render_widget(Paragraph::new(line), Rect { y, height: 1, ..body });
                y += 1;
            }
        }
        if !self.activity.is_empty() && y < bottom {
            frame.render_widget(Paragraph::new(activity(&self.activity, self.phase == Phase::Preparing || self.stopping.is_some(), ui.motion, ui.started)), Rect { x: body.x + 1, y, width: body.width.saturating_sub(1), height: 1 });
            y += 1;
        }
        if y + 3 >= bottom {
            return;
        }
        y += 1;
        let log_area = Rect { y, height: bottom - y, ..body };
        let block = widgets::card("Live log", false);
        let inner = block.inner(log_area);
        frame.render_widget(block, log_area);
        let mut log_lines: Vec<Line> = vec![];
        for (text, tone) in &self.log {
            for piece in widgets::wrap(text, inner.width.max(10) as usize) {
                log_lines.push(Line::from(Span::styled(piece, fg(*tone))));
            }
        }
        let end = if self.follow { log_lines.len() } else { log_lines.len().saturating_sub(self.log_scroll) };
        let start = end.saturating_sub(inner.height as usize);
        frame.render_widget(Paragraph::new(log_lines[start..end].to_vec()), inner);
    }
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action {
        match event.code {
            KeyCode::Char('f') => {
                self.follow = !self.follow;
                self.log_scroll = 0;
                Action::Toast(format!("Log follow {}", if self.follow { "on" } else { "off" }), ACCENT)
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
