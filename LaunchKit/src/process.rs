// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Running external programs. Commands are always argument lists, never shell strings, so a path or a value can never
//! be interpreted by a shell. Each runs in a process group of its own, so that what it starts is stopped with it.

use crate::errors::{Kind, LauncherError, Result};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A flag that can be waited on: set once, by whoever wants an operation to stop.
#[derive(Clone, Default)]
pub struct Cancel(Arc<(Mutex<bool>, Condvar)>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set(&self) {
        let (flag, wake) = &*self.0;
        *flag.lock().unwrap() = true;
        wake.notify_all();
    }
    pub fn is_set(&self) -> bool {
        *self.0 .0.lock().unwrap()
    }
    /// Waits up to `seconds`; returns whether it was set.
    pub fn wait(&self, seconds: f64) -> bool {
        let (flag, wake) = &*self.0;
        let guard = flag.lock().unwrap();
        let (guard, _) = wake.wait_timeout_while(guard, Duration::from_secs_f64(seconds.max(0.0)), |set| !*set).unwrap();
        *guard
    }
    pub fn check(&self) -> Result<()> {
        if self.is_set() {
            Err(LauncherError::cancelled())
        } else {
            Ok(())
        }
    }
}

/// Stop a process group: SIGTERM, a moment's grace, then SIGKILL, since a descendant can outlive its parent while
/// holding the output pipe open.
pub fn terminate(child: &mut Child, grace: f64) {
    let group = child.id() as i32;
    unsafe {
        libc::killpg(group, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs_f64(grace);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        libc::killpg(group, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub struct Output {
    pub code: i32,
    pub output: String,
    pub seconds: f64,
    pub timed_out: bool,
}

pub struct Run<'a> {
    pub command: Vec<String>,
    pub cwd: Option<&'a Path>,
    pub env: Vec<(String, String)>,
    pub timeout: Option<f64>,
    pub check: bool,
    pub keep: usize,
    pub cancel: Option<&'a Cancel>,
}

impl<'a> Run<'a> {
    pub fn new(command: Vec<String>) -> Self {
        Self { command, cwd: None, env: vec![], timeout: None, check: true, keep: 400, cancel: None }
    }
    pub fn cwd(mut self, cwd: &'a Path) -> Self {
        self.cwd = Some(cwd);
        self
    }
    pub fn timeout(mut self, seconds: f64) -> Self {
        self.timeout = Some(seconds);
        self
    }
    pub fn unchecked(mut self) -> Self {
        self.check = false;
        self
    }
    pub fn cancel(mut self, cancel: &'a Cancel) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// Run it, streaming each non-empty output line to `on_line`. The last `keep` lines are returned. With `check`, a
    /// non-zero exit is an error carrying that output.
    pub fn run(self, mut on_line: impl FnMut(&str)) -> Result<Output> {
        if let Some(cancel) = self.cancel {
            cancel.check()?;
        }
        crate::log::debug(&format!("run: {} (cwd={:?})", self.command.join(" "), self.cwd));
        let started = Instant::now();
        let mut command = Command::new(&self.command[0]);
        command.args(&self.command[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
        if let Some(cwd) = self.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &self.env {
            command.env(key, value);
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                let name = Path::new(&self.command[0]).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                LauncherError::dependency(format!("{} was not found.", self.command[0])).remedy(format!("Install {name} and make sure it is on PATH."))
            } else {
                LauncherError::generic(format!("{} could not be started: {error}", self.command[0]))
            }
        })?;
        // Both streams into one, in the order lines arrive.
        let (sender, receiver) = std::sync::mpsc::channel::<String>();
        let mut readers = vec![];
        for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)]
            .into_iter()
            .flatten()
        {
            let sender = sender.clone();
            readers.push(thread::spawn(move || {
                for line in BufReader::new(stream).split(b'\n').map_while(|l| l.ok()) {
                    let _ = sender.send(String::from_utf8_lossy(&line).trim_end_matches('\r').to_string());
                }
            }));
        }
        drop(sender);
        let mut tail: VecDeque<String> = VecDeque::new();
        let mut timed_out = false;
        let mut cancelled = false;
        loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    if !line.trim().is_empty() {
                        on_line(&line);
                    }
                    tail.push_back(line);
                    if tail.len() > self.keep {
                        tail.pop_front();
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if self.timeout.map(|t| started.elapsed().as_secs_f64() > t).unwrap_or(false) {
                timed_out = true;
                terminate(&mut child, 1.5);
                break;
            }
            if self.cancel.map(|c| c.is_set()).unwrap_or(false) {
                cancelled = true;
                terminate(&mut child, 1.5);
                break;
            }
        }
        let status = child.wait().ok();
        for reader in readers {
            let _ = reader.join();
        }
        while let Ok(line) = receiver.try_recv() {
            tail.push_back(line);
        }
        if cancelled {
            return Err(LauncherError::cancelled());
        }
        let code = if timed_out { 124 } else { status.and_then(|s| s.code()).unwrap_or(-1) };
        let output = tail.into_iter().collect::<Vec<_>>().join("\n");
        if self.check && code != 0 {
            let shown: Vec<&str> = self.command.iter().take(3).map(|s| s.as_str()).collect();
            return Err(LauncherError::new(Kind::CommandFailed(code), format!("{} exited with status {code}.", shown.join(" "))).detail(output));
        }
        Ok(Output { code, output, seconds: started.elapsed().as_secs_f64(), timed_out })
    }
}

/// A quick command whose whole output is wanted: (exit status, output, seconds). 127 when it does not exist.
pub fn capture(command: &[&str], cwd: Option<&Path>, timeout: f64, env: &[(&str, &str)]) -> (i32, String, f64) {
    let started = Instant::now();
    let mut run = Run::new(command.iter().map(|s| s.to_string()).collect()).unchecked().timeout(timeout);
    run.env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    if let Some(cwd) = cwd {
        run = run.cwd(cwd);
    }
    match run.run(|_| {}) {
        Ok(out) => {
            let code = if out.timed_out { -1 } else { out.code };
            (code, if out.timed_out { "timed out".into() } else { out.output }, out.seconds)
        }
        Err(error) if matches!(error.kind, Kind::Dependency) => (127, format!("{} not found", command[0]), started.elapsed().as_secs_f64()),
        Err(error) => (126, error.message, started.elapsed().as_secs_f64()),
    }
}

pub fn tail_text(text: &str, lines: usize) -> String {
    let kept: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    kept[kept.len().saturating_sub(lines)..].join("\n")
}

/// Whether a program is on PATH.
pub fn which(name: &str) -> Option<std::path::PathBuf> {
    if name.contains('/') {
        let path = std::path::PathBuf::from(name);
        return path.exists().then_some(path);
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|dir| dir.join(name)).find(|candidate| {
            use std::os::unix::fs::PermissionsExt;
            candidate.is_file() && candidate.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_streamed_and_kept() {
        let mut seen = vec![];
        let out = Run::new(vec!["sh".into(), "-c".into(), "echo one; echo two >&2; echo three".into()]).run(|l| seen.push(l.to_string())).unwrap();
        assert_eq!(out.code, 0);
        assert_eq!(seen.len(), 3);
        assert!(out.output.contains("three"));
    }

    #[test]
    fn a_failing_command_is_an_error_with_its_output() {
        let error = Run::new(vec!["sh".into(), "-c".into(), "echo broken; exit 3".into()]).run(|_| {}).err().unwrap();
        assert_eq!(error.kind, Kind::CommandFailed(3));
        assert!(error.detail.contains("broken"));
    }

    #[test]
    fn cancelling_stops_the_whole_group() {
        let cancel = Cancel::new();
        let stopper = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            stopper.set();
        });
        let started = Instant::now();
        let result = Run::new(vec!["sh".into(), "-c".into(), "sleep 30 & sleep 30".into()]).cancel(&cancel).run(|_| {});
        assert!(result.err().unwrap().is_cancelled());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_missing_program_says_so() {
        let (code, _, _) = capture(&["dstns-no-such-program"], None, 5.0, &[]);
        assert_eq!(code, 127);
    }
}
