// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Launcher errors.
//!
//! Each carries an optional `remedy`: what the operator can do about it. The interfaces show the message and the
//! remedy, never a bare code.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// A configuration file or a run option is invalid.
    Configuration,
    /// A required program or package is missing.
    Dependency,
    /// The server or the run could not be started.
    SimulationStart,
    /// A running server or run failed.
    SimulationRuntime,
    /// The operator cancelled an operation before it completed.
    Cancelled,
    /// An external command exited with a non-zero status.
    CommandFailed(i32),
    /// An application the simulation needs did not become ready.
    AppStart,
}

#[derive(Debug, Clone)]
pub struct LauncherError {
    pub kind: Kind,
    pub message: String,
    pub remedy: String,
    pub detail: String,
}

pub type Result<T> = std::result::Result<T, LauncherError>;

impl LauncherError {
    pub fn new(kind: Kind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), remedy: String::new(), detail: String::new() }
    }
    pub fn config(message: impl Into<String>) -> Self {
        Self::new(Kind::Configuration, message)
    }
    pub fn start(message: impl Into<String>) -> Self {
        Self::new(Kind::SimulationStart, message)
    }
    pub fn runtime(message: impl Into<String>) -> Self {
        Self::new(Kind::SimulationRuntime, message)
    }
    pub fn dependency(message: impl Into<String>) -> Self {
        Self::new(Kind::Dependency, message)
    }
    pub fn cancelled() -> Self {
        Self::new(Kind::Cancelled, "Start-up was cancelled.")
    }
    pub fn generic(message: impl Into<String>) -> Self {
        Self::new(Kind::SimulationRuntime, message)
    }
    pub fn remedy(mut self, remedy: impl Into<String>) -> Self {
        self.remedy = remedy.into();
        self
    }
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }
    pub fn is_cancelled(&self) -> bool {
        self.kind == Kind::Cancelled
    }
}

impl fmt::Display for LauncherError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LauncherError {}

impl From<std::io::Error> for LauncherError {
    fn from(error: std::io::Error) -> Self {
        Self::generic(error.to_string())
    }
}
