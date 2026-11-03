// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! What the launcher is made of: modules, each adding commands and dashboard pages to it. A module says what it adds,
//! and the command line, its help, the dashboard and the command bar are built from that, so adding to the launcher
//! means adding a module rather than changing them.

pub mod apps;
pub mod demo;
pub mod fabric;
pub mod fastboot;
pub mod mcp;

use crate::cli::Context;
use crate::errors::{LauncherError, Result};

pub struct Command {
    pub name: &'static str,
    pub usage: &'static str,
    pub summary: &'static str,
    pub run: fn(&Context) -> Result<i32>,
}

/// An entry on the dashboard, and the screen it opens.
pub struct Page {
    pub key: &'static str,
    pub label: &'static str,
    /// Where it goes in the menu: before the entry with this key.
    pub before: &'static str,
}

pub struct Module {
    pub commands: Vec<Command>,
    pub pages: Vec<Page>,
}

pub fn modules() -> Vec<Module> {
    vec![apps::module(), fabric::module(), fastboot::module(), demo::module(), mcp::module()]
}

pub fn find(name: &str) -> Option<Command> {
    modules().into_iter().flat_map(|m| m.commands).find(|c| c.name == name)
}

pub fn pages() -> Vec<Page> {
    modules().into_iter().flat_map(|m| m.pages).collect()
}

pub fn help_lines() -> Vec<String> {
    let mut lines = vec![];
    for module in modules() {
        for command in module.commands {
            lines.push(format!("  {}", command.usage));
            lines.push(format!("                         {}", command.summary));
        }
    }
    lines
}

/// A module command's own arguments: positionals, and options with or without values, as argparse reads them.
pub struct Options {
    pub positional: Vec<String>,
    pub values: Vec<(String, String)>,
    pub flags: Vec<String>,
}

impl Options {
    /// `with_value` names the options that take a value, `switches` those that do not.
    pub fn parse(arguments: &[String], with_value: &[&str], switches: &[&str]) -> Result<Self> {
        let mut out = Options { positional: vec![], values: vec![], flags: vec![] };
        let mut index = 0;
        while index < arguments.len() {
            let arg = &arguments[index];
            if let Some((key, value)) = arg.split_once('=').filter(|(k, _)| k.starts_with("--") && with_value.contains(k)) {
                out.values.push((key.to_string(), value.to_string()));
            } else if with_value.contains(&arg.as_str()) {
                index += 1;
                let value = arguments.get(index).ok_or_else(|| LauncherError::config(format!("{arg} needs a value")))?;
                out.values.push((arg.clone(), value.clone()));
            } else if switches.contains(&arg.as_str()) {
                out.flags.push(arg.clone());
            } else if arg.starts_with('-') && arg.len() > 1 && arg.parse::<f64>().is_err() {
                return Err(LauncherError::config(format!("Unknown option: {arg}")).remedy("Add --help to see what it takes."));
            } else {
                out.positional.push(arg.clone());
            }
            index += 1;
        }
        Ok(out)
    }
    pub fn value(&self, key: &str) -> Option<String> {
        self.values.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }
    pub fn all(&self, key: &str) -> Vec<String> {
        self.values.iter().filter(|(k, _)| k == key).map(|(_, v)| v.clone()).collect()
    }
    pub fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }
}

/// The port of a server that is running, or why there is none.
pub fn port(context: &Context) -> Result<u16> {
    crate::server::active_port(&context.paths).ok_or_else(|| LauncherError::generic("No server is running.").remedy("Start one with ./launcher start, then try again."))
}
