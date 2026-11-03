// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The terminal interface: a stack of screens, dialogs over them, a key bar, and a command bar for typing commands as
//! in a shell. Work that takes time runs on threads and reports back through a channel, so the interface never waits.

pub mod screens;
pub mod shell;
pub mod theme;
pub mod widgets;

use crate::cli::{Arguments, Context};
use crate::environment::{Check, State};
use crate::paths::Paths;
use crate::reporting::{Level, Reporter};
use crate::session::Session;
use crate::terminal::{layout_for, Capabilities, Layout, MINIMUM};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind};
use ratatui::layout::{Constraint, Layout as Split, Rect};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;
use std::collections::VecDeque;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use theme::{bold, fg, CYAN, ERR, MUTED, OK, TEAL, TEXT, TEXT2, WARN};
use widgets::{Key, Menu, MenuEvent};

/// What a screen asks the interface to do.
pub enum Action {
    None,
    Push(Box<dyn Screen>),
    Replace(Box<dyn Screen>),
    Pop,
    /// Back to the dashboard.
    Home,
    Dialog(Dialog),
    Toast(String, u32),
    Quit,
    Many(Vec<Action>),
}

pub trait Screen {
    fn title(&self) -> String;
    /// Where it is, for the command bar: "/" is the dashboard.
    fn path(&self) -> String;
    fn keys(&self, ui: &Ui) -> Vec<Key>;
    fn state(&self) -> Option<(State, String)> {
        None
    }
    fn draw(&mut self, frame: &mut Frame, area: Rect, ui: &Ui);
    fn key(&mut self, event: KeyEvent, ui: &mut Ui) -> Action;
    fn tick(&mut self, _ui: &mut Ui) -> Action {
        Action::None
    }
    fn dialog(&mut self, _id: &str, _choice: &str, _ui: &mut Ui) -> Action {
        Action::None
    }
    fn resume(&mut self, _ui: &mut Ui) {}
    fn click(&mut self, _column: u16, _row: u16, _ui: &mut Ui) -> Action {
        Action::None
    }
    /// Whether a text field has the keyboard, so that : and / are typed rather than opening the command bar.
    fn typing(&self) -> bool {
        false
    }
    /// Escape: back, unless a screen has something to finish first.
    fn back(&mut self, _ui: &mut Ui) -> Action {
        Action::Pop
    }
    fn help(&self, ui: &Ui) -> Vec<(String, String)> {
        let mut lines: Vec<(String, String)> = self.keys(ui).into_iter().map(|k| (k.key, k.label)).collect();
        lines.extend(
            [
                ("Up/Down, j/k", "Move"),
                ("Enter", "Select"),
                ("Tab, Shift+Tab", "Next or previous control"),
                ("Esc", "Back or dismiss"),
                (": or /", "Command bar: type commands as in a shell"),
                ("Ctrl+C", "Quit safely"),
                ("?", "This help"),
            ]
            .map(|(a, b)| (a.to_string(), b.to_string())),
        );
        lines
    }
}

/// A message and a list of actions; the chosen action's key goes back to the screen that opened it.
pub struct Dialog {
    pub id: String,
    pub title: String,
    pub message: Text<'static>,
    pub detail: String,
    pub menu: Menu,
    pub cancel: Option<String>,
    pub error: bool,
}

impl Dialog {
    pub fn new(id: &str, title: &str, message: Text<'static>, actions: &[(&str, &str)], cancel: Option<&str>) -> Self {
        let mut menu = Menu::new(actions.iter().map(|(k, l)| widgets::item(k, l)).collect());
        menu.index = 0;
        Self { id: id.into(), title: title.into(), message, detail: String::new(), menu, cancel: cancel.map(String::from), error: false }
    }
    pub fn confirm(id: &str, title: &str, message: &str, yes: &str, no: &str) -> Self {
        Self::new(id, title, Text::from(Span::styled(message.to_string(), fg(TEXT))), &[("no", no), ("yes", yes)], Some("no"))
    }
    /// The standard recoverable-error dialog: what happened, what to do, where the details are.
    pub fn error(id: &str, title: &str, error: &crate::errors::LauncherError, actions: &[(&str, &str)], paths: &Paths) -> Self {
        let mut lines = vec![Line::from(Span::styled(error.message.clone(), fg(TEXT)))];
        if !error.remedy.is_empty() {
            lines.push(Line::default());
            lines.extend(error.remedy.lines().map(|l| Line::from(Span::styled(l.to_string(), fg(TEXT2)))));
        }
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("Details have been written to:", fg(MUTED))));
        lines.push(Line::from(Span::styled(paths.launcher_log().to_string_lossy().into_owned(), fg(MUTED))));
        let mut dialog = Self::new(id, title, Text::from(lines), actions, actions.last().map(|(k, _)| *k));
        let detail: Vec<&str> = error.detail.lines().collect();
        dialog.detail = detail[detail.len().saturating_sub(12)..].join("\n");
        dialog.error = true;
        dialog
    }
}

/// Reports from a worker thread, delivered to the screen on the interface thread.
pub enum Event_ {
    Message(Level, String, String),
    Step(String, String, String),
    Output(String),
    Progress(String, f64, Option<f64>),
    ProgressDone,
}

#[derive(Clone)]
pub struct ChannelReporter(pub Sender<Event_>);

impl Reporter for ChannelReporter {
    fn message(&self, level: Level, text: &str, detail: &str) {
        crate::log::info(&format!("{text} {detail}"));
        let _ = self.0.send(Event_::Message(level, text.into(), detail.into()));
    }
    fn step_started(&self, title: &str) {
        crate::log::info(&format!("step: {title}"));
        let _ = self.0.send(Event_::Step("running".into(), title.into(), String::new()));
    }
    fn step_output(&self, _title: &str, line: &str) {
        let _ = self.0.send(Event_::Output(line.into()));
    }
    fn step_finished(&self, title: &str, ok: bool, summary: &str) {
        crate::log::info(&format!("step {}: {title}: {summary}", if ok { "done" } else { "failed" }));
        let _ = self.0.send(Event_::Step(if ok { "pass" } else { "fail" }.into(), title.into(), summary.into()));
    }
    fn progress(&self, label: &str, done: f64, total: Option<f64>) {
        let _ = self.0.send(Event_::Progress(label.into(), done, total));
    }
    fn progress_done(&self) {
        let _ = self.0.send(Event_::ProgressDone);
    }
}

pub fn reporter() -> (Arc<ChannelReporter>, Receiver<Event_>) {
    let (sender, receiver) = channel();
    (Arc::new(ChannelReporter(sender)), receiver)
}

/// What every screen can see and use.
pub struct Ui {
    pub session: Arc<Session>,
    pub paths: Paths,
    pub caps: Capabilities,
    pub args: Arguments,
    pub unicode: bool,
    pub motion: bool,
    pub layout: Layout,
    pub width: u16,
    pub height: u16,
    /// The last environment check results.
    pub checks: Option<Vec<Check>>,
    /// Survives leaving the running screen.
    pub run_log: VecDeque<String>,
    pub started: Instant,
}

impl Ui {
    pub fn small(&self) -> bool {
        self.layout == Layout::Small
    }
    pub fn medium_or_small(&self) -> bool {
        matches!(self.layout, Layout::Small | Layout::Medium)
    }
    pub fn log(&mut self, line: String) {
        self.run_log.push_back(line);
        while self.run_log.len() > 2000 {
            self.run_log.pop_front();
        }
    }
}

struct Toast {
    text: String,
    tone: u32,
    until: Instant,
}

pub struct Outcome {
    pub code: i32,
    pub reduced: bool,
}

struct App {
    ui: Ui,
    screens: Vec<Box<dyn Screen>>,
    dialogs: Vec<Dialog>,
    toasts: Vec<Toast>,
    shell: shell::Shell,
    outcome: Option<Outcome>,
    quitting: bool,
    help_open: Option<Vec<(String, String)>>,
}

impl App {
    fn apply(&mut self, action: Action) {
        match action {
            Action::None => {}
            Action::Push(screen) => self.screens.push(screen),
            Action::Replace(screen) => {
                self.screens.pop();
                self.screens.push(screen);
            }
            Action::Pop => {
                if self.screens.len() > 1 {
                    self.screens.pop();
                    let ui = &mut self.ui;
                    if let Some(screen) = self.screens.last_mut() {
                        screen.resume(ui);
                    }
                }
            }
            Action::Home => {
                self.screens.truncate(1);
                let ui = &mut self.ui;
                if let Some(screen) = self.screens.last_mut() {
                    screen.resume(ui);
                }
            }
            Action::Dialog(dialog) => self.dialogs.push(dialog),
            Action::Toast(text, tone) => self.toasts.push(Toast { text, tone, until: Instant::now() + Duration::from_secs(4) }),
            Action::Quit => self.request_quit(),
            Action::Many(actions) => {
                for action in actions {
                    self.apply(action);
                }
            }
        }
    }

    /// A simulation this launcher started is stopped first, after confirmation.
    fn request_quit(&mut self) {
        let running = self.ui.session.handle().map(|h| h.managed() && h.running(&self.ui.paths)).unwrap_or(false);
        if running {
            self.dialogs.push(Dialog::confirm("quit", "Simulation running", "The simulation is still running. Stop it and exit?", "Stop simulation and exit", "Cancel"));
        } else {
            self.outcome = Some(Outcome { code: 0, reduced: false });
        }
    }

    fn dialog_chosen(&mut self, id: String, choice: String) {
        if id == "quit" {
            if choice == "yes" && !self.quitting {
                self.quitting = true;
                self.toasts.push(Toast { text: "Stopping the simulation...".into(), tone: CYAN, until: Instant::now() + Duration::from_secs(30) });
                let session = self.ui.session.clone();
                std::thread::spawn(move || {
                    session.stop_server();
                });
            }
            return;
        }
        if let Some(action) = self.shell.dialog(&id, &choice, &mut self.ui) {
            self.apply(action);
            return;
        }
        let ui = &mut self.ui;
        let action = self.screens.last_mut().unwrap().dialog(&id, &choice, ui);
        self.apply(action);
    }

    fn on_key(&mut self, event: KeyEvent) {
        if event.modifiers.contains(KeyModifiers::CONTROL) && matches!(event.code, KeyCode::Char('c') | KeyCode::Char('q')) {
            if self.shell.interrupt() {
                return;
            }
            self.request_quit();
            return;
        }
        if self.ui.layout == Layout::TooSmall {
            if matches!(event.code, KeyCode::Char('r') | KeyCode::Char('R')) {
                self.outcome = Some(Outcome { code: 0, reduced: true });
            }
            return;
        }
        if self.help_open.is_some() {
            if matches!(event.code, KeyCode::Esc | KeyCode::Char('?') | KeyCode::Enter) {
                self.help_open = None;
            }
            return;
        }
        if let Some(dialog) = self.dialogs.last_mut() {
            match event.code {
                KeyCode::Esc => {
                    if let Some(cancel) = dialog.cancel.clone() {
                        let id = dialog.id.clone();
                        self.dialogs.pop();
                        self.dialog_chosen(id, cancel);
                    }
                }
                _ => {
                    if let MenuEvent::Selected(choice) = dialog.menu.handle(&event) {
                        let id = dialog.id.clone();
                        self.dialogs.pop();
                        self.dialog_chosen(id, choice);
                    }
                }
            }
            return;
        }
        if self.shell.open {
            let action = self.shell.key(event, &mut self.ui, self.screens.last().unwrap().path());
            self.apply(action);
            return;
        }
        let typing = self.screens.last().unwrap().typing();
        match event.code {
            KeyCode::Char(':') | KeyCode::Char('/') if !typing && self.shell.enabled => {
                self.shell.show();
                return;
            }
            KeyCode::Char('?') if !typing => {
                let lines = self.screens.last().unwrap().help(&self.ui);
                self.help_open = Some(lines);
                return;
            }
            KeyCode::Esc => {
                if self.shell.has_output() {
                    self.shell.dismiss();
                    return;
                }
                let ui = &mut self.ui;
                let action = self.screens.last_mut().unwrap().back(ui);
                if matches!(action, Action::Pop) && self.screens.len() == 1 {
                    return;
                }
                self.apply(action);
                return;
            }
            _ => {}
        }
        let ui = &mut self.ui;
        let action = self.screens.last_mut().unwrap().key(event, ui);
        self.apply(action);
    }

    fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        frame.render_widget(Block::default().style(theme::base()), area);
        if self.ui.layout == Layout::TooSmall {
            let lines = vec![
                Line::from(Span::styled("DSTNS", bold(CYAN))),
                Line::default(),
                Line::from(Span::styled("Terminal too small for the full interface.", fg(TEXT))),
                Line::default(),
                Line::from(Span::styled(format!("Current: {} x {}", area.width, area.height), fg(TEXT2))),
                Line::from(Span::styled(format!("Recommended minimum: {} x {}", MINIMUM.0, MINIMUM.1), fg(TEXT2))),
                Line::default(),
                Line::from(Span::styled("Resize the terminal or press R for reduced mode.", fg(TEXT))),
            ];
            let height = lines.len() as u16;
            let y = area.y + area.height.saturating_sub(height) / 2;
            frame.render_widget(Paragraph::new(lines).alignment(ratatui::layout::Alignment::Center).wrap(Wrap { trim: true }), Rect { y, height: height.min(area.height), ..area });
            return;
        }
        let small = self.ui.small();
        let full_screen = self.screens.last().map(|s| s.path() == "/splash").unwrap_or(false);
        if full_screen {
            let ui = &self.ui;
            self.screens.last_mut().unwrap().draw(frame, area, ui);
            return;
        }
        let header_height = if small { 1 } else { 3 };
        let bar_height = self.shell.height();
        let parts = Split::vertical([Constraint::Length(header_height), Constraint::Min(1), Constraint::Length(bar_height), Constraint::Length(1)]).split(area);
        let (title, state) = {
            let top = self.screens.last().unwrap();
            (top.title(), top.state())
        };
        widgets::header(frame, parts[0], &title, state, self.ui.unicode, small);
        let body = parts[1];
        let output_height = self.shell.output_height(body.height);
        let (screen_area, output_area) = if output_height > 0 {
            let split = Split::vertical([Constraint::Min(1), Constraint::Length(output_height)]).split(body);
            (split[0], Some(split[1]))
        } else {
            (body, None)
        };
        {
            let ui = &self.ui;
            self.screens.last_mut().unwrap().draw(frame, screen_area, ui);
        }
        if let Some(output) = output_area {
            self.shell.draw_output(frame, output, &self.ui);
        }
        if bar_height > 0 {
            let path = self.screens.last().unwrap().path();
            self.shell.draw(frame, parts[2], body, &self.ui, &path);
        }
        let mut keys = self.screens.last().unwrap().keys(&self.ui);
        if self.shell.enabled && !self.shell.open {
            keys.push(widgets::key(":", "Command", "Cmd", false));
        }
        keys.push(widgets::key("?", "Help", "Help", false));
        if self.shell.open {
            keys = self.shell.keys();
        }
        widgets::keybar(frame, parts[3], &keys);
        // A notice, in the corner above the key bar.
        self.toasts.retain(|t| t.until > Instant::now());
        if let Some(toast) = self.toasts.last() {
            let text = format!(" {} ", toast.text);
            let w = (widgets::width(&text) as u16 + 2).min(area.width.saturating_sub(4));
            let rect = Rect { x: area.width.saturating_sub(w + 2), y: parts[3].y.saturating_sub(3 + bar_height), width: w, height: 3 };
            frame.render_widget(Clear, rect);
            frame.render_widget(
                Paragraph::new(Span::styled(text, fg(TEXT))).block(Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(fg(toast.tone))).style(theme::base()),
                rect,
            );
        }
        if let Some(lines) = &self.help_open {
            let mut text = vec![];
            for (key, label) in lines {
                text.push(Line::from(vec![Span::styled(widgets::clip(&format!("{key:<16}"), 18, self.ui.unicode), bold(CYAN)), Span::styled(label.clone(), fg(TEXT))]));
            }
            text.push(Line::default());
            text.push(Line::from(Span::styled("Esc or ? closes this help.", fg(MUTED))));
            draw_box(frame, area, "Keyboard", Text::from(text), "", None, false);
        }
        if let Some(dialog) = self.dialogs.last_mut() {
            draw_box(frame, area, &dialog.title.clone(), dialog.message.clone(), &dialog.detail.clone(), Some(&mut dialog.menu), dialog.error);
        }
    }
}

/// A centred, rounded box over everything: a dialog, or the help.
fn draw_box(frame: &mut Frame, area: Rect, title: &str, message: Text<'static>, detail: &str, menu: Option<&mut Menu>, error: bool) {
    let width = 64.min(area.width.saturating_sub(4)).max(20);
    let inner_width = width.saturating_sub(6);
    let wrapped = |text: &Text| -> u16 {
        text.lines.iter().map(|l| ((widgets::width(&l.to_string()) as u16).max(1) + inner_width - 1) / inner_width.max(1)).sum()
    };
    let message_height = wrapped(&message);
    let detail_lines: Vec<String> = if detail.is_empty() { vec![] } else { detail.lines().map(|l| widgets::clip(l, inner_width as usize, true)).collect() };
    let menu_height = menu.as_ref().map(|m| m.items.len() as u16).unwrap_or(0);
    let wanted = message_height + if detail_lines.is_empty() { 0 } else { detail_lines.len() as u16 + 1 } + if menu_height > 0 { menu_height + 1 } else { 0 } + 4;
    let height = wanted.min(area.height.saturating_sub(2)).max(5);
    let rect = Rect { x: area.x + (area.width.saturating_sub(width)) / 2, y: area.y + (area.height.saturating_sub(height)) / 2, width, height };
    frame.render_widget(Clear, rect);
    let border = if error { ERR } else { TEAL };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(fg(border))
        .title(Span::styled(format!(" {title} "), bold(if error { ERR } else { CYAN })))
        .padding(ratatui::widgets::Padding::new(2, 2, 1, 1))
        .style(ratatui::style::Style::default().bg(theme::c(theme::SURFACE)).fg(theme::c(TEXT)));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let menu_rows = if menu_height > 0 { menu_height } else { 0 };
    let parts = Split::vertical([Constraint::Min(1), Constraint::Length(if detail_lines.is_empty() { 0 } else { (detail_lines.len() as u16 + 1).min(8) }), Constraint::Length(menu_rows)]).split(inner);
    frame.render_widget(Paragraph::new(message).wrap(Wrap { trim: false }), parts[0]);
    if !detail_lines.is_empty() {
        let lines: Vec<Line> = detail_lines.into_iter().map(|l| Line::from(Span::styled(l, fg(TEXT2)))).collect();
        frame.render_widget(Paragraph::new(lines), Rect { y: parts[1].y + 1, height: parts[1].height.saturating_sub(1), ..parts[1] });
    }
    if let Some(menu) = menu {
        menu.render(frame, parts[2], true, true);
    }
}

pub fn now_stamp() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

pub fn level_tone(level: Level) -> u32 {
    match level {
        Level::Info => TEXT2,
        Level::Success => OK,
        Level::Warning => WARN,
        Level::Error => ERR,
    }
}

pub fn run(context: Context, initial: &str) -> std::io::Result<Outcome> {
    theme::set_depth(context.caps.colors);
    crate::log::silence_console();
    let mut terminal = ratatui::init();
    let _ = crossterm::execute!(std::io::stdout(), crossterm::event::EnableMouseCapture);
    crate::interface::set_terminal_active(true);
    let size = terminal.size().unwrap_or_default();
    let command_bar = crate::config::load(&context.paths).map(|c| crate::config::flag(&c, "launcher.command_bar")).unwrap_or(true);
    let ui = Ui {
        session: context.session.clone(),
        paths: context.paths.clone(),
        caps: context.caps.clone(),
        unicode: context.caps.unicode,
        motion: context.caps.interactive && context.caps.term != "dumb" && !context.args.no_animation,
        layout: layout_for(size.width, size.height),
        width: size.width,
        height: size.height,
        checks: None,
        run_log: VecDeque::new(),
        started: Instant::now(),
        args: context.args.clone(),
    };
    let first: Box<dyn Screen> = if context.args.no_splash || initial == "setup" {
        Box::new(screens::environment::EnvironmentScreen::new(None, initial))
    } else {
        Box::new(screens::splash::SplashScreen::new(initial))
    };
    let mut app = App { ui, screens: vec![first], dialogs: vec![], toasts: vec![], shell: shell::Shell::new(command_bar), outcome: None, quitting: false, help_open: None };
    let result = (|| -> std::io::Result<()> {
        loop {
            terminal.draw(|frame| app.draw(frame))?;
            if event::poll(Duration::from_millis(100))? {
                match event::read()? {
                    Event::Key(key) if key.kind != KeyEventKind::Release => app.on_key(key),
                    Event::Resize(width, height) => {
                        app.ui.width = width;
                        app.ui.height = height;
                        app.ui.layout = layout_for(width, height);
                    }
                    Event::Mouse(mouse) => {
                        if app.dialogs.is_empty() && app.help_open.is_none() {
                            let ui = &mut app.ui;
                            let action = match mouse.kind {
                                MouseEventKind::Down(MouseButton::Left) => app.screens.last_mut().unwrap().click(mouse.column, mouse.row, ui),
                                MouseEventKind::ScrollUp => app.screens.last_mut().unwrap().key(KeyEvent::from(KeyCode::Up), ui),
                                MouseEventKind::ScrollDown => app.screens.last_mut().unwrap().key(KeyEvent::from(KeyCode::Down), ui),
                                _ => Action::None,
                            };
                            app.apply(action);
                        }
                    }
                    _ => {}
                }
            }
            let ui = &mut app.ui;
            let action = app.screens.last_mut().unwrap().tick(ui);
            app.apply(action);
            let action = app.shell.tick(&mut app.ui);
            app.apply(action);
            if app.quitting && app.ui.session.handle().map(|h| !h.running(&app.ui.paths)).unwrap_or(true) {
                app.outcome = Some(Outcome { code: 0, reduced: false });
            }
            if app.outcome.is_some() {
                return Ok(());
            }
        }
    })();
    crate::interface::restore_terminal();
    result?;
    Ok(app.outcome.unwrap_or(Outcome { code: 0, reduced: false }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::Colors;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    /// A checkout of its own, with the real configuration, so nothing here touches the real one.
    fn sandbox() -> Paths {
        let root = std::env::temp_dir().join(format!("dstns-tui-{}-{}", std::process::id(), crate::config::fresh_seed()));
        std::fs::create_dir_all(root.join("config")).unwrap();
        let real = crate::paths::root();
        for file in ["defaults.json", "ui-config.json"] {
            let _ = std::fs::copy(real.join("config").join(file), root.join("config").join(file));
        }
        Paths::new(root)
    }

    fn app(width: u16, height: u16, first: Box<dyn Screen>) -> App {
        let paths = sandbox();
        let caps = Capabilities { interactive: true, width, height, colors: Colors::TrueColor, unicode: true, term: "xterm-256color".into() };
        theme::set_depth(caps.colors);
        let ui = Ui {
            session: Session::new(paths.clone()),
            paths,
            caps,
            args: Arguments::default(),
            unicode: true,
            motion: false,
            layout: layout_for(width, height),
            width,
            height,
            checks: Some(vec![]),
            run_log: VecDeque::new(),
            started: Instant::now(),
        };
        App { ui, screens: vec![first], dialogs: vec![], toasts: vec![], shell: shell::Shell::new(true), outcome: None, quitting: false, help_open: None }
    }

    fn screen(app: &mut App, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| app.draw(frame)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect::<Vec<_>>().join("\n")
    }

    fn press(app: &mut App, code: KeyCode) {
        app.on_key(KeyEvent::from(code));
    }

    fn typed(app: &mut App, text: &str) {
        for ch in text.chars() {
            press(app, KeyCode::Char(ch));
        }
    }

    fn path(app: &App) -> String {
        app.screens.last().unwrap().path()
    }

    #[test]
    fn every_layout_draws_without_overflowing() {
        for (width, height) in [(160, 45), (120, 35), (100, 30), (80, 24), (70, 20), (60, 18), (50, 15)] {
            let mut app = app(width, height, Box::new(screens::dashboard::DashboardScreen::new()));
            let text = screen(&mut app, width, height);
            assert!(text.contains("Start simulation"), "{width}x{height}:\n{text}");
            assert!(text.contains("DSTNS"), "{width}x{height}");
        }
    }

    #[test]
    fn a_terminal_too_small_says_so() {
        let mut app = app(40, 12, Box::new(screens::dashboard::DashboardScreen::new()));
        assert!(screen(&mut app, 40, 12).contains("Terminal too small"));
        press(&mut app, KeyCode::Char('r'));
        assert!(app.outcome.as_ref().map(|o| o.reduced).unwrap_or(false), "R leaves for reduced mode");
    }

    #[test]
    fn the_dashboard_is_driven_by_keyboard() {
        let mut app = app(120, 35, Box::new(screens::dashboard::DashboardScreen::new()));
        screen(&mut app, 120, 35);
        // Configuration is a few down, and Enter opens it.
        for _ in 0..12 {
            if screen(&mut app, 120, 35).contains("> Configuration") {
                break;
            }
            press(&mut app, KeyCode::Down);
        }
        press(&mut app, KeyCode::Enter);
        assert!(path(&app).starts_with("/config"), "{}", path(&app));
        assert!(screen(&mut app, 120, 35).contains("config/defaults.json"));
        press(&mut app, KeyCode::Esc);
        assert_eq!(path(&app), "/");
        press(&mut app, KeyCode::Char('?'));
        assert!(screen(&mut app, 120, 35).contains("Keyboard"));
        press(&mut app, KeyCode::Esc);
        assert!(!screen(&mut app, 120, 35).contains("Esc or ? closes this help."));
    }

    #[test]
    fn every_page_opens_and_draws() {
        for page in ["start", "apps", "seeds", "config", "demo", "logs", "tests", "tools", "about", "setup"] {
            let mut app = app(120, 35, Box::new(screens::dashboard::DashboardScreen::new()));
            let opened = screens::open(page, "", &app.ui).unwrap_or_else(|| panic!("{page} opens"));
            app.apply(Action::Push(opened));
            let text = screen(&mut app, 120, 35);
            assert!(!text.trim().is_empty(), "{page}");
            let ui = &mut app.ui;
            let _ = app.screens.last_mut().unwrap().tick(ui);
            screen(&mut app, 60, 18);
        }
    }

    #[test]
    fn the_command_bar_moves_about_as_a_shell_does() {
        let mut app = app(120, 35, Box::new(screens::dashboard::DashboardScreen::new()));
        press(&mut app, KeyCode::Char(':'));
        assert!(app.shell.open);
        typed(&mut app, "cd apps");
        press(&mut app, KeyCode::Enter);
        assert_eq!(path(&app), "/apps");
        press(&mut app, KeyCode::Char('/'));
        typed(&mut app, "pwd");
        press(&mut app, KeyCode::Enter);
        assert!(screen(&mut app, 120, 35).contains("/apps"));
        typed(&mut app, "ls /");
        press(&mut app, KeyCode::Enter);
        assert!(screen(&mut app, 120, 35).contains("Saved seeds"));
        typed(&mut app, "frobnicate");
        press(&mut app, KeyCode::Enter);
        assert!(screen(&mut app, 120, 35).contains("command not found"));
        typed(&mut app, "cd ..");
        press(&mut app, KeyCode::Enter);
        assert_eq!(path(&app), "/");
    }

    #[test]
    fn the_command_bar_suggests_and_completes() {
        let mut app = app(120, 35, Box::new(screens::dashboard::DashboardScreen::new()));
        press(&mut app, KeyCode::Char(':'));
        typed(&mut app, "fas");
        let text = screen(&mut app, 120, 35);
        assert!(text.contains("fastboot"), "{text}");
        press(&mut app, KeyCode::Tab);
        typed(&mut app, "st");
        press(&mut app, KeyCode::Tab);
        assert!(screen(&mut app, 120, 35).contains("fastboot status"));
    }

    #[test]
    fn the_setup_walks_through_and_remembers() {
        let mut app = app(120, 40, Box::new(screens::dashboard::DashboardScreen::new()));
        std::env::set_var("DSTNS_LAUNCHER_ENV", app.ui.paths.root.join("config").join("launcher.env"));
        let wizard = screens::setup::SetupScreen::new(&app.ui);
        app.apply(Action::Push(Box::new(wizard)));
        assert!(screen(&mut app, 120, 40).contains("Welcome to DSTNS"));
        for _ in 0..6 {
            app.on_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL));
        }
        assert!(screen(&mut app, 120, 40).contains("These are your choices"));
        press(&mut app, KeyCode::Enter);
        assert_eq!(path(&app), "/", "Finish returns to the dashboard");
        assert!(app.ui.paths.root.join("config").join("launcher.env").exists());
        std::env::remove_var("DSTNS_LAUNCHER_ENV");
        std::env::remove_var(crate::setup::ENV);
    }

    #[test]
    fn colour_comes_down_to_none_and_selection_still_shows() {
        let mut app = app(100, 30, Box::new(screens::dashboard::DashboardScreen::new()));
        theme::set_depth(Colors::None);
        let text = screen(&mut app, 100, 30);
        assert!(text.contains("> "), "the selected item carries a marker, not only a colour");
        theme::set_depth(Colors::TrueColor);
    }
}
